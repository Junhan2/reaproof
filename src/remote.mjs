import { checkInlineMaps, checkMapFile, findMapReferences } from './checks/sourcemaps.mjs';
import { summarizeFindings } from './rules.mjs';
import { MAX_FILE_BYTES, ScanError, startResult } from './scan.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
// One page and its own files, read one after another: a check, not a crawl.
const MAX_ASSETS = 60;
const USER_AGENT = 'reaproof (source map exposure check)';

const SCRIPT_SOURCE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const LINK_TARGET = /<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;
const CODE_PATH = /\.(?:m?js|css)$/i;

export function isWebAddress(input) {
  return /^https?:\/\//i.test(input);
}

/**
 * Checks whether a deployed page serves source maps for its own code files. A local fix
 * cannot reach what a hosting platform builds by itself, so this looks at the result.
 *
 * Only maps are examined and nothing fetched is kept: looking for keys stays a check for
 * someone who holds the build output.
 *
 * @param {string} pageAddress an http(s) address
 */
export async function scanDeployedSite(pageAddress) {
  const page = toAddress(pageAddress);
  if (!page) throw new ScanError('page-unreachable', pageAddress);
  const result = startResult({ root: page.href, isDeployed: true, targets: [page.href], frameworks: [] });
  // A file too large to read is put on the same list the local scan puts one on.
  const read = (address) => fetchText(address, result.skippedLargeFiles);
  const html = await read(page);
  if (!html) throw new ScanError('page-unreachable', pageAddress);

  const { ownAssets, otherOriginCount } = listCodeAssets(html.text, page);
  result.skippedOtherOrigins = otherOriginCount;
  const addFindings = (findings) => {
    for (const finding of findings) result.findings.push({ ...finding, diskPath: null });
  };

  const checkedMaps = new Set();
  for (const asset of ownAssets.slice(0, MAX_ASSETS)) {
    const code = await read(asset);
    if (!code) continue;
    result.filesScanned += 1;
    addFindings(checkInlineMaps(asset.pathname, code.text));

    for (const mapAddress of listMapCandidates(asset, code)) {
      if (mapAddress.origin !== page.origin || checkedMaps.has(mapAddress.href)) continue;
      checkedMaps.add(mapAddress.href);
      const map = await read(mapAddress);
      // A single-page app answers unknown paths with its HTML; that does not parse as a map.
      if (map) addFindings(checkMapFile(mapAddress.pathname, map.text));
    }
  }
  return Object.assign(result, summarizeFindings(result.findings));
}

/** Where a map for this code file may be: where the server or the file says, or beside it. */
function listMapCandidates(asset, code) {
  const declared = [code.sourceMapHeader, ...findMapReferences(code.text)].filter(Boolean);
  // A "hidden" map is written next to the file without being mentioned in it.
  const beside = `${asset.pathname}.map`;
  return [...declared, beside].map((reference) => toAddress(reference, asset)).filter(Boolean);
}

function listCodeAssets(html, page) {
  const references = [
    ...Array.from(html.matchAll(SCRIPT_SOURCE), ([, source]) => source),
    ...Array.from(html.matchAll(LINK_TARGET), ([, target]) => target).filter((target) =>
      CODE_PATH.test(target.split(/[?#]/)[0]),
    ),
  ];

  const ownAssets = new Map();
  const otherOrigins = new Set();
  for (const reference of references) {
    const address = toAddress(reference, page);
    if (!address) continue;
    if (address.origin === page.origin) ownAssets.set(address.href, address);
    else otherOrigins.add(address.href);
  }
  return { ownAssets: [...ownAssets.values()], otherOriginCount: otherOrigins.size };
}

/** @returns {URL | null} null when the reference is not an address at all, so there is nothing to fetch */
function toAddress(reference, base) {
  try {
    return new URL(reference, base);
  } catch {
    return null;
  }
}

/**
 * @param {URL} address
 * @param {string[]} skippedLargeFiles gains the path of a file that was there but too large to read
 * @returns {Promise<{ text: string, sourceMapHeader: string | null } | null>} null when there is nothing usable
 */
async function fetchText(address, skippedLargeFiles) {
  try {
    const response = await fetch(address, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await readCapped(response);
    if (text === null) {
      skippedLargeFiles.push(address.pathname);
      return null;
    }
    // ECMA-426 section 11.1.1: `sourcemap` is the header, `x-sourcemap` its deprecated name.
    const sourceMapHeader = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap');
    return { text, sourceMapHeader };
  } catch {
    // Unreachable, timed out or cut off: treated the same as a file that is not there.
    return null;
  }
}

/** Reads a response body as text. @returns {Promise<string | null>} null for one larger than the scanner reads */
async function readCapped(response) {
  // A server that states the size up front spares the download of what would be dropped anyway.
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_FILE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
