import { inflateRawSync } from 'node:zlib';
import { listFolder, startFolders } from './folders.mjs';

// Layouts are those of PKWARE's APPNOTE.TXT (6.3.10), the specification of the ZIP format,
// which `.ipa`, `.apk`, `.aab`, `.jar`, `.msix` and many other files are written in. Numbers
// are little-endian. A reader starts at the end: the last record says where the central
// directory is, and the central directory lists every file in the archive.
const END_RECORD = 0x06054b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_RECORD = 0x06064b50;
const ZIP64_END_RECORD_BYTES = 56;
const DIRECTORY_ENTRY = 0x02014b50;
const DIRECTORY_ENTRY_BYTES = 46;
const LOCAL_HEADER = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
// A field too small for its value holds all ones, and the value is in the ZIP64 extra field.
const SEE_ZIP64 = 0xffffffff;
const SEE_ZIP64_COUNT = 0xffff;
const ZIP64_EXTRA_FIELD = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x1;
// "Version made by" names the system whose file attributes an entry carries. On UNIX the
// upper half of the attributes is the file mode, which tells a symbolic link from a file.
const UNIX = 3;
const FILE_KIND_MASK = 0o170000;
const SYMBOLIC_LINK = 0o120000;

const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
// Deflate at its worst makes data an eighth larger than it was, and a few bytes more to
// open and close. Twice that is allowed for: an entry that says its packed form is larger
// still is not telling the truth about one of its two sizes.
const MAX_PACKED_GROWTH = 1 / 4;
const MAX_PACKED_FRAME_BYTES = 64;
// The smallest output buffer zlib takes.
const MIN_INFLATE_CHUNK_BYTES = 64;

/**
 * @typedef {{ path: string, name: string, isDirectory: false, size: number, packedBytes: number,
 *   headerOffset: number, method: number, isEncrypted: boolean }} ZipFile
 * @typedef {{ path: string, name: string, isDirectory: true, directories: Map<string, ZipDirectory>,
 *   files: ZipFile[] }} ZipDirectory
 */

/**
 * Whether a file opens the way a ZIP archive does: with its first file, or with the end
 * record of an archive that holds none. A ZIP is told by this and not by what it is called.
 *
 * @param {Buffer} opening the first four bytes or fewer
 */
export function isZip(opening) {
  if (opening.length < 4) return false;
  const signature = opening.readUInt32LE(0);
  return signature === LOCAL_HEADER || signature === END_RECORD;
}

/**
 * Opens a ZIP archive for reading without unpacking it to disk.
 *
 * What the archive says about itself is not trusted: every offset is checked against the
 * bytes that are there, and an entry is never allowed to come out larger than it states.
 * How much is read out of one archive in all is for the caller to bound: the entries may
 * state far more together than the archive weighs.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 * @returns {{ root: ZipDirectory, list(directory: ZipDirectory): (ZipFile | ZipDirectory)[],
 *   read(file: ZipFile): Buffer, directoryOffset: number }} `read` gives what an entry holds.
 *   One that holds more than it states is refused, and one that ends sooner comes back
 *   shorter. `directoryOffset` is where the central directory starts, which an Android app
 *   package's signature ends right before
 * @throws when the bytes are not a ZIP archive this reader can list
 */
export function openZip(source) {
  const { directoryOffset, directoryBytes, entryCount } = readEndRecord(source);
  const directory = source.read(directoryOffset, directoryBytes);
  const folders = startFolders();

  for (let index = 0, position = 0; index < entryCount; index += 1) {
    if (position + DIRECTORY_ENTRY_BYTES > directory.length || directory.readUInt32LE(position) !== DIRECTORY_ENTRY) {
      throw new Error('the central directory does not hold the entries it counts');
    }
    const nameStart = position + DIRECTORY_ENTRY_BYTES;
    const extraStart = nameStart + directory.readUInt16LE(position + 28);
    const commentStart = extraStart + directory.readUInt16LE(position + 30);
    const entry = {
      size: directory.readUInt32LE(position + 24),
      packedBytes: directory.readUInt32LE(position + 20),
      headerOffset: directory.readUInt32LE(position + 42),
      method: directory.readUInt16LE(position + 10),
      isEncrypted: Boolean(directory.readUInt16LE(position + 8) & ENCRYPTED),
    };
    const madeOn = directory[position + 5];
    const fileMode = directory.readUInt32LE(position + 38) >>> 16;
    position = commentStart + directory.readUInt16LE(position + 32);
    if (position > directory.length) throw new Error('an entry reaches past the central directory');

    readZip64Sizes(entry, directory.subarray(extraStart, commentStart));
    // A symbolic link has no bytes of its own to read.
    if (madeOn === UNIX && (fileMode & FILE_KIND_MASK) === SYMBOLIC_LINK) continue;
    const name = decodeName(directory.subarray(nameStart, extraStart));
    // Some writers on Windows separate folders with a backslash.
    const segments = name.replaceAll('\\', '/').split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) continue;

    if (name.endsWith('/')) folders.addFolder(segments);
    else folders.addFile(segments, entry);
  }

  return {
    root: folders.root,
    list: listFolder,
    read: (file) => readEntry(source, file),
    directoryOffset,
  };
}

