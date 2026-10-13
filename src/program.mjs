// Telling a Linux or Windows program from other files by how it opens. (A macOS or iOS one
// is known by `readMachO` reading it.)

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
// In an ELF header: which way round its numbers are written, then what kind of file it is.
// A program is an executable or a shared object; an object file is a step of a build.
const ELF_BYTE_ORDER = 5;
const ELF_BIG_ENDIAN = 2;
const ELF_KIND = 16;
const ELF_PROGRAM_KINDS = [2, 3];
// A Windows program opens with a DOS header that says, at this offset, where the real one starts.
const DOS_HEADER_BYTES = 64;
const PE_HEADER_POINTER = 0x3c;

/** @param {import('./bytes.mjs').ByteSource} source */
export function isLinuxOrWindowsProgram(source) {
  if (source.byteLength < DOS_HEADER_BYTES) return false;
  const opening = source.read(0, DOS_HEADER_BYTES);
  if (opening.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)) {
    const isBigEndian = opening[ELF_BYTE_ORDER] === ELF_BIG_ENDIAN;
    return ELF_PROGRAM_KINDS.includes(isBigEndian ? opening.readUInt16BE(ELF_KIND) : opening.readUInt16LE(ELF_KIND));
  }
  if (opening.toString('latin1', 0, 2) !== 'MZ') return false;
  const headerOffset = opening.readUInt32LE(PE_HEADER_POINTER);
  return headerOffset + 4 <= source.byteLength && source.read(headerOffset, 4).toString('latin1') === 'PE\0\0';
}
