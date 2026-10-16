import { readRecords, readVarint, textBeforeZero, unlessMalformed, utf16Text } from './bytes.mjs';

// What an Android app says about how it was built, read without running anything, from an
// app package (APK) or an app bundle (AAB). Layouts are those of the Android source: the
// binary XML of a package's manifest (ResourceTypes.h), the protobuf one of a bundle's (aapt2's
// Resources.proto), the APK Signing Block (the APK Signature Scheme v2 documentation), the DEX
// file format and Hermes's BytecodeFileFormat.h.

const MANIFEST = 'AndroidManifest.xml';
const DEX_FILE = /^classes\d*\.dex$/;
// A bundle says how it is to be split in this file, and keeps each module in a folder of its
// own: the base module's manifest in `base/manifest`, its code in `base/dex`.
const BUNDLE_CONFIG = 'BundleConfig.pb';
// Binary XML: chunks with a type, the size of their header and their whole size.
const XML_CHUNK = 0x0003;
const STRING_POOL = 0x0001;
const RESOURCE_MAP = 0x0180;
const START_ELEMENT = 0x0102;
const UTF8_FLAG = 0x100;
const NO_STRING = 0xffffffff;
const MAX_STRINGS = 200_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
// Protobuf XML: a node holds an element (1); an element has a name (3), attributes (4) and
// children (5); an attribute has a name (2), its value as written (3), its resource ID (5) and
// its compiled value (6), in which a true-or-false is the primitive (7) and its boolean (8).
const MAX_ELEMENT_DEPTH = 64;
// The attributes Android knows by resource ID, and the type of a true-or-false value.
const NAME = 0x01010003;
const DEBUGGABLE = 0x0101000f;
const TEST_ONLY = 0x01010272;
const BOOLEAN = 0x12;
// The elements whose android:name is a class of the app. Android finds those classes by these
// names, so R8 keeps them.
const COMPONENTS = new Set(['application', 'activity', 'service', 'receiver', 'provider']);
// The APK Signing Block ends with its size and these sixteen bytes, right where the central
// directory begins. The debug key that Android's build tools make on each machine is issued to
// CN=Android Debug, which the certificate writes as this attribute: its OID, then a printable
// or a UTF-8 string of thirteen characters.
const SIGNING_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const MAX_SIGNING_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_FILE_BYTES = 1024 * 1024;
const DEBUG_SUBJECTS = [0x13, 0x0c].map((stringType) =>
  Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03, stringType, 0x0d]), Buffer.from('Android Debug', 'latin1')]),
);
const V1_SIGNATURE = /.\.(?:RSA|DSA|EC)$/i;
// DEX: where the header keeps the tables read here, and how large an entry of each is.
const DEX_MAGIC = Buffer.from('dex\n', 'latin1');
const DEX_HEADER_BYTES = 0x70;
const STRING_IDS_AT = 0x38;
const TYPE_IDS_AT = 0x40;
const CLASS_DEFS_AT = 0x60;
const CLASS_DEF_BYTES = 32;
const MAX_CLASSES = 1_000_000;
const MAX_DESCRIPTOR_BYTES = 1024;
// Classes the build writes for every app, ones the compiler makes up for lambdas, and inner
// classes with nothing before their `$`.
const GENERATED_CLASS = /^(?:R|BuildConfig|Manifest)?$|^-/;
// R8 and ProGuard rename classes to a letter or two, lower case; a name a person gives a
// class in Java or Kotlin opens with a capital and goes on in lower case.
const GIVEN_NAME = /^[A-Z][a-z][A-Za-z0-9_]/;
// The classes the manifest names keep their names whatever the build, and are not counted.
// Fewer named classes than this, or fewer than half of the app's own, say little either way.
const MIN_NAMED_CLASSES = 50;
const MIN_NAMED_SHARE = 0.5;
const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const HERMES_HEADER_BYTES = 56;

