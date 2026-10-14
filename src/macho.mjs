// Layouts are those of Apple's <mach-o/fat.h>, <mach-o/loader.h> and <mach-o/nlist.h>, and
// of xnu's cs_blobs.h for the signature. A Mach-O is little-endian on every Mac built since
// 2006; the universal wrapper and the signature are big-endian.
const UNIVERSAL_MAGIC = 0xcafebabe;
const UNIVERSAL_MAGIC_64 = 0xcafebabf;
const MAGIC_32 = 0xfeedface;
const MAGIC_64 = 0xfeedfacf;
// A Java class file opens with the same four bytes as a universal binary and then states
// its version, 45 or more, where a universal binary counts its slices.
const MAX_SLICES = 16;
const HEADER_BYTES = { [MAGIC_32]: 28, [MAGIC_64]: 32 };
const SYMBOL_BYTES = { [MAGIC_32]: 12, [MAGIC_64]: 16 };
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;

const FILE_KINDS = { 2: 'executable', 6: 'library', 8: 'library' };
const ARM64 = 0x0100000c;
const ARCHITECTURES = { [ARM64]: 'arm64', 0x01000007: 'x86_64', 0x0200000c: 'arm64_32', 7: 'i386', 12: 'arm' };
const ARM64E_SUBTYPE = 2;
const SUBTYPE_MASK = 0x00ffffff;

const LC_SYMTAB = 0x2;
const LC_CODE_SIGNATURE = 0x1d;
// A segment command lists the sections of one segment. Where the count of them sits, how
// long each entry is and where an entry keeps its size and its place in the file differ
// between the 32-bit and the 64-bit layout.
const SECTIONS_BY_SEGMENT_COMMAND = {
  0x1: { firstAt: 56, countAt: 48, entryBytes: 68, readSize: (entry) => entry.readUInt32LE(36), offsetAt: 40 },
  0x19: { firstAt: 72, countAt: 64, entryBytes: 80, readSize: (entry) => Number(entry.readBigUInt64LE(40)), offsetAt: 48 },
};
const SECTION_NAME_BYTES = 16;
// Sections that hold names the program needs while it runs: `strip` leaves them alone.
// Objective-C keeps the names of classes and of methods and properties as strings. Swift
// keeps one four-byte record for each type and, as strings, the names of stored properties
// and enum cases.
const OBJC_CLASS_NAMES = '__objc_classname';
const OBJC_METHOD_NAMES = '__objc_methname';
const SWIFT_FIELD_NAMES = '__swift5_reflstr';
const SWIFT_TYPE_RECORDS = ['__swift5_types', '__swift5_types2'];
const SWIFT_TYPE_RECORD_BYTES = 4;
const NAME_SECTIONS = new Set([OBJC_CLASS_NAMES, OBJC_METHOD_NAMES, SWIFT_FIELD_NAMES, ...SWIFT_TYPE_RECORDS]);
// The largest apps keep a few megabytes of such names. More than this is not read.
const MAX_NAME_SECTION_BYTES = 16 * 1024 * 1024;
// A name as code spells one, with the colons of an Objective-C method name. The same
// sections hold type encodings and layout bytes, which are not names and do not look like one.
const NAME = /^[A-Za-z_$.][\w$.:]*$/;
// Swift classes are named in the Objective-C list too, in mangled form: `_Tt`, letters for
// the kind, then each part of the name led by its length, as in `_TtC4Shop11OrderClient`.
const SWIFT_MANGLED_CLASS = /^_Tt[A-Z]+((?:\d+[^\d].*)?)$/;
const LC_BUILD_VERSION = 0x32;
// Builds from before LC_BUILD_VERSION say what they are for by which "minimum version"
// command they carry: macOS, iOS, tvOS or watchOS.
const PLATFORM_BY_VERSION_COMMAND = { 0x24: 1, 0x25: 2, 0x2f: 3, 0x30: 4 };
// PLATFORM_* of <mach-o/loader.h>. Mac Catalyst apps run on the Mac under its rules; the
// phone, TV, watch and headset systems and their simulators share theirs.
const SYSTEM_BY_PLATFORM = { 1: 'macos', 6: 'macos', 2: 'ios', 3: 'ios', 4: 'ios', 7: 'ios', 8: 'ios', 9: 'ios', 11: 'ios', 12: 'ios' };
const MACOS_PLATFORM = 1;

