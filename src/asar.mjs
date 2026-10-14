const SIZE_PICKLE_BYTES = 8;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {{ path: string, name: string, isDirectory: false, size: number, offset: number }} AsarFile
 * @typedef {{ path: string, name: string, isDirectory: true, node: object }} AsarDirectory
 *   `node` is the directory's own part of the header, kept for `list`
 */

/**
 * Opens an Electron ASAR archive for reading without unpacking it.
 *
 * Layout (electron/asar README): | UInt32: header_size | String: header | Bytes: file1 | ... |
 * Both leading fields are Chromium Pickle objects: a UInt32 payload length, then the payload.
 * File offsets in the header are decimal strings counted from the end of the header.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 * @returns {{
 *   root: AsarDirectory,
 *   fileCount: number,
 *   list(directory: AsarDirectory): (AsarFile | AsarDirectory)[],
 *   read(file: AsarFile): Buffer,
 * }}
 * @throws when the bytes are not an archive this reader can list
 */
export function openAsar(source) {
  const headerPickleBytes = source.read(0, SIZE_PICKLE_BYTES).readUInt32LE(4);
  const isPlausibleHeader =
    headerPickleBytes >= 8 &&
    headerPickleBytes <= MAX_HEADER_BYTES &&
    SIZE_PICKLE_BYTES + headerPickleBytes <= source.byteLength;
  if (!isPlausibleHeader) throw new Error('not a readable ASAR archive');

  const headerPickle = source.read(SIZE_PICKLE_BYTES, headerPickleBytes);
  const jsonBytes = headerPickle.readUInt32LE(4);
  const header = JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonBytes));
  const dataStart = SIZE_PICKLE_BYTES + headerPickleBytes;

  const root = { path: '', name: '', isDirectory: true, node: header };
  return {
    root,
    // Counting goes through the whole header, so a malformed one fails here, before a caller reports anything.
    fileCount: countFiles(root),
    list: listEntries,
    read: (file) => source.read(dataStart + file.offset, file.size),
  };
}

/** What sits directly inside one directory, of the things stored in the archive itself. */
function listEntries({ path: directoryPath, node }) {
  const entries = [];
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = directoryPath ? `${directoryPath}/${name}` : name;
    if (entry.files) entries.push({ path, name, isDirectory: true, node: entry });
    // Symlinks have no bytes; unpacked entries live next to the archive, not in it.
    else if (entry.link === undefined && !entry.unpacked) {
      const file = { path, name, isDirectory: false, size: entry.size, offset: Number(entry.offset) };
      // The header is text someone wrote: a size or a place that is not a count of bytes is not gone by.
      if (!isByteCount(file.size) || !isByteCount(file.offset)) throw new Error('a file without a usable size or place');
      entries.push(file);
    }
  }
  return entries;
}

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function countFiles(directory) {
  let count = 0;
  for (const entry of listEntries(directory)) count += entry.isDirectory ? countFiles(entry) : 1;
  return count;
}
