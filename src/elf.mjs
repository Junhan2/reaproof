import { constants, inflateSync } from 'node:zlib';
import { readRecords, textBeforeZero, unlessMalformed } from './bytes.mjs';
import { checkNativeNames, countedNames } from './native.mjs';
import { HOME_FOLDER } from './program.mjs';

// Layouts are those of the ELF format of the System V ABI (<elf.h>), in which Linux, Android
// and most other Unix systems keep their programs and libraries. Nothing here runs the file.

const ELF_MAGIC = 0x7f454c46;
const CLASS_64 = 2;
const BIG_ENDIAN = 2;
const EXECUTABLE = 2;
const SHARED_OBJECT = 3;
// A program header that names the loader marks a program, also one built as a shared object
// so that it can be loaded anywhere (PIE). A static PIE has no loader and says what it is in
// its dynamic section instead. A library has neither.
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_FLAGS_1 = 0x6ffffffb;
const DF_1_PIE = 0x08000000;
const MAX_DYNAMIC_BYTES = 64 * 1024;
const ARCHITECTURES = { 3: 'i386', 0x08: 'mips', 0x15: 'ppc64', 0x28: 'arm', 0x3e: 'x86_64', 0xb7: 'arm64', 0xf3: 'riscv' };
// Where what is read here sits, in the 32-bit and in the 64-bit layout: in the file header, in
// a program header, a section header and a symbol, and how long a pair of the dynamic section
// and the header of a compressed section are.
const LAYOUTS = {
  32: {
    header: { bytes: 52, programsAt: 0x1c, sectionsAt: 0x20, programBytesAt: 0x2a, sectionBytesAt: 0x2e },
    program: { bytes: 32, offsetAt: 4, sizeAt: 16 },
    section: { bytes: 40, flagsAt: 8, offsetAt: 16, sizeAt: 20 },
    symbol: { bytes: 16, infoAt: 12, otherAt: 13, sectionAt: 14 },
    dynamicPairBytes: 8,
    compressedHeaderBytes: 12,
  },
  64: {
    header: { bytes: 64, programsAt: 0x20, sectionsAt: 0x28, programBytesAt: 0x36, sectionBytesAt: 0x3a },
    program: { bytes: 56, offsetAt: 8, sizeAt: 32 },
    section: { bytes: 64, flagsAt: 8, offsetAt: 24, sizeAt: 32 },
    symbol: { bytes: 24, infoAt: 4, otherAt: 5, sectionAt: 6 },
    dynamicPairBytes: 16,
    compressedHeaderBytes: 24,
  },
};
const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;
const SHF_COMPRESSED = 0x800;
const COMPRESSED_WITH_ZLIB = 1;
const UNDEFINED_SECTION = 0;
// In a symbol's info byte the kind is the low four bits and the binding the high four; a
// function or a variable is what a name of the code is. Its visibility, in the low bits of
// the next byte, keeps a global name inside the library when it is hidden or internal.
const FUNCTION_OR_VARIABLE = new Set([1, 2]);
const LOCAL_BINDING = 0;
const KEPT_INSIDE = new Set([1, 2]);
const MAX_SECTIONS = 10_000;
const MAX_SECTION_NAMES_BYTES = 1024 * 1024;
// The debug sections that hold the names of source files and folders as text. They are read
// this far: a large program names a few thousand files in far less.
const PATH_SECTIONS = new Set(['.debug_line_str', '.debug_str', '.debug_line']);
const MAX_PATH_TEXT_BYTES = 4 * 1024 * 1024;
// A compressed section is unpacked from no more than its first megabyte, and not at all when
// that comes to more than the limit: a few bytes can stand for a great deal of text.
const MAX_PACKED_BYTES = 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_SOURCES = 100_000;
const SOURCE_FILE = /^[\w.+@~\-/\\:]{1,1024}\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|s|S|asm|go|rs|swift|zig|kt|java)$/;
const ABSOLUTE_FOLDER = /^(?:\/|[A-Za-z]:[\\/])[\w.+@~\-/\\ ]{1,1024}$/;

/**
 * @typedef {object} ElfImage
 * @property {string} architecture
 * @property {'executable' | 'library'} kind
 * @property {number} localNames names of functions and variables that nothing outside the file needs
 * @property {number} exportedNames names that other files may link against
 * @property {number} debugSections sections written for a debugger (DWARF)
 * @property {string[]} sources source files the debug information names
 * @property {boolean} namesBuilder whether it names a home folder of the machine that built it
 */