// In a symbol's type byte: any of the top three bits marks an entry written for a debugger,
// the lowest bit a name that other files may link against, and the three between them say
// where the name is defined, or with none of them set, that it is defined somewhere else.
const DEBUG_ENTRY_BITS = 0xe0;
const EXTERNAL_BIT = 0x01;
const DEFINED_BITS = 0x0e;
const SOURCE_NAME_ENTRY = 0x64;
const SYMBOLS_PER_READ = 65536;
const MAX_NAME_BYTES = 1024;
// Real programs name a few thousand original files in a few hundred kilobytes. The limit
// keeps a file that claims far more from filling memory.
const MAX_SOURCE_NAME_BYTES = 4 * 1024 * 1024;

const EMBEDDED_SIGNATURE_MAGIC = 0xfade0cc0;
const CODE_DIRECTORY_MAGIC = 0xfade0c02;
const ENTITLEMENTS_MAGIC = 0xfade7171;
const CODE_DIRECTORY_SLOT = 0;
const ENTITLEMENTS_SLOT = 5;
const MAX_SIGNATURE_BLOBS = 64;
const MAX_ENTITLEMENTS_BYTES = 1024 * 1024;

/**
 * One architecture's build inside a Mach-O file.
 *
 * @typedef {object} MachOImage
 * @property {string} architecture for example 'arm64'
 * @property {'executable' | 'library' | 'other'} kind
 * @property {'macos' | 'ios' | 'other'} system which family of Apple systems it is built for;
 *   'ios' takes in tvOS, watchOS and visionOS, whose rules are the same
 * @property {number} debugEntries symbol table entries written for a debugger
 * @property {number} localNames names of functions and variables that nothing outside the file needs
 * @property {number} exportedNames names defined here that other files may link against
 * @property {string[]} sourcePaths the original files, as the linker recorded where they were
 * @property {KeptNames} keptNames
 * @property {{ flags: number, entitlements: string } | null} signature null when the build is not signed
 */

/**
 * Names that are part of how the program runs, and so are still there after stripping.
 *
 * @typedef {object} KeptNames
 * @property {number} types Swift types, and Objective-C classes that are not Swift's
 * @property {number} members different names of properties, enum cases and methods
 * @property {number} swiftTypes records in the Swift type list
 * @property {number} objcClassNames names in the Objective-C class name list, Swift classes among them
 * @property {number} swiftFieldNames names of Swift stored properties and enum cases
 * @property {number} objcMethodNames names of Objective-C methods and properties
 * @property {string | null} sampleType one type name, to show
 * @property {string | null} sampleMember one member name, to show
 */

/**
 * Reads what a Mach-O file says about itself, without running it or any other program.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 * @returns {MachOImage[] | null} one image per architecture; null when the bytes are not a
 *   Mach-O, or are cut short or malformed, which the system would not load either
 */
export function readMachO(source) {
  try {
    const images = listSlices(source).map(({ start, bytes }) => readImage(readerWithin(source.read, start, bytes)));
    return images.length > 0 && !images.includes(null) ? images : null;
  } catch {
    return null;
  }
}

/** A reader that stays inside one stretch of the bytes, whatever offsets the file claims. */
function readerWithin(read, start, bytes) {
  return Object.assign(
    (offset, length) => {
      if (offset + length > bytes) throw new Error('a read reaches past the end');
      return read(start + offset, length);
    },
    { bytes },
  );
}

