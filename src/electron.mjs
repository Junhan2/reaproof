import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { readAt } from './bytes.mjs';

// Layout from @electron/fuses: the sentinel, one version byte, one length byte, then one
// byte per fuse in FuseV1Options order.
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const WIRE_VERSION = 1;
const FUSE_ENABLED = 0x31;
const WIRE_HEADER_BYTES = 2;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
// Fuses that let someone run or debug the shipped app as a development tool. All three are
// on in a stock Electron build.
const DEVELOPMENT_FUSES = [
  [0, 'runAsNode'],
  [2, 'nodeOptions'],
  [3, 'nodeCliInspect'],
];
const MACOS_FRAMEWORK_NAME = 'Electron Framework.framework';

/** Where the fuses of a macOS Electron app live, given a directory the scanner came across. */
export function electronBinaryIn(directory, name) {
  return name === MACOS_FRAMEWORK_NAME ? join(directory, 'Electron Framework') : null;
}

/**
 * Reports development fuses left on in a packaged Electron binary.
 *
 * @param {string} path how the binary is shown to the user
 * @param {string} binaryPath absolute path
 */
export function checkElectronFuses(path, binaryPath) {
  const enabled = readEnabledDevelopmentFuses(binaryPath);
  if (!enabled || enabled.length === 0) return [];
  return [{ rule: 'electron-fuse', severity: 'medium', path, detail: { enabled } }];
}

/** @returns {string[] | null} null when the file is not an Electron binary this can read */
function readEnabledDevelopmentFuses(binaryPath) {
  let fd;
  try {
    fd = openSync(binaryPath, 'r');
    const sentinelPosition = findSentinel(fd, fstatSync(fd).size);
    if (sentinelPosition === -1) return null;

    const wirePosition = sentinelPosition + SENTINEL.length;
    const [version, length] = readAt(fd, wirePosition, WIRE_HEADER_BYTES);
    if (version !== WIRE_VERSION) return null;
    const wire = readAt(fd, wirePosition + WIRE_HEADER_BYTES, length);
    return DEVELOPMENT_FUSES.filter(([index]) => wire[index] === FUSE_ENABLED).map(([, name]) => name);
  } catch {
    // Missing, unreadable or cut short: nothing can be said about it.
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads the file in overlapping chunks, so a sentinel across a chunk boundary is still found. */
function findSentinel(fd, fileBytes) {
  const buffer = Buffer.alloc(SCAN_CHUNK_BYTES + SENTINEL.length - 1);
  for (let position = 0; position < fileBytes; position += SCAN_CHUNK_BYTES) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    const index = buffer.subarray(0, bytesRead).indexOf(SENTINEL);
    if (index !== -1) return position + index;
  }
  return -1;
}