/**
 * @param {import('./bytes.mjs').ByteSource} source
 * @returns {ElfImage | null} null for another kind of file, an object file, or one that is
 *   cut short or malformed
 */
export function readElf(source) {
  if (source.byteLength < LAYOUTS[32].header.bytes || source.read(0, 4).readUInt32BE(0) !== ELF_MAGIC) return null;
  return unlessMalformed(() => readImage(source));
}

/**
 * Names that stripping takes out, and debug information, left in a Linux or Android build.
 *
 * @param {ElfImage} image
 */
export function checkElf(path, image) {
  const { architecture, debugSections, sources, namesBuilder } = image;
  return checkNativeNames(path, { format: 'elf', architecture, names: countedNames(image), sources, namesBuilder }, { debugSections });
}

function readImage(source) {
  const headerBytes = source.byteLength < LAYOUTS[64].header.bytes ? LAYOUTS[32].header.bytes : LAYOUTS[64].header.bytes;
  const opening = source.read(0, headerBytes);
  const bits = opening[4] === CLASS_64 ? 64 : 32;
  const layout = LAYOUTS[bits];
  const read = numberReader(opening[5] === BIG_ENDIAN, bits);
  const fileKind = read.u16(opening, 16);
  if (fileKind !== EXECUTABLE && fileKind !== SHARED_OBJECT) return null;

  const sections = listSections(source, opening, read, layout);
  const isProgram = fileKind === EXECUTABLE || isProgramImage(source, opening, read, layout);
  const symbolTable = sections.find(({ type }) => type === SHT_SYMTAB);
  const names = symbolTable ? countNames(source, read, layout, symbolTable) : { localNames: 0, exportedNames: 0 };
  const machine = read.u16(opening, 18);
  return {
    architecture: ARCHITECTURES[machine] ?? `machine ${machine}`,
    kind: isProgram ? 'executable' : 'library',
    ...names,
    debugSections: sections.filter(({ name }) => name.startsWith('.debug_')).length,
    ...readSourcePaths(source, read, layout, sections),
  };
}

function numberReader(isBigEndian, bits) {
  const u16 = (bytes, at) => (isBigEndian ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at));
  const u32 = (bytes, at) => (isBigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at));
  const u64 = (bytes, at) => Number(isBigEndian ? bytes.readBigUInt64BE(at) : bytes.readBigUInt64LE(at));
  return { u16, u32, word: bits === 64 ? u64 : u32 };
}

/**
 * The entries of a table in the file. A header can state entries larger than the fields read
 * here need, and then each is read only as far as those go.
 */
function tableEntries(source, start, count, entryBytes, usedBytes) {
  if (entryBytes === usedBytes) {
    const table = source.read(start, count * entryBytes);
    return Array.from({ length: count }, (_, index) => table.subarray(index * entryBytes, (index + 1) * entryBytes));
  }
  if (start + count * entryBytes > source.byteLength) throw new Error('the table reaches past the end');
  return Array.from({ length: count }, (_, index) => source.read(start + index * entryBytes, usedBytes));
}

/** The section table, each section with its name, from the section that holds the names. */
function listSections(source, opening, read, layout) {
  const start = read.word(opening, layout.header.sectionsAt);
  const entryBytes = read.u16(opening, layout.header.sectionBytesAt);
  const count = read.u16(opening, layout.header.sectionBytesAt + 2);
  if (start === 0 || count === 0) return [];
  if (count > MAX_SECTIONS || entryBytes < layout.section.bytes) throw new Error('implausible section table');
  const fields = layout.section;
  const sections = tableEntries(source, start, count, entryBytes, fields.bytes).map((entry) => ({
    nameAt: read.u32(entry, 0),
    type: read.u32(entry, 4),
    flags: read.word(entry, fields.flagsAt),
    offset: read.word(entry, fields.offsetAt),
    size: read.word(entry, fields.sizeAt),
  }));
  const holder = sections[read.u16(opening, layout.header.sectionBytesAt + 4)];
  const names = holder ? sectionBytes(source, holder, MAX_SECTION_NAMES_BYTES) : Buffer.alloc(0);
  return sections.map(({ nameAt, ...section }) => ({ ...section, name: textBeforeZero(names.subarray(nameAt), 'latin1') }));
}