/** @returns {{ start: number, bytes: number }[]} where each architecture's build sits; none for another kind of file */
function listSlices(source) {
  if (source.byteLength < 8) return [];
  const opening = source.read(0, 8);
  const magic = opening.readUInt32BE(0);
  if (magic !== UNIVERSAL_MAGIC && magic !== UNIVERSAL_MAGIC_64) return [{ start: 0, bytes: source.byteLength }];

  const sliceCount = opening.readUInt32BE(4);
  if (sliceCount > MAX_SLICES) return [];
  const isWide = magic === UNIVERSAL_MAGIC_64;
  const entryBytes = isWide ? 32 : 20;
  const table = source.read(8, sliceCount * entryBytes);
  return Array.from({ length: sliceCount }, (_, index) => {
    const entry = table.subarray(index * entryBytes);
    const start = isWide ? Number(entry.readBigUInt64BE(8)) : entry.readUInt32BE(8);
    const bytes = isWide ? Number(entry.readBigUInt64BE(16)) : entry.readUInt32BE(12);
    if (start + bytes > source.byteLength) throw new Error('a slice reaches past the end of the file');
    return { start, bytes };
  }).sort((one, other) => one.start - other.start).map((slice, index, slices) => {
    // Each build has its own stretch of the file. Builds that share bytes are not what a
    // linker writes, and would have the same bytes read once for every one of them.
    if (index > 0 && slice.start < slices[index - 1].start + slices[index - 1].bytes) throw new Error('slices overlap');
    return slice;
  });
}

/**
 * @param {((offset: number, length: number) => Buffer) & { bytes: number }} read stays inside the slice
 * @returns {MachOImage | null} null when the slice is not a Mach-O image
 */
function readImage(read) {
  const magic = read.bytes >= 4 ? read(0, 4).readUInt32LE(0) : 0;
  if (!(magic in HEADER_BYTES)) return null;
  const header = read(0, HEADER_BYTES[magic]);
  const commandBytes = header.readUInt32LE(20);
  if (commandBytes > MAX_COMMAND_BYTES) throw new Error('the load commands are implausibly large');
  const commands = read(HEADER_BYTES[magic], commandBytes);
  const commandCount = header.readUInt32LE(16);

  let symbolTable = null;
  let signature = null;
  const nameSections = new Map();
  // A build that does not say what it is for is taken as one for the Mac.
  let platform = MACOS_PLATFORM;
  // A read past the end of the commands throws, which also ends a count that is not true.
  for (let index = 0, offset = 0; index < commandCount; index += 1) {
    const command = commands.readUInt32LE(offset);
    const size = commands.readUInt32LE(offset + 4);
    if (size < 8) throw new Error('a load command has no size');
    if (command === LC_SYMTAB) {
      symbolTable = {
        offset: commands.readUInt32LE(offset + 8),
        count: commands.readUInt32LE(offset + 12),
        namesOffset: commands.readUInt32LE(offset + 16),
        namesBytes: commands.readUInt32LE(offset + 20),
      };
    } else if (command === LC_CODE_SIGNATURE) {
      signature = { offset: commands.readUInt32LE(offset + 8), bytes: commands.readUInt32LE(offset + 12) };
    } else if (command === LC_BUILD_VERSION) {
      platform = commands.readUInt32LE(offset + 8);
    } else if (command in PLATFORM_BY_VERSION_COMMAND) {
      platform = PLATFORM_BY_VERSION_COMMAND[command];
    } else if (command in SECTIONS_BY_SEGMENT_COMMAND) {
      collectNameSections(commands.subarray(offset, offset + size), SECTIONS_BY_SEGMENT_COMMAND[command], nameSections);
    }
    offset += size;
  }

  return {
    architecture: nameArchitecture(header.readUInt32LE(4), header.readUInt32LE(8)),
    kind: FILE_KINDS[header.readUInt32LE(12)] ?? 'other',
    system: SYSTEM_BY_PLATFORM[platform] ?? 'other',
    ...(symbolTable ? readSymbols(read, symbolTable, SYMBOL_BYTES[magic]) : NO_SYMBOLS),
    keptNames: readKeptNames(read, nameSections),
    signature: signature && readSignature(readerWithin(read, signature.offset, signature.bytes)),
  };
}

