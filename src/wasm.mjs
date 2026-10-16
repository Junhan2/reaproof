import { readVarint, unlessMalformed } from './bytes.mjs';
import { checkNativeNames } from './native.mjs';

// A WebAssembly module keeps the names of its functions in the custom section "name", and its
// DWARF debug information in custom sections named ".debug_*", the way an ELF program keeps
// them. Layout from the WebAssembly core specification and its appendix on the name section.

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const CUSTOM_SECTION = 0;
const FUNCTION_NAMES = 1;
const MAX_SECTIONS = 10_000;

/**
 * The note for a WebAssembly module that kept the names of its functions or its debug
 * information, the same as for a native program. One cut short or malformed says nothing.
 *
 * @param {string} path how the file is shown to the user
 * @param {import('./bytes.mjs').ByteSource} source
 */
export function checkWasm(path, source) {
  if (source.byteLength < WASM_MAGIC.length || !source.read(0, WASM_MAGIC.length).equals(WASM_MAGIC)) return [];
  const module = unlessMalformed(() => readModule(source));
  if (!module) return [];
  const build = { format: 'wasm', architecture: 'wasm', names: module.names, sources: [], namesBuilder: false };
  return checkNativeNames(path, build, { debugSections: module.debugSections });
}

/** @returns {{ names: number, debugSections: number }} */
function readModule(source) {
  let names = 0;
  let debugSections = 0;
  let sectionCount = 0;
  for (let at = WASM_MAGIC.length; at < source.byteLength; ) {
    sectionCount += 1;
    if (sectionCount > MAX_SECTIONS) throw new Error('implausibly many sections');
    // An id, then the size as an unsigned LEB128 of at most five bytes.
    const head = source.read(at, Math.min(6, source.byteLength - at));
    const [size, sizeBytes] = readVarint(head, 1);
    const contentAt = at + 1 + sizeBytes;
    if (contentAt + size > source.byteLength) throw new Error('a section reaches past the end');
    if (head[0] === CUSTOM_SECTION) {
      const nameHead = source.read(contentAt, Math.min(5, size));
      const [nameBytes, used] = readVarint(nameHead, 0);
      const name = source.read(contentAt + used, Math.min(nameBytes, 64)).toString('utf8');
      if (name.startsWith('.debug_')) debugSections += 1;
      else if (name === 'name') names = countFunctionNames(source.read(contentAt + used + nameBytes, size - used - nameBytes));
    }
    at = contentAt + size;
  }
  return { names, debugSections };
}

/** How many functions the name section names: its subsection 1 opens with the count. */
function countFunctionNames(content) {
  for (let at = 0; at < content.length; ) {
    const id = content[at];
    const [size, used] = readVarint(content, at + 1);
    const subsectionAt = at + 1 + used;
    if (id === FUNCTION_NAMES) return readVarint(content, subsectionAt)[0];
    at = subsectionAt + size;
  }
  return 0;
}
