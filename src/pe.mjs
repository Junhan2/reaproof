import { readRecords, textBeforeZero, unlessMalformed } from './bytes.mjs';
import { checkNativeNames } from './native.mjs';
import { HOME_FOLDER, PE_HEADER_POINTER } from './program.mjs';

// Layouts are those of Microsoft's PE format documentation (winnt.h): a DOS header that
// points to the PE signature, then the COFF header, the optional header with its data
// directories, and the table of sections. Windows programs, libraries and .NET assemblies are
// all kept in it. Nothing here runs the file.

const PE_SIGNATURE = 0x50450000;
const COFF_HEADER_BYTES = 20;
const SECTION_HEADER_BYTES = 40;
const ARCHITECTURES = { 0x14c: 'i386', 0x1c4: 'arm', 0x8664: 'x86_64', 0xa641: 'arm64ec', 0xaa64: 'arm64' };
// The optional header's data directories, by the kind of header: where their count is kept.
const DIRECTORY_COUNT_AT = { 0x10b: 92, 0x20b: 108 };
const DEBUG_DIRECTORY = 6;
const CLR_DIRECTORY = 14;
const MAX_SECTIONS = 96;
// A COFF symbol table, which only a debugger or a linker reads, is a list of records of this
// size; a record may be followed by auxiliary ones that say more about it.
const SYMBOL_RECORD_BYTES = 18;
const MAX_SYMBOL_RECORDS = 20_000_000;
const EXTERNAL_CLASS = 2;
const STATIC_CLASS = 3;
// The debug directory lists records; a CodeView one names the file the debug information was
// written to, as the linker was told to: a full path unless the build said otherwise. The name
// follows the record's signature, an identifier and an age.
const DEBUG_ENTRY_BYTES = 28;
const MAX_DEBUG_ENTRIES = 32;
const CODEVIEW = 2;
const CODEVIEW_PDB70 = 0x53445352;
const CODEVIEW_PATH_AT = 24;
const MAX_DEBUG_PATH_BYTES = 1024;
// A .NET assembly keeps its metadata behind the CLR header: a root that names its streams,
// and in the stream of tables, a row count for each table it has.
const METADATA_SIGNATURE = 0x424a5342;
const TABLE_STREAMS = new Set(['#~', '#-']);
const TYPE_TABLE = 2;
const METHOD_TABLE = 6;
const MAX_STREAMS = 16;

/**
 * @typedef {object} PeImage
 * @property {string} architecture
 * @property {number} names functions and variables named in the COFF symbol table
 * @property {string | null} debugFile where the build wrote its debug information
 * @property {{ types: number, methods: number } | null} dotnet what a .NET assembly defines
 */

/**
 * @param {import('./bytes.mjs').ByteSource} source
 * @returns {PeImage | null} null for another kind of file, or one cut short or malformed
 */
export function readPe(source) {
  if (source.byteLength < 64 || source.read(0, 2).toString('latin1') !== 'MZ') return null;
  return unlessMalformed(() => readImage(source));
}

/**
 * Names that stripping takes out, a debug file path that names the machine that built the
 * program, and the code of a .NET assembly, which reads back as source.
 */
export function checkPe(path, { architecture, names, debugFile, dotnet }) {
  const findings = checkNativeNames(path, { format: 'pe', architecture, names, sources: [], namesBuilder: false });
  if (debugFile !== null && HOME_FOLDER.test(debugFile)) findings.push({ rule: 'debug-file-path', severity: 'info', path, detail: { architecture, debugFile } });
  if (dotnet?.types > 0) findings.push({ rule: 'dotnet-code', severity: 'info', path, detail: { ...dotnet } });
  return findings;
}

function readImage(source) {
  const headerAt = source.read(PE_HEADER_POINTER, 4).readUInt32LE(0);
  if (source.read(headerAt, 4).readUInt32BE(0) !== PE_SIGNATURE) return null;
  const coff = source.read(headerAt + 4, COFF_HEADER_BYTES);
  const machine = coff.readUInt16LE(0);
  const sectionCount = coff.readUInt16LE(2);
  const optionalBytes = coff.readUInt16LE(16);
  if (sectionCount > MAX_SECTIONS) throw new Error('implausibly many sections');
  const optionalAt = headerAt + 4 + COFF_HEADER_BYTES;
  const optional = source.read(optionalAt, optionalBytes);
  const sections = readSections(source, optionalAt + optionalBytes, sectionCount);
  const directory = (index) => readDirectory(optional, index);
  return {
    architecture: ARCHITECTURES[machine] ?? `machine 0x${machine.toString(16)}`,
    names: countNames(source, coff.readUInt32LE(8), coff.readUInt32LE(12)),
    debugFile: unlessMalformed(() => readDebugFile(source, sections, directory(DEBUG_DIRECTORY))),
    dotnet: unlessMalformed(() => readDotnet(source, sections, directory(CLR_DIRECTORY))),
  };
}

function readSections(source, start, count) {
  const table = source.read(start, count * SECTION_HEADER_BYTES);
  return Array.from({ length: count }, (_, index) => {
    const entry = table.subarray(index * SECTION_HEADER_BYTES);
    return {
      address: entry.readUInt32LE(12),
      span: Math.max(entry.readUInt32LE(8), entry.readUInt32LE(16)),
      offset: entry.readUInt32LE(20),
    };
  });
}