/**
 * Where a ZIP archive keeps an Android app's manifest, when it is an app package or an app
 * bundle: a package keeps it in binary XML at the top, next to its code; a bundle keeps the
 * base module's in protobuf.
 *
 * @param {{ files: { name: string }[], directories: Map<string, object> }} root
 * @returns {{ file: object, isBundle: boolean } | null}
 */
export function findAndroidManifest(root) {
  const atTop = root.files.find(({ name }) => name === MANIFEST);
  if (atTop && root.files.some(({ name }) => DEX_FILE.test(name))) return { file: atTop, isBundle: false };
  const inBase = root.directories.get('base')?.directories.get('manifest')?.files.find(({ name }) => name === MANIFEST);
  if (inBase && root.files.some(({ name }) => name === BUNDLE_CONFIG)) return { file: inBase, isBundle: true };
  return null;
}

/**
 * What an app's manifest and signature say about the build: whether it lets a debugger
 * attach, whether it is a test build, whether it was signed with a debug key.
 *
 * @param {string} path how the package is shown to the user
 * @param {import('./bytes.mjs').ByteSource} source the package's bytes
 * @param {{ root: object, read(file: object): Buffer, directoryOffset: number }} archive
 * @param {ReturnType<typeof findAndroidManifest>} where
 * @param {{ left: number }} budget what may still be read out of the archive, which what is read here counts against
 * @returns {{ findings: object[], manifest: ReturnType<typeof startManifest> | null }}
 */
export function checkAndroidPackage(path, source, archive, { file, isBundle }, budget) {
  const reserve = (entry, most) => {
    if (entry.size > Math.min(most, budget.left)) return false;
    budget.left -= entry.size;
    return true;
  };
  const readXml = isBundle ? readProtoManifest : readManifest;
  const manifest = reserve(file, MAX_MANIFEST_BYTES) ? unlessMalformed(() => readXml(archive.read(file))) : null;
  const signatures = archive.root.directories.get('META-INF')?.files.filter(({ name }) => V1_SIGNATURE.test(name)) ?? [];
  const isDebugSigned =
    unlessMalformed(() => holdsDebugSubject(signingBlock(source, archive.directoryOffset))) ||
    signatures.some((entry) => reserve(entry, MAX_SIGNATURE_FILE_BYTES) && unlessMalformed(() => holdsDebugSubject(archive.read(entry))));
  const kinds = [
    ...(manifest?.isDebuggable ? ['debuggable'] : []),
    ...(manifest?.isTestOnly ? ['test-only'] : []),
    ...(isDebugSigned ? ['debug-certificate'] : []),
  ];
  // Attaching a debugger is what the first lets anyone do; the others mark a build for testing.
  const severity = manifest?.isDebuggable ? 'high' : 'medium';
  const detail = { kinds, appPackage: manifest?.appPackage ?? null };
  return { findings: kinds.length > 0 ? [{ rule: 'android-debug-build', severity, path, detail }] : [], manifest };
}

/**
 * What `collectDexClasses` counts for one app: the package its own code is in, and the classes
 * its manifest names.
 *
 * @param {{ appPackage: string, classes: string[] }} manifest
 */
export function startDexClasses({ appPackage, classes }) {
  const descriptorOf = (name) => `L${name.replaceAll('.', '/')}`;
  return {
    appPackage,
    prefix: `${descriptorOf(codePackage(appPackage, classes))}/`,
    manifestClasses: new Set(classes.map((name) => `${descriptorOf(name)};`)),
    ownClasses: 0,
    namedClasses: 0,
    sample: null,
  };
}

/**
 * Counts the classes of the app's own package that one DEX file defines, and how many of them
 * keep the name they were given.
 *
 * @param {string} name the file's name
 * @param {import('./bytes.mjs').ByteSource} source
 * @param {ReturnType<typeof startDexClasses>} found
 */
export function collectDexClasses(name, source, found) {
  if (DEX_FILE.test(name)) unlessMalformed(() => countClasses(source, found));
}