const NO_SYMBOLS = { debugEntries: 0, localNames: 0, exportedNames: 0, sourcePaths: [] };

function nameArchitecture(cpuType, cpuSubtype) {
  if (cpuType === ARM64 && (cpuSubtype & SUBTYPE_MASK) === ARM64E_SUBTYPE) return 'arm64e';
  return ARCHITECTURES[cpuType] ?? `cpu ${cpuType}`;
}

function readSymbols(read, { offset, count, namesOffset, namesBytes }, symbolBytes) {
  let debugEntries = 0;
  let localNames = 0;
  let exportedNames = 0;
  let sourceNameBytes = 0;
  const sourceNames = [];
  const readName = (nameOffset) => {
    if (nameOffset >= namesBytes) return '';
    return textBeforeZero(read(namesOffset + nameOffset, Math.min(MAX_NAME_BYTES, namesBytes - nameOffset)), 'utf8');
  };

  for (let first = 0; first < count; first += SYMBOLS_PER_READ) {
    const symbolsRead = Math.min(SYMBOLS_PER_READ, count - first);
    const symbols = read(offset + first * symbolBytes, symbolsRead * symbolBytes);
    for (let at = 0; at < symbols.length; at += symbolBytes) {
      const type = symbols[at + 4];
      if (type & DEBUG_ENTRY_BITS) {
        debugEntries += 1;
        if (type === SOURCE_NAME_ENTRY && sourceNameBytes < MAX_SOURCE_NAME_BYTES) {
          const name = readName(symbols.readUInt32LE(at));
          sourceNames.push(name);
          // An empty name still costs a read, so it counts for something.
          sourceNameBytes += name.length + 1;
        }
      } else if (!(type & EXTERNAL_BIT)) {
        localNames += 1;
      } else if (type & DEFINED_BITS) {
        exportedNames += 1;
      }
    }
  }
  return { debugEntries, localNames, exportedNames, sourcePaths: joinSourcePaths(sourceNames) };
}

/**
 * The linker records each original file as two names in a row, its folder (ending in a
 * slash) and then the file, and closes the file's entries with an empty name.
 */
function joinSourcePaths(names) {
  const paths = new Set();
  let folder = '';
  for (const name of names) {
    if (name.endsWith('/')) {
      folder = name;
    } else {
      if (name) paths.add(name.startsWith('/') ? name : folder + name);
      folder = '';
    }
  }
  return [...paths];
}

/** @returns {string} the text up to the first zero byte, or all of it when there is none */
function textBeforeZero(bytes, encoding) {
  const end = bytes.indexOf(0);
  return bytes.toString(encoding, 0, end === -1 ? bytes.length : end);
}

/**
 * Notes where the sections that hold names sit, of those one segment command lists. The
 * names are a note beside what else the program says, so a list that does not hold what it
 * counts is read as far as it goes and never fails the program.
 */
function collectNameSections(segment, { firstAt, countAt, entryBytes, readSize, offsetAt }, nameSections) {
  if (segment.length < firstAt) return;
  const sectionCount = segment.readUInt32LE(countAt);
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = segment.subarray(firstAt + index * entryBytes, firstAt + (index + 1) * entryBytes);
    if (entry.length < entryBytes) return;
    const name = textBeforeZero(entry.subarray(0, SECTION_NAME_BYTES), 'latin1');
    if (NAME_SECTIONS.has(name)) nameSections.set(name, { offset: entry.readUInt32LE(offsetAt), bytes: readSize(entry) });
  }
}

/**
 * @param {(offset: number, length: number) => Buffer} read stays inside the slice
 * @param {Map<string, { offset: number, bytes: number }>} sections from `collectNameSections`
 * @returns {KeptNames}
 */