/** @returns {{ address: number, size: number } | null} null when the header has no such directory */
function readDirectory(optional, index) {
  const countAt = DIRECTORY_COUNT_AT[optional.length >= 2 ? optional.readUInt16LE(0) : 0];
  if (countAt === undefined || optional.length < countAt + 4) return null;
  const at = countAt + 4 + index * 8;
  if (index >= optional.readUInt32LE(countAt) || at + 8 > optional.length) return null;
  const address = optional.readUInt32LE(at);
  return address === 0 ? null : { address, size: optional.readUInt32LE(at + 4) };
}

/** Where in the file an address of the loaded image is, by the section it falls in. */
function offsetOf(sections, address) {
  const section = sections.find(({ address: start, span }) => address >= start && address < start + span);
  if (!section) throw new Error('an address outside every section');
  return section.offset + (address - section.address);
}

/** Functions and variables the COFF symbol table defines, leaving out its auxiliary records. */
function countNames(source, start, recordCount) {
  if (start === 0 || recordCount === 0) return 0;
  const records = Math.min(recordCount, MAX_SYMBOL_RECORDS, Math.floor((source.byteLength - start) / SYMBOL_RECORD_BYTES));
  let names = 0;
  let auxiliaryLeft = 0;
  for (const block of readRecords((position, length) => source.read(position, length), start, records, SYMBOL_RECORD_BYTES)) {
    for (let at = 0; at < block.length; at += SYMBOL_RECORD_BYTES) {
      if (auxiliaryLeft > 0) {
        auxiliaryLeft -= 1;
        continue;
      }
      auxiliaryLeft = block[at + 17];
      const isDefined = block.readInt16LE(at + 12) > 0;
      const storage = block[at + 16];
      // A section's own record is named after it, with a dot, and is not a name of the code.
      const isSectionRecord = block[at] === 0x2e;
      if (isDefined && (storage === EXTERNAL_CLASS || storage === STATIC_CLASS) && !isSectionRecord) names += 1;
    }
  }
  return names;
}

function readDebugFile(source, sections, directory) {
  if (!directory) return null;
  const count = Math.min(Math.floor(directory.size / DEBUG_ENTRY_BYTES), MAX_DEBUG_ENTRIES);
  const entries = source.read(offsetOf(sections, directory.address), count * DEBUG_ENTRY_BYTES);
  for (let at = 0; at < entries.length; at += DEBUG_ENTRY_BYTES) {
    if (entries.readUInt32LE(at + 12) !== CODEVIEW) continue;
    const size = entries.readUInt32LE(at + 16);
    const offset = entries.readUInt32LE(at + 24);
    if (size <= CODEVIEW_PATH_AT || offset + size > source.byteLength) continue;
    const record = source.read(offset, Math.min(size, CODEVIEW_PATH_AT + MAX_DEBUG_PATH_BYTES));
    if (record.readUInt32LE(0) !== CODEVIEW_PDB70) continue;
    const path = textBeforeZero(record.subarray(CODEVIEW_PATH_AT), 'utf8');
    if (path) return path;
  }
  return null;
}

/** How many types and methods a .NET assembly defines, from the row counts of its tables. */
function readDotnet(source, sections, directory) {
  if (!directory) return null;
  const header = source.read(offsetOf(sections, directory.address), 16);
  const rootAt = offsetOf(sections, header.readUInt32LE(8));
  const root = source.read(rootAt, Math.min(header.readUInt32LE(12), 4096));
  if (root.readUInt32LE(0) !== METADATA_SIGNATURE) return null;
  const versionBytes = root.readUInt32LE(12);
  let at = 16 + versionBytes + 2;
  const streamCount = Math.min(root.readUInt16LE(at), MAX_STREAMS);
  at += 2;
  for (let index = 0; index < streamCount; index += 1) {
    const offset = root.readUInt32LE(at);
    const size = root.readUInt32LE(at + 4);
    const nameAt = at + 8;
    const nameEnd = root.indexOf(0, nameAt);
    if (nameEnd === -1) return null;
    const name = root.toString('latin1', nameAt, nameEnd);
    // A name is padded with zeros to a multiple of four bytes, its ending zero included.
    at = nameAt + Math.ceil((nameEnd + 1 - nameAt) / 4) * 4;
    // The header of the stream and a row count for each of the 64 tables it may have.
    if (TABLE_STREAMS.has(name)) return countTableRows(source.read(rootAt + offset, Math.min(size, 24 + 64 * 4)));
  }
  return null;
}

function countTableRows(stream) {
  const present = stream.readBigUInt64LE(8);
  // A row count follows for each table present, in the order of the tables' numbers.
  const rowsOf = (table) => {
    if (!((present >> BigInt(table)) & 1n)) return 0;
    let index = 0;
    for (let lower = 0; lower < table; lower += 1) if ((present >> BigInt(lower)) & 1n) index += 1;
    return stream.readUInt32LE(24 + index * 4);
  };
  // The first type is the module itself, which every assembly has.
  return { types: Math.max(rowsOf(TYPE_TABLE) - 1, 0), methods: rowsOf(METHOD_TABLE) };
}