/** The note for an app whose own classes keep their names. */
export function checkDexClasses(path, { appPackage, ownClasses, namedClasses, sample }) {
  if (namedClasses < MIN_NAMED_CLASSES || namedClasses < ownClasses * MIN_NAMED_SHARE) return [];
  return [{ rule: 'android-class-names', severity: 'medium', path, detail: { appPackage, ownClasses, namedClasses, sample } }];
}

/**
 * A note for Hermes bytecode, the form React Native and Expo compile an app's JavaScript to:
 * how many functions and strings it holds.
 *
 * @param {import('./bytes.mjs').ByteSource} source
 */
export function checkHermes(path, source) {
  if (source.byteLength < HERMES_HEADER_BYTES) return [];
  const header = source.read(0, HERMES_HEADER_BYTES);
  if (!header.subarray(0, HERMES_MAGIC.length).equals(HERMES_MAGIC)) return [];
  const detail = { version: header.readUInt32LE(8), functions: header.readUInt32LE(40), strings: header.readUInt32LE(52) };
  return [{ rule: 'hermes-bytecode', severity: 'info', path, detail }];
}

function startManifest() {
  return { appPackage: null, isDebuggable: false, isTestOnly: false, classes: [] };
}

/** What one element of a manifest says, whichever of the two formats its attributes were read from. */
function noteElement(found, element, attributes) {
  for (const { name, resourceId, text, isTrue } of attributes) {
    if (element === 'manifest' && name === 'package') found.appPackage = text;
    else if (element === 'application' && resourceId === DEBUGGABLE) found.isDebuggable = isTrue;
    else if (element === 'application' && resourceId === TEST_ONLY) found.isTestOnly = isTrue;
    // A name that opens with a dot is one the build has not yet put the package in front of.
    if (COMPONENTS.has(element) && resourceId === NAME && text && !text.startsWith('.')) found.classes.push(text);
  }
}

/**
 * The package the app's own code is in. The manifest's `package` is the application ID, to
 * which a build may add a suffix (`.debug`) or a flavour's; the classes the manifest names
 * are in the code's own package. So it is the longest package of two parts or more that the
 * ID shares with one of those classes, or else the ID.
 */
function codePackage(appPackage, classes) {
  const idParts = appPackage.split('.');
  let shared = 0;
  for (const name of classes) {
    const parts = name.split('.').slice(0, -1);
    let common = 0;
    while (common < Math.min(parts.length, idParts.length) && parts[common] === idParts[common]) common += 1;
    shared = Math.max(shared, common);
  }
  return shared >= 2 ? idParts.slice(0, shared).join('.') : appPackage;
}

/** What a manifest in binary XML says, from the elements `manifest` and those in COMPONENTS. */
function readManifest(xml) {
  if (xml.readUInt16LE(0) !== XML_CHUNK) return null;
  let strings = [];
  let resourceIds = [];
  const found = startManifest();
  for (let at = xml.readUInt16LE(2); at + 8 <= xml.length; ) {
    const type = xml.readUInt16LE(at);
    const size = xml.readUInt32LE(at + 4);
    if (size < 8 || at + size > xml.length) throw new Error('a chunk reaches past the manifest');
    const chunk = xml.subarray(at, at + size);
    if (type === STRING_POOL) strings = readStringPool(chunk);
    else if (type === RESOURCE_MAP) resourceIds = Array.from({ length: Math.floor((size - 8) / 4) }, (_, index) => chunk.readUInt32LE(8 + index * 4));
    else if (type === START_ELEMENT) readElement(chunk, strings, resourceIds, found);
    at += size;
  }
  return found;
}

