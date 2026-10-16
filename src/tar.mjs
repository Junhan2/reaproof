import { gunzipSync } from 'node:zlib';
import { lazyBytes, textBeforeZero } from './bytes.mjs';
import { listFolder, startFolders } from './folders.mjs';

// Layout from POSIX's pax and ustar formats and GNU tar's additions to them: each file is a
// header of 512 bytes followed by its bytes, padded to 512, and two empty headers end the
// archive. A `.tar.gz` or `.tgz` is such an archive compressed whole with gzip. Nothing here
// writes to disk.

const BLOCK_BYTES = 512;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
// A header is told by its checksum, as tar itself tells one: the sum of its bytes, its own
// field counted as spaces, which some old tars summed as signed bytes.
const CHECKSUM_AT = 148;
const CHECKSUM_BYTES = 8;
// POSIX ends its magic with a zero; GNU's own format writes two spaces there, and keeps other
// fields where POSIX keeps the prefix of a long path.
const MAGIC_AT = 257;
const POSIX_MAGIC = Buffer.from('ustar\0', 'latin1');
const NAME_BYTES = 100;
const SIZE_AT = 124;
const SIZE_BYTES = 12;
const TYPE_AT = 156;
const PREFIX_AT = 345;
const PREFIX_BYTES = 155;
// What a header can be: a file, a folder, a link, or a record that says more about the next
// header (its long name or its size).
const FILE_TYPES = new Set(['0', '\0', '7']);
const DIRECTORY_TYPE = '5';
const PAX_NEXT = 'x';
const PAX_GLOBAL = 'g';
const GNU_LONG_NAME = 'L';
// A sparse file from GNU tar may have more headers, each saying whether another follows.
const GNU_SPARSE = 'S';
const SPARSE_EXTENDED_AT = 482;
const SPARSE_HEADER_EXTENDED_AT = 504;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_ENTRIES = 250_000;
// As much as a ZIP's central directory may hold: each name is split into folders.
const MAX_NAME_BYTES = 64 * 1024 * 1024;
// A whole archive compressed with gzip is unpacked into memory to be read. It may not come out
// larger than a file inside an archive may be (MAX_HELD_BYTES in scan.mjs).
const MAX_GUNZIPPED_BYTES = 512 * 1024 * 1024;
// Deflate packs at most 1,032 bytes into one. It never makes anything smaller than it was by
// more than its framing, so a file larger than what may come out of it is not unpacked.
const MAX_DEFLATE_RATIO = 1032;
const MIN_CHUNK_BYTES = 16 * 1024;

/** Whether a file is named like a tar archive, compressed or not. */
export function isTarName(name) {
  return /\.(?:tar|tgz|tar\.gz)$/i.test(name);
}

/**
 * Opens a tar archive, compressed with gzip or not, for reading. What it says about itself is
 * checked against the bytes that are there.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 * @param {{ left: number }} [budget] what may still be read out of the archive this one sits in,
 *   which what gzip unpacks counts against
 * @returns {{ root: object, list(directory: object): object[], read(file: object): Buffer }}
 * @throws when the bytes are not a tar archive this reader can list
 */
export function openTar(source, budget = { left: Infinity }) {
  const isCompressed = source.byteLength >= GZIP_MAGIC.length && source.read(0, GZIP_MAGIC.length).equals(GZIP_MAGIC);
  const tar = isCompressed ? gunzipWithin(source, budget) : source;
  if (!isHeader(tar.read(0, BLOCK_BYTES))) throw new Error('not a tar archive');

  const folders = startFolders();
  let entryCount = 0;
  let nameBytes = 0;
  // What pax records and GNU long names said of the header that comes next.
  let pending = {};
  for (let at = 0; at + BLOCK_BYTES <= tar.byteLength; ) {
    const header = tar.read(at, BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    if (!isHeader(header)) throw new Error('a header that is not one');
    entryCount += 1;
    if (entryCount > MAX_ENTRIES) throw new Error('the archive lists implausibly many files');
    const type = String.fromCharCode(header[TYPE_AT]);
    const size = pending.size ?? readSize(header);
    let dataAt = at + BLOCK_BYTES;
    let isExtended = type === GNU_SPARSE && header[SPARSE_EXTENDED_AT] !== 0;
    while (isExtended) {
      isExtended = tar.read(dataAt, BLOCK_BYTES)[SPARSE_HEADER_EXTENDED_AT] !== 0;
      dataAt += BLOCK_BYTES;
    }
    if (dataAt + size > tar.byteLength) throw new Error('a file reaches past the end of the archive');
    at = dataAt + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;

    if (type === PAX_NEXT || type === GNU_LONG_NAME) {
      if (size > MAX_RECORD_BYTES) throw new Error('an implausibly long record');
      const record = tar.read(dataAt, size);
      if (type === GNU_LONG_NAME) pending.name = textBeforeZero(record, 'utf8');
      else Object.assign(pending, readPaxRecords(record));
      continue;
    }
    const name = pending.name ?? headerName(header);
    pending = {};
    nameBytes += name.length;
    if (nameBytes > MAX_NAME_BYTES) throw new Error('the archive names implausibly long paths');
    if (type === PAX_GLOBAL) continue;
    const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) continue;
    // Before POSIX, a folder was a file whose name ends with a slash.
    if (type === DIRECTORY_TYPE || name.endsWith('/')) folders.addFolder(segments);
    // A link has no bytes of its own, and neither has a device.
    else if (FILE_TYPES.has(type)) folders.addFile(segments, { size, dataAt });
  }

  return { root: folders.root, list: listFolder, read: (file) => tar.read(file.dataAt, file.size) };
}

