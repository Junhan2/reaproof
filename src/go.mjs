import { readChunks, unlessMalformed } from './bytes.mjs';
import { ABSOLUTE_PATH, HOME_FOLDER } from './program.mjs';

// A Go program says in its build info which Go built it, from which module, with which
// dependencies and settings. For stack traces it also keeps the name of every function and the
// path of every source file, in its function table (pclntab). The program reads both while it
// runs, so `strip` and `-ldflags="-s -w"` leave them in. Layouts are those of Go's
// debug/buildinfo package and of runtime/symtab.go.

const BUILD_INFO_MAGIC = Buffer.from('\xff Go buildinf:', 'latin1');
// The linker puts the build info at a 16-byte boundary.
const BUILD_INFO_ALIGNMENT = 16;
// From Go 1.18 the two strings follow the header directly, each led by its length.
const INLINE_STRINGS_FLAG = 0x2;
const BUILD_INFO_HEADER_BYTES = 32;
const MAX_BUILD_INFO_BYTES = 256 * 1024;
// The module list is set apart from what is around it by sixteen bytes on each side.
const MODULE_INFO_MARKER_BYTES = 16;
// The function table opens with a magic number of the Go release that wrote its layout, two
// zero bytes, the smallest instruction size and the size of a pointer.
const GO_1_20 = 0xfffffff1;
const GO_1_18 = 0xfffffff0;
const GO_1_16 = 0xfffffffa;
const TABLE_MAGICS = [GO_1_20, GO_1_18, GO_1_16].map((magic) => {
  const bytes = Buffer.alloc(6);
  bytes.writeUInt32LE(magic);
  return bytes;
});
// A program can hold these bytes by chance as well. The first few places are tried.
const MAX_TABLE_CANDIDATES = 8;
const MAX_FUNCTIONS = 10_000_000;
const MAX_FILE_TABLE_BYTES = 32 * 1024 * 1024;
// Where Go keeps code that is not the program's own: the module cache and a project's vendor
// folder hold dependencies, and the standard library sits under the Go installation, or in a
// trimmed build has a first path element without a dot, its own `vendor` among them.
const DEPENDENCY = /[\\/]pkg[\\/]mod[\\/]|[\\/]vendor[\\/]/;
const TOOLCHAIN = /golang\.org[\\/]toolchain@|[\\/](?:go|libexec)[\\/]src[\\/]/;
const MODULE_PATH = /^[^/\\]+\.[^/\\]+\//;

/** What `collectGo` gathers from one file, a stretch at a time. */
export function startGo() {
  return { buildInfoAt: null };
}

/**
 * Notes where a stretch of a file holds the start of Go's build info. The function table is
 * looked for afterwards, in a file that turned out to be a Go program.
 *
 * @param {{ position: number, bytes: Buffer }} chunk
 * @param {ReturnType<typeof startGo>} found
 */
export function collectGo({ position, bytes }, found) {
  if (found.buildInfoAt !== null) return;
  for (let at = bytes.indexOf(BUILD_INFO_MAGIC); at !== -1; at = bytes.indexOf(BUILD_INFO_MAGIC, at + 1)) {
    if ((position + at) % BUILD_INFO_ALIGNMENT === 0) {
      found.buildInfoAt = position + at;
      return;
    }
  }
}

/**
 * A note for a Go program: what its build info and function table say about it. A file
 * without Go's build info is not taken for a Go program.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 * @param {{ chunkBytes: number, overlapBytes: number }} reading how the file is read a stretch at a time
 */
export function checkGo(path, source, found, { chunkBytes, overlapBytes }) {
  if (found.buildInfoAt === null) return [];
  const info = unlessMalformed(() => readBuildInfo(source, found.buildInfoAt));
  if (!info) return [];
  const table = findFunctionTable(source, chunkBytes, overlapBytes);
  const paths = table?.paths ?? [];
  const files = classifyFiles(paths, info.modulePath);
  const detail = {
    goVersion: info.goVersion,
    modulePath: info.modulePath,
    dependencies: info.dependencies,
    isTrimmed: info.isTrimmed,
    functions: table?.functions ?? null,
    ownFiles: files.own.length,
    dependencyFiles: files.dependency,
    namesBuilder: paths.some((file) => HOME_FOLDER.test(file)),
    sample: files.own[0] ?? null,
  };
  // A path cut out of the file table would keep all of that text in memory with the finding.
  return [{ rule: 'go-program', severity: 'info', path, detail: structuredClone(detail) }];
}

