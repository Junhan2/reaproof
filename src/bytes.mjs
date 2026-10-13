import { readSync } from 'node:fs';

/** Reads exactly `length` bytes at `position`; a file that ends sooner is not what the caller took it for. */
export function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('unexpected end of file');
  return buffer;
}