/** @returns {{ directoryOffset: number, directoryBytes: number, entryCount: number }} */
function readEndRecord(source) {
  const tailBytes = Math.min(source.byteLength, END_RECORD_BYTES + MAX_COMMENT_BYTES);
  const tailStart = source.byteLength - tailBytes;
  const tail = source.read(tailStart, tailBytes);
  // The record is the last thing in the file but for a comment, whose length it states.
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(END_RECORD);
  let at = tail.lastIndexOf(signature, tail.length - END_RECORD_BYTES);
  while (at !== -1 && at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) > tail.length) {
    at = at === 0 ? -1 : tail.lastIndexOf(signature, at - 1);
  }
  if (at === -1) throw new Error('no end of central directory record');

  const recordPosition = tailStart + at;
  let entryCount = tail.readUInt16LE(at + 10);
  let directoryBytes = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  if (entryCount === SEE_ZIP64_COUNT || directoryBytes === SEE_ZIP64 || directoryOffset === SEE_ZIP64) {
    const locator = source.read(recordPosition - ZIP64_LOCATOR_BYTES, ZIP64_LOCATOR_BYTES);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw new Error('no ZIP64 locator before the end record');
    const record = source.read(Number(locator.readBigUInt64LE(8)), ZIP64_END_RECORD_BYTES);
    if (record.readUInt32LE(0) !== ZIP64_END_RECORD) throw new Error('no ZIP64 end record where the locator points');
    entryCount = Number(record.readBigUInt64LE(32));
    directoryBytes = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }
  if (entryCount > MAX_ENTRIES || directoryBytes > MAX_DIRECTORY_BYTES) {
    throw new Error('the archive lists implausibly many entries');
  }
  if (directoryOffset + directoryBytes > recordPosition) throw new Error('the central directory runs into its end record');
  return { directoryOffset, directoryBytes, entryCount };
}

/**
 * Replaces the sizes and the offset that did not fit their four bytes with the ones the
 * ZIP64 extra field carries, which holds them in a fixed order, each only when needed.
 */
function readZip64Sizes(entry, extra) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const fieldBytes = extra.readUInt16LE(at + 2);
    if (extra.readUInt16LE(at) === ZIP64_EXTRA_FIELD) {
      let valueAt = at + 4;
      for (const field of ['size', 'packedBytes', 'headerOffset']) {
        if (entry[field] !== SEE_ZIP64) continue;
        entry[field] = Number(extra.readBigUInt64LE(valueAt));
        valueAt += 8;
      }
      return;
    }
    at += 4 + fieldBytes;
  }
}

/**
 * Names are UTF-8 in archives written today, flagged as such or not. One that is not valid
 * UTF-8 comes from an older writer and is read a byte to a character, which is enough to show it.
 */
function decodeName(bytes) {
  const name = bytes.toString('utf8');
  return name.includes('�') ? bytes.toString('latin1') : name;
}

/** @throws when the entry is locked, packed in a way that is not undone, or not where the directory says */
function readEntry(source, file) {
  if (file.isEncrypted) throw new Error('the entry is encrypted');
  if (file.method !== STORED && file.method !== DEFLATED) throw new Error(`compression method ${file.method} is not read`);
  const packedLimit =
    file.method === STORED ? file.size : file.size + Math.ceil(file.size * MAX_PACKED_GROWTH) + MAX_PACKED_FRAME_BYTES;
  if (file.packedBytes > packedLimit) throw new Error('an entry is packed larger than it can be');

  const header = source.read(file.headerOffset, LOCAL_HEADER_BYTES);
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error('no local file header where the directory points');
  // The name and the extra field are stated again here, and need not be as long as in the directory.
  const dataStart = file.headerOffset + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
  const packed = source.read(dataStart, file.packedBytes);
  if (file.method === STORED || file.size === 0) return packed.subarray(0, file.size);
  // Inflating stops with an error where the output would pass the size the entry states.
  // It is given room for all of it at once: gathered in small pieces, the output would be
  // held twice over while the pieces are joined. One byte more than that keeps zlib, which
  // sets aside another piece whenever one is full, from setting aside a second whole one.
  const chunkSize = Math.max(file.size + 1, MIN_INFLATE_CHUNK_BYTES);
  return inflateRawSync(packed, { maxOutputLength: file.size, chunkSize });
}
