// Layout from @electron/fuses: the sentinel, one version byte, one length byte, then one
// byte per fuse in FuseV1Options order.
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const WIRE_VERSION = 1;
const FUSE_DISABLED = 0x30;
const FUSE_ENABLED = 0x31;
const WIRE_HEADER_BYTES = 2;
// Fuses that let someone run or debug the shipped app as a development tool. All three are
// on in a stock Electron build.
const DEVELOPMENT_FUSES = [
  [0, 'runAsNode'],
  [2, 'nodeOptions'],
  [3, 'nodeCliInspect'],
];
// Fuses that together make Electron refuse app code that differs from what was packaged.
// Both are off in a stock build. Electron checks app.asar on macOS and Windows only, so on
// Linux there is nothing to turn on.
const INTEGRITY_FUSES = [
  [4, 'embeddedAsarIntegrityValidation'],
  [5, 'onlyLoadAppFromAsar'],
];
const ELF_OPENING = '\x7fELF';

/**
 * Reports development fuses left on, and app code checks left off, when a stretch of a file
 * holds Electron's fuse list. The list sits in Electron's own binary, whatever the system and
 * whatever the file is called, so it is looked for in the bytes and not by name.
 *
 * @param {string} path how the file is shown to the user
 * @param {import('./bytes.mjs').ByteSource} source the whole file
 * @param {{ position: number, bytes: Buffer }} chunk the stretch of it being searched
 */
export function checkElectronFuses(path, source, { position, bytes }) {
  const index = bytes.indexOf(SENTINEL);
  if (index === -1) return [];
  const wire = readWire(source, position + index + SENTINEL.length);
  if (!wire) return [];
  const findings = [];
  const enabled = fusesIn(wire, DEVELOPMENT_FUSES, FUSE_ENABLED);
  if (enabled.length > 0) findings.push({ rule: 'electron-fuse', severity: 'medium', path, detail: { enabled } });
  const disabled = fusesIn(wire, INTEGRITY_FUSES, FUSE_DISABLED);
  if (disabled.length > 0 && source.read(0, ELF_OPENING.length).toString('latin1') !== ELF_OPENING) {
    findings.push({ rule: 'electron-asar-integrity', severity: 'info', path, detail: { disabled } });
  }
  return findings;
}

/** @returns {Buffer | null} null when what follows the sentinel is not a fuse list this can read */
function readWire(source, wirePosition) {
  try {
    const [version, length] = source.read(wirePosition, WIRE_HEADER_BYTES);
    if (version !== WIRE_VERSION) return null;
    return source.read(wirePosition + WIRE_HEADER_BYTES, length);
  } catch {
    // Cut short: nothing can be said about it.
    return null;
  }
}

/** The names of the fuses in a wire that are in the given state. A fuse the wire is too short to hold is in none. */
function fusesIn(wire, fuses, state) {
  return fuses.filter(([fuse]) => wire[fuse] === state).map(([, name]) => name);
}