/**
 * The bytes of a tar compressed with gzip. What comes out counts against what may still be
 * read out of the archive it sits in, since each archive in another may unpack to hundreds of
 * times what it weighs; one that fails is taken to have got as far as it could. gzip ends with
 * the size it unpacks to, modulo 2^32: given room for all of it at once, zlib fills one buffer,
 * where gathered in pieces the output is held twice while they are joined.
 */
function gunzipWithin(source, budget) {
  // Blocks gzip stores as they are add a little framing, hence the margin.
  if (source.byteLength > MAX_GUNZIPPED_BYTES * 1.001) throw new Error('an archive too large to unpack');
  const most = Math.max(1, Math.min(MAX_GUNZIPPED_BYTES, budget.left, source.byteLength * MAX_DEFLATE_RATIO));
  const stated = source.byteLength >= 4 ? source.read(source.byteLength - 4, 4).readUInt32LE(0) : 0;
  const chunkSize = stated < most ? Math.max(MIN_CHUNK_BYTES, stated + 1) : MIN_CHUNK_BYTES;
  let unpacked = null;
  try {
    unpacked = gunzipSync(source.read(0, source.byteLength), { maxOutputLength: most, chunkSize });
    return lazyBytes(unpacked.length, () => unpacked);
  } finally {
    budget.left -= unpacked ? unpacked.length : most;
  }
}

/** A size in octal digits, or, from GNU tar, a number in base 256 when the first bit is set. */
function readSize(header) {
  const field = header.subarray(SIZE_AT, SIZE_AT + SIZE_BYTES);
  if (field[0] & 0x80) return field.subarray(1).reduce((size, byte) => size * 256 + byte, 0);
  const digits = textBeforeZero(field, 'latin1').trim();
  if (!/^[0-7]*$/.test(digits)) throw new Error('a size that is not a number');
  return digits === '' ? 0 : Number.parseInt(digits, 8);
}

function headerName(header) {
  const name = textBeforeZero(header.subarray(0, NAME_BYTES), 'utf8');
  const isPosix = header.subarray(MAGIC_AT, MAGIC_AT + POSIX_MAGIC.length).equals(POSIX_MAGIC);
  const prefix = isPosix ? textBeforeZero(header.subarray(PREFIX_AT, PREFIX_AT + PREFIX_BYTES), 'utf8') : '';
  return prefix ? `${prefix}/${name}` : name;
}

function isHeader(header) {
  const digits = textBeforeZero(header.subarray(CHECKSUM_AT, CHECKSUM_AT + CHECKSUM_BYTES), 'latin1').trim();
  if (!/^[0-7]+$/.test(digits)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let at = 0; at < header.length; at += 1) {
    const counted = at >= CHECKSUM_AT && at < CHECKSUM_AT + CHECKSUM_BYTES ? 0x20 : header[at];
    unsigned += counted;
    signed += counted > 0x7f ? counted - 0x100 : counted;
  }
  return [unsigned, signed].includes(Number.parseInt(digits, 8));
}

/** The path and size a pax record gives the next file: lines of "length key=value". */
function readPaxRecords(record) {
  const found = {};
  for (let at = 0; at < record.length; ) {
    const space = record.indexOf(0x20, at);
    const length = Number.parseInt(record.toString('latin1', at, space), 10);
    if (space === -1 || !(length > 0)) break;
    const line = record.toString('utf8', space + 1, at + length - 1);
    const equals = line.indexOf('=');
    const [key, value] = [line.slice(0, equals), line.slice(equals + 1)];
    if (key === 'path') found.name = value;
    else if (key === 'size' && /^\d+$/.test(value)) found.size = Number(value);
    at += length;
  }
  return found;
}