function readElement(chunk, strings, resourceIds, found) {
  const element = strings[chunk.readUInt32LE(20)];
  if (element !== 'manifest' && !COMPONENTS.has(element)) return;
  const attributesAt = 16 + chunk.readUInt16LE(24);
  const attributeBytes = chunk.readUInt16LE(26);
  const attributes = Array.from({ length: chunk.readUInt16LE(28) }, (_, index) => {
    const at = attributesAt + index * attributeBytes;
    const nameIndex = chunk.readUInt32LE(at + 4);
    const textIndex = chunk.readUInt32LE(at + 8);
    return {
      name: strings[nameIndex],
      resourceId: resourceIds[nameIndex],
      text: textIndex === NO_STRING ? null : (strings[textIndex] ?? null),
      isTrue: chunk[at + 15] === BOOLEAN && chunk.readUInt32LE(at + 16) !== 0,
    };
  });
  noteElement(found, element, attributes);
}

function readStringPool(chunk) {
  const count = chunk.readUInt32LE(8);
  if (count > MAX_STRINGS) throw new Error('implausibly many strings');
  const isUtf8 = (chunk.readUInt32LE(16) & UTF8_FLAG) !== 0;
  const stringsAt = chunk.readUInt32LE(20);
  const offsetsAt = chunk.readUInt16LE(2);
  return Array.from({ length: count }, (_, index) => {
    const at = stringsAt + chunk.readUInt32LE(offsetsAt + index * 4);
    return isUtf8 ? readUtf8String(chunk, at) : readUtf16String(chunk, at);
  });
}

// A length takes one unit, or two when the first has its top bit set.
function readUtf8String(chunk, at) {
  const skipLength = (position) => position + (chunk[position] & 0x80 ? 2 : 1);
  const lengthAt = skipLength(at);
  const length = chunk[lengthAt] & 0x80 ? ((chunk[lengthAt] & 0x7f) << 8) | chunk[lengthAt + 1] : chunk[lengthAt];
  const start = skipLength(lengthAt);
  return chunk.toString('utf8', start, start + length);
}

function readUtf16String(chunk, at) {
  const first = chunk.readUInt16LE(at);
  const length = first & 0x8000 ? ((first & 0x7fff) << 16) | chunk.readUInt16LE(at + 2) : first;
  const start = at + (first & 0x8000 ? 4 : 2);
  return utf16Text(chunk.subarray(start, start + length * 2));
}

/** What a manifest in protobuf says, from the same elements as in binary XML. */
function readProtoManifest(bytes) {
  const found = startManifest();
  const visit = (node, depth) => {
    if (depth > MAX_ELEMENT_DEPTH) throw new Error('elements nested implausibly deep');
    for (const [field, element] of protoFields(node)) {
      if (field !== 1 || !Buffer.isBuffer(element)) continue;
      let name = '';
      const attributes = [];
      const children = [];
      for (const [part, value] of protoFields(element)) {
        if (!Buffer.isBuffer(value)) continue;
        if (part === 3) name = value.toString('utf8');
        else if (part === 4) attributes.push(readProtoAttribute(value));
        else if (part === 5) children.push(value);
      }
      noteElement(found, name, attributes);
      for (const child of children) visit(child, depth + 1);
    }
  };
  visit(bytes, 0);
  return found;
}

function readProtoAttribute(attribute) {
  const read = { name: '', resourceId: 0, text: null, isTrue: false };
  for (const [field, value] of protoFields(attribute)) {
    const isBytes = Buffer.isBuffer(value);
    if (field === 2 && isBytes) read.name = value.toString('utf8');
    else if (field === 3 && isBytes) read.text = value.toString('utf8');
    else if (field === 5 && !isBytes) read.resourceId = value;
    else if (field === 6 && isBytes) read.isTrue = isCompiledTrue(value);
  }
  return read;
}

function isCompiledTrue(item) {
  for (const [field, primitive] of protoFields(item)) {
    if (field !== 7 || !Buffer.isBuffer(primitive)) continue;
    for (const [part, value] of protoFields(primitive)) if (part === 8 && !Buffer.isBuffer(value)) return value !== 0;
  }
  return false;
}

