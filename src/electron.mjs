// Layout from @electron/fuses: the sentinel, one version byte, one length byte, then one
// byte per fuse in FuseV1Options order.
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const WIRE_VERSION = 1;
const FUSE_ENABLED = 0x31;
const WIRE_HEADER_BYTES = 2;
// Fuses that let someone run or debug the shipped app as a development tool. All three are
// on in a stock Electron build.
const DEVELOPMENT_FUSES = [
  [0, 'runAsNode'],
  [2, 'nodeOptions'],
  [3, 'nodeCliInspect'],
];

/**
 * Reports development fuses left on, when a stretch of a file holds Electron's fuse list.
 * The list sits in Electron's own binary, whatever the system and whatever the file is
 * called, so it is looked for in the bytes and not by name.
 *
 * @param {string} path how the file is shown to the user
 * @param {import('./bytes.mjs').ByteSource} source the whole file
 * @param {{ position: number, bytes: Buffer }} chunk the stretch of it being searched
 */
export function checkElectronFuses(path, source, { position, bytes }) {
  const index = bytes.indexOf(SENTINEL);
  if (index === -1) return [];
  const enabled = readEnabledDevelopmentFuses(source, position + index + SENTINEL.length);
  if (!enabled || enabled.length === 0) return [];
  return [{ rule: 'electron-fuse', severity: 'medium', path, detail: { enabled } }];
}

/** @returns {string[] | null} null when what follows the sentinel is not a fuse list this can read */
function readEnabledDevelopmentFuses(source, wirePosition) {
  try {
    const [version, length] = source.read(wirePosition, WIRE_HEADER_BYTES);
    if (version !== WIRE_VERSION) return null;
    const wire = source.read(wirePosition + WIRE_HEADER_BYTES, length);
    return DEVELOPMENT_FUSES.filter(([fuse]) => wire[fuse] === FUSE_ENABLED).map(([, name]) => name);
  } catch {
    // Cut short: nothing can be said about it.
    return null;
  }
}