function readKeptNames(read, sections) {
  // A section that does not lie inside the file, all of it, holds nothing to count.
  const sectionWithin = (name) => {
    const section = sections.get(name);
    return section && section.offset + section.bytes <= read.bytes ? section : null;
  };
  const stringsIn = (name) => {
    const section = sectionWithin(name);
    if (!section) return [];
    const bytes = read(section.offset, Math.min(section.bytes, MAX_NAME_SECTION_BYTES));
    return bytes.toString('latin1').split('\0').filter(Boolean);
  };
  const classNames = stringsIn(OBJC_CLASS_NAMES).filter((name) => NAME.test(name));
  const methodNames = stringsIn(OBJC_METHOD_NAMES).filter((name) => NAME.test(name));
  const fieldNames = stringsIn(SWIFT_FIELD_NAMES);
  const swiftTypes = SWIFT_TYPE_RECORDS.reduce(
    (sum, name) => sum + Math.floor((sectionWithin(name)?.bytes ?? 0) / SWIFT_TYPE_RECORD_BYTES),
    0,
  );
  const memberNames = [...new Set([...fieldNames, ...methodNames])];
  return {
    // A Swift class is in both lists, and is counted once, as a Swift type.
    types: swiftTypes + classNames.filter((name) => !SWIFT_MANGLED_CLASS.test(name)).length,
    members: memberNames.length,
    swiftTypes,
    objcClassNames: classNames.length,
    swiftFieldNames: fieldNames.length,
    objcMethodNames: methodNames.length,
    sampleType: classNames.length > 0 ? plainClassName(classNames[0]) : null,
    // The longest of the first few says the most: a method name spells out what it takes.
    sampleMember: memberNames.slice(0, 64).reduce((longest, name) => (name.length > longest.length ? name : longest), '') || null,
  };
}

/** @returns {string} `OrderClient` for `_TtC4Shop11OrderClient`; any other name as it is */
function plainClassName(name) {
  let rest = SWIFT_MANGLED_CLASS.exec(name)?.[1];
  let last = name;
  while (rest) {
    const length = Number.parseInt(rest, 10);
    const start = String(length).length;
    if (!Number.isInteger(length) || length === 0 || start + length > rest.length) return name;
    last = rest.slice(start, start + length);
    rest = rest.slice(start + length);
  }
  return last;
}

/** @param {(offset: number, length: number) => Buffer} read stays inside the signature */
function readSignature(read) {
  const opening = read(0, 12);
  if (opening.readUInt32BE(0) !== EMBEDDED_SIGNATURE_MAGIC) throw new Error('not an embedded signature');
  const blobCount = opening.readUInt32BE(8);
  if (blobCount > MAX_SIGNATURE_BLOBS) throw new Error('the signature lists implausibly many parts');
  const index = read(12, blobCount * 8);

  let flags = null;
  let entitlements = '';
  for (let at = 0; at < index.length; at += 8) {
    const slot = index.readUInt32BE(at);
    const blobOffset = index.readUInt32BE(at + 4);
    if (slot === CODE_DIRECTORY_SLOT) {
      const codeDirectory = read(blobOffset, 16);
      if (codeDirectory.readUInt32BE(0) !== CODE_DIRECTORY_MAGIC) throw new Error('not a code directory');
      flags = codeDirectory.readUInt32BE(12);
    } else if (slot === ENTITLEMENTS_SLOT) {
      const blob = read(blobOffset, 8);
      if (blob.readUInt32BE(0) !== ENTITLEMENTS_MAGIC) throw new Error('not an entitlements list');
      const textBytes = Math.min(blob.readUInt32BE(4) - 8, MAX_ENTITLEMENTS_BYTES);
      entitlements = read(blobOffset + 8, textBytes).toString('utf8');
    }
  }
  if (flags === null) throw new Error('the signature has no code directory');
  return { flags, entitlements };
}