/** The first place that holds a function table that reads as one, in the order they come. */
function findFunctionTable(source, chunkBytes, overlapBytes) {
  const tried = new Set();
  for (const { position, bytes } of readChunks(source, chunkBytes, overlapBytes)) {
    for (const magic of TABLE_MAGICS) {
      for (let at = bytes.indexOf(magic); at !== -1 && tried.size < MAX_TABLE_CANDIDATES; at = bytes.indexOf(magic, at + 1)) {
        if (tried.has(position + at)) continue;
        tried.add(position + at);
        const table = unlessMalformed(() => readFunctionTable(source, position + at));
        if (table) return table;
      }
    }
    if (tried.size === MAX_TABLE_CANDIDATES) break;
  }
  return null;
}

function readBuildInfo(source, at) {
  const bytes = source.read(at, Math.min(MAX_BUILD_INFO_BYTES, source.byteLength - at));
  if (!(bytes[BUILD_INFO_MAGIC.length + 1] & INLINE_STRINGS_FLAG)) return null;
  let cursor = BUILD_INFO_HEADER_BYTES;
  const readString = () => {
    const [length, used] = readUvarint(bytes, cursor);
    const start = cursor + used;
    if (start + length > bytes.length) throw new Error('a string runs past the build info');
    cursor = start + length;
    return bytes.subarray(start, cursor);
  };
  const goVersion = readString().toString('utf8');
  if (!goVersion.startsWith('go')) return null;
  const framed = readString();
  // As Go's own reader does: there is a module list only where it ends a marker's length early.
  const isFramed = framed.length > 2 * MODULE_INFO_MARKER_BYTES && framed[framed.length - MODULE_INFO_MARKER_BYTES - 1] === 0x0a;
  const moduleInfo = isFramed ? framed.subarray(MODULE_INFO_MARKER_BYTES, framed.length - MODULE_INFO_MARKER_BYTES) : Buffer.alloc(0);
  let modulePath = null;
  let dependencies = 0;
  let isTrimmed = false;
  for (const line of moduleInfo.toString('utf8').split('\n')) {
    const [kind, value] = line.split('\t');
    if (kind === 'mod') modulePath = value;
    else if (kind === 'dep') dependencies += 1;
    else if (kind === 'build' && value === '-trimpath=true') isTrimmed = true;
  }
  return { goVersion: goVersion.slice(0, 64), modulePath: modulePath?.slice(0, 256) ?? null, dependencies, isTrimmed };
}

/** Go's unsigned varint: seven bits a byte, lowest first, the top bit saying more follow. */
function readUvarint(bytes, at) {
  let value = 0;
  for (let used = 0; used < 5 && at + used < bytes.length; used += 1) {
    const byte = bytes[at + used];
    value += (byte & 0x7f) * 2 ** (7 * used);
    if (byte < 0x80) return [value, used + 1];
  }
  throw new Error('not a varint');
}

function readFunctionTable(source, at) {
  const opening = source.read(at, 8);
  const magic = opening.readUInt32LE(0);
  const pointerBytes = opening[7];
  if (![1, 2, 4].includes(opening[6]) || ![4, 8].includes(pointerBytes)) return null;
  const header = source.read(at + 8, 8 * pointerBytes);
  const word = (index) => (pointerBytes === 8 ? Number(header.readBigUInt64LE(index * 8)) : header.readUInt32LE(index * 4));
  const functions = word(0);
  // Go 1.18 added the start of the code after the counts, which moves the offsets one word on.
  const fileTableIndex = magic === GO_1_16 ? 4 : 5;
  const fileTableStart = word(fileTableIndex);
  const fileTableEnd = word(fileTableIndex + 1);
  const isPlausible =
    functions > 0 &&
    functions < MAX_FUNCTIONS &&
    fileTableStart < fileTableEnd &&
    fileTableEnd - fileTableStart <= MAX_FILE_TABLE_BYTES &&
    at + fileTableEnd <= source.byteLength;
  if (!isPlausible) return null;
  const text = source.read(at + fileTableStart, fileTableEnd - fileTableStart).toString('utf8');
  return { functions, paths: [...new Set(text.split('\0').filter(Boolean))] };
}

function classifyFiles(paths, modulePath) {
  const own = [];
  let dependency = 0;
  for (const file of paths) {
    if (file.startsWith('<') || TOOLCHAIN.test(file)) continue;
    const isOwnModule = modulePath !== null && modulePath !== 'command-line-arguments' && file.startsWith(`${modulePath}/`);
    if (isOwnModule) own.push(file);
    else if (DEPENDENCY.test(file) || MODULE_PATH.test(file)) dependency += 1;
    // What is left is relative and dotless, the standard library of a trimmed build, or a path
    // on the machine that built the program, which is its own.
    else if (ABSOLUTE_PATH.test(file)) own.push(file);
  }
  return { own, dependency };
}