function isProgramImage(source, opening, read, layout) {
  const start = read.word(opening, layout.header.programsAt);
  const entryBytes = read.u16(opening, layout.header.programBytesAt);
  const count = read.u16(opening, layout.header.programBytesAt + 2);
  const fields = layout.program;
  if (start === 0 || count === 0 || entryBytes < fields.bytes) return false;
  let dynamic = null;
  for (const entry of tableEntries(source, start, count, entryBytes, fields.bytes)) {
    const type = read.u32(entry, 0);
    if (type === PT_INTERP) return true;
    if (type === PT_DYNAMIC) dynamic = { offset: read.word(entry, fields.offsetAt), size: read.word(entry, fields.sizeAt) };
  }
  if (!dynamic) return false;
  const pairBytes = layout.dynamicPairBytes;
  const pairs = source.read(dynamic.offset, Math.min(dynamic.size, MAX_DYNAMIC_BYTES));
  for (let at = 0; at + pairBytes <= pairs.length; at += pairBytes) {
    const tag = read.word(pairs, at);
    if (tag === 0) return false;
    if (tag === DT_FLAGS_1) return (read.word(pairs, at + pairBytes / 2) & DF_1_PIE) !== 0;
  }
  return false;
}

/** Up to `limit` bytes of a section, or none when it has no bytes in the file or reaches past its end. */
function sectionBytes(source, section, limit) {
  const length = Math.min(section.size, limit);
  if (section.type === SHT_NOBITS || section.offset + length > source.byteLength) return Buffer.alloc(0);
  return source.read(section.offset, length);
}

function countNames(source, read, layout, table) {
  const fields = layout.symbol;
  const count = Math.floor(table.size / fields.bytes);
  if (table.offset + count * fields.bytes > source.byteLength) throw new Error('the symbol table reaches past the end');
  let localNames = 0;
  let exportedNames = 0;
  for (const symbols of readRecords((position, length) => source.read(position, length), table.offset, count, fields.bytes)) {
    for (let at = 0; at < symbols.length; at += fields.bytes) {
      const info = symbols[at + fields.infoAt];
      if (!FUNCTION_OR_VARIABLE.has(info & 0xf) || read.u16(symbols, at + fields.sectionAt) === UNDEFINED_SECTION) continue;
      const isExported = info >> 4 !== LOCAL_BINDING && !KEPT_INSIDE.has(symbols[at + fields.otherAt] & 0x3);
      if (isExported) exportedNames += 1;
      else localNames += 1;
    }
  }
  return { localNames, exportedNames };
}

/**
 * The source files and folders that the debug information names as text. A section a
 * compiler compressed is unpacked when zlib did it, and only so far.
 */
function readSourcePaths(source, read, layout, sections) {
  const files = new Set();
  let namesBuilder = false;
  for (const section of sections) {
    if (!PATH_SECTIONS.has(section.name)) continue;
    for (const text of textOf(source, read, layout, section).split('\0')) {
      const isFile = SOURCE_FILE.test(text);
      if (!isFile && !ABSOLUTE_FOLDER.test(text)) continue;
      if (isFile && files.size < MAX_SOURCES) files.add(text);
      namesBuilder ||= HOME_FOLDER.test(text);
    }
  }
  // A path with its folders in it says more than a name alone, so those come first.
  const hasFolder = (file) => /[\\/]/.test(file);
  const all = [...files];
  return { sources: [...all.filter(hasFolder), ...all.filter((file) => !hasFolder(file))], namesBuilder };
}

function textOf(source, read, layout, section) {
  if (!(section.flags & SHF_COMPRESSED)) return sectionBytes(source, section, MAX_PATH_TEXT_BYTES).toString('latin1');
  const header = sectionBytes(source, section, layout.compressedHeaderBytes);
  if (header.length === 0 || read.u32(header, 0) !== COMPRESSED_WITH_ZLIB) return '';
  try {
    const packed = sectionBytes(source, section, header.length + MAX_PACKED_BYTES);
    // What the first stretch holds is unpacked without waiting for the end of the stream.
    const options = { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: MAX_UNPACKED_BYTES };
    return inflateSync(packed.subarray(header.length), options).subarray(0, MAX_PATH_TEXT_BYTES).toString('latin1');
  } catch {
    // More text than the limit, or not zlib after all: the paths are not counted.
    return '';
  }
}
