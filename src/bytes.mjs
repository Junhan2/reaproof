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