/**
 * The fields of a protobuf message as they come: each one's number, then a number, or the
 * bytes of a string or of a message within. Fields of a fixed size are gone past.
 */
function* protoFields(message) {
  for (let at = 0; at < message.length; ) {
    const [key, keyBytes] = readVarint(message, at, 10);
    at += keyBytes;
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      const [value, used] = readVarint(message, at, 10);
      at += used;
      yield [field, value];
    } else if (wireType === 2) {
      const [length, used] = readVarint(message, at, 10);
      at += used;
      if (at + length > message.length) throw new Error('a field runs past its message');
      yield [field, message.subarray(at, at + length)];
      at += length;
    } else if (wireType === 1 || wireType === 5) {
      at += wireType === 1 ? 8 : 4;
    } else {
      throw new Error('a field of a kind protobuf does not have');
    }
  }
}

/** The bytes of the APK Signing Block, which sits right before the central directory, or none. */
function signingBlock(source, directoryOffset) {
  if (directoryOffset < 24) return Buffer.alloc(0);
  const ending = source.read(directoryOffset - 24, 24);
  if (!ending.subarray(8).equals(SIGNING_BLOCK_MAGIC)) return Buffer.alloc(0);
  // The size counts the block after its own first field.
  const size = Number(ending.readBigUInt64LE(0));
  if (size > MAX_SIGNING_BLOCK_BYTES || size + 8 > directoryOffset) return Buffer.alloc(0);
  return source.read(directoryOffset - size - 8, size + 8);
}

function holdsDebugSubject(bytes) {
  return DEBUG_SUBJECTS.some((subject) => bytes.includes(subject));
}

function countClasses(source, found) {
  const header = source.read(0, DEX_HEADER_BYTES);
  if (!header.subarray(0, DEX_MAGIC.length).equals(DEX_MAGIC)) return;
  // Each table is a count, then where it starts.
  const table = (at) => [header.readUInt32LE(at), header.readUInt32LE(at + 4)];
  const [stringCount, stringsAt] = table(STRING_IDS_AT);
  const [typeCount, typesAt] = table(TYPE_IDS_AT);
  const [classCount, classesAt] = table(CLASS_DEFS_AT);
  if (classCount > MAX_CLASSES) throw new Error('implausibly many classes');
  const descriptorOf = (typeIndex) => {
    if (typeIndex >= typeCount) throw new Error('a class of a type that is not there');
    const stringIndex = source.read(typesAt + typeIndex * 4, 4).readUInt32LE(0);
    if (stringIndex >= stringCount) throw new Error('a type named by a string that is not there');
    const dataAt = source.read(stringsAt + stringIndex * 4, 4).readUInt32LE(0);
    const data = source.read(dataAt, Math.min(MAX_DESCRIPTOR_BYTES, source.byteLength - dataAt));
    // The length in UTF-16 units comes first, as an unsigned LEB128; the text ends with a zero.
    let start = 0;
    while (data[start] & 0x80) start += 1;
    return textBeforeZero(data.subarray(start + 1), 'utf8');
  };
  for (const block of readRecords((position, length) => source.read(position, length), classesAt, classCount, CLASS_DEF_BYTES)) {
    for (let at = 0; at < block.length; at += CLASS_DEF_BYTES) {
      const descriptor = descriptorOf(block.readUInt32LE(at));
      if (!descriptor.startsWith(found.prefix)) continue;
      // An inner class is named after the class it is in, which for one the manifest names is kept.
      const outer = descriptor.slice(0, -1).split('$')[0];
      if (found.manifestClasses.has(`${outer};`)) continue;
      const simpleName = outer.slice(outer.lastIndexOf('/') + 1);
      if (GENERATED_CLASS.test(simpleName)) continue;
      found.ownClasses += 1;
      if (!GIVEN_NAME.test(simpleName)) continue;
      found.namedClasses += 1;
      found.sample ??= outer.slice(1).replaceAll('/', '.');
    }
  }
}
