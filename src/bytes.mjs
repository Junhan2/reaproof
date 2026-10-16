import { fstatSync, readSync } from 'node:fs';

/**
 * Bytes that can be read at any position, wherever they are, so that what reads a file
 * does not care whether it sits on disk or inside an archive.
 *
 * @typedef {{ byteLength: number, read(position: number, length: number): Buffer }} ByteSource
 */

/** Reads exactly `length` bytes at `position`; a file that ends sooner is not what the caller took it for. */
function readAt(fd, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('unexpected end of file');
  return buffer;
}

/** @returns {ByteSource} the bytes of an open file */
export function fileBytes(fd) {
  const byteLength = fstatSync(fd).size;
  return {
    byteLength,
    read(position, length) {
      // Refused before memory is set aside for it: an archive states sizes of its own.
      if (position + length > byteLength) throw new Error('unexpected end of file');
      return readAt(fd, position, length);
    },
  };
}

/**
 * @param {() => Buffer} load fetches all of them, the first time any is read
 * @returns {ByteSource} bytes that are held in memory once read, such as a file inside an archive
 */
export function lazyBytes(byteLength, load) {
  let buffer;
  return {
    byteLength,
    read(position, length) {
      if (!buffer) {
        const loaded = load();
        // Whoever reads goes by the length that was stated, so what was fetched has to have it.
        if (loaded.length !== byteLength) throw new Error('not as many bytes as stated');
        buffer = loaded;
      }
      if (position + length > buffer.length) throw new Error('unexpected end of file');
      return buffer.subarray(position, position + length);
    },
  };
}

/**
 * Goes through a source from start to end in chunks, each running `overlapBytes` into the
 * next: whatever is no longer than the overlap is whole in at least one chunk.
 *
 * @param {ByteSource} source
 * @returns {Generator<{ position: number, bytes: Buffer }>}
 */
export function* readChunks(source, chunkBytes, overlapBytes) {
  for (let position = 0; position < source.byteLength; position += chunkBytes) {
    const length = Math.min(chunkBytes + overlapBytes, source.byteLength - position);
    yield { position, bytes: source.read(position, length) };
  }
}

const RECORDS_PER_READ = 65536;

/**
 * A table of records of one size, a block of them at a time, so that a table of millions is
 * never held whole.
 *
 * @param {(position: number, length: number) => Buffer} read
 * @returns {Generator<Buffer>}
 */
export function* readRecords(read, offset, count, recordBytes) {
  for (let first = 0; first < count; first += RECORDS_PER_READ) {
    yield read(offset + first * recordBytes, Math.min(RECORDS_PER_READ, count - first) * recordBytes);
  }
}

/** @returns {string} the text up to the first zero byte, or all of it when there is none */
export function textBeforeZero(bytes, encoding) {
  const end = bytes.indexOf(0);
  return bytes.toString(encoding, 0, end === -1 ? bytes.length : end);
}

/**
 * Bytes read two to a character. Only whole pairs are decoded, which is what Node does with
 * a byte left over anyway. Node 24.21.0 on Linux and Windows corrupts its own memory when
 * it decodes an odd number of bytes that start at an odd place in their buffer, and the
 * reading that starts on the second byte of a stretch starts at just such a place.
 */
export function utf16Text(bytes) {
  return bytes.subarray(0, bytes.length - (bytes.length % 2)).toString('utf16le');
}

/**
 * An unsigned LEB128 number, the varint of Go, WebAssembly and protobuf: seven bits to a
 * byte, the lowest first, for as long as the top bit is set.
 *
 * @param {number} [mostBytes] five hold any 32-bit number; protobuf writes up to ten
 * @returns {[number, number]} the number and how many bytes it took
 * @throws when it runs on past `mostBytes` or past the end
 */
export function readVarint(bytes, at, mostBytes = 5) {
  let value = 0;
  for (let used = 0; used < mostBytes && at + used < bytes.length; used += 1) {
    const byte = bytes[at + used];
    value += (byte & 0x7f) * 2 ** (7 * used);
    if (byte < 0x80) return [value, used + 1];
  }
  throw new Error('not a varint');
}

/** @returns what `read` returns, or null when what it reads does not hold what it should */
export function unlessMalformed(read) {
  try {
    return read();
  } catch {
    return null;
  }
}
