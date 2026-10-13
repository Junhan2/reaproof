import { checkInlineMaps, checkMapFile, findMapReferences } from './checks/sourcemaps.mjs';
import { summarizeFindings } from './rules.mjs';
import { MAX_FILE_BYTES, ScanError, startResult } from './scan.mjs';
import { toShown } from './text.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
// One page and its own files, read one after another: a check, not a crawl.
const MAX_ASSETS = 60;
const MAX_REDIRECTS = 5;
// A page names its code files near the top. A longer page is cut here before it is searched.
const MAX_PAGE_CHARACTERS = 5 * 1024 * 1024;
const USER_AGENT = 'reaproof (source map exposure check)';

// Every run is bounded, so a page of unclosed tags or quotes is read once and not once per tag.
const SCRIPT_SOURCE = /<script\b[^>]{0,2000}?\bsrc\s*=\s*["']([^"']{1,2000})["']/gi;
const LINK_TARGET = /<link\b[^>]{0,2000}?\bhref\s*=\s*["']([^"']{1,2000})["']/gi;
const CODE_PATH = /\.(?:m?js|css)$/i;

export function isWebAddress(input) {
  return /^https?:\/\//i.test(input);
}

/**
 * Checks whether a deployed page serves source maps for its own code files. A local fix
 * cannot reach what a hosting platform builds by itself, so this looks at the result.
 *
 * Only maps are examined and nothing fetched is kept: looking for keys stays a check for
 * someone who holds the build output. What the page serves decides nothing about how far
 * the check goes: at most MAX_ASSETS code files, three map addresses for each, one site.
 *
 * @param {string} pageAddress an http(s) address
 */
export async function scanDeployedSite(pageAddress) {
  const requested = toAddress(pageAddress);
  if (!requested) throw new ScanError('page-unreachable', pageAddress);
  const result = startResult({ root: requested.href, isDeployed: true, targets: [requested.href], frameworks: [] });
  const html = await fetchText(requested, result.skippedLargeFiles, null);
  if (!html) throw new ScanError('page-unreachable', pageAddress);

  // A site may answer from another address than the one typed (www, https). That one is home.
  const page = html.address;
  Object.assign(result, { root: page.href, targets: [page.href] });
  // A file too large to read is put on the same list the local scan puts one on.
  const read = (address) => fetchText(address, result.skippedLargeFiles, page.origin);
  const { ownAssets, otherOriginCount } = listCodeAssets(html.text.slice(0, MAX_PAGE_CHARACTERS), page);
  result.skippedOtherOrigins = otherOriginCount;
  const addFindings = (findings) => {
    for (const finding of findings) result.findings.push({ ...toShown(finding), diskPath: null });
  };

  const checkedMaps = new Set();
  for (const asset of ownAssets.slice(0, MAX_ASSETS)) {
    const code = await read(asset);
    if (!code) continue;
    result.filesScanned += 1;
    addFindings(checkInlineMaps(asset.pathname, code.text));

    for (const mapAddress of listMapCandidates(code)) {
      if (mapAddress.origin !== page.origin || checkedMaps.has(mapAddress.href)) continue;
      checkedMaps.add(mapAddress.href);
      const map = await read(mapAddress);
      // A single-page app answers unknown paths with its HTML; that does not parse as a map.
      if (map) addFindings(checkMapFile(mapAddress.pathname, map.text));
    }
  }
  return Object.assign(result, summarizeFindings(result.findings));
}

/**
 * Where a map for this code file may be: where the server says, where the file says, or
 * beside it. A file can say it many times and the last one counts (ECMA-426 reads from the
 * end), which also keeps one file from sending the check after any number of addresses.
 */
function listMapCandidates(code) {
  const declared = [code.sourceMapHeader, findMapReferences(code.text).at(-1)].filter(Boolean);
  // A "hidden" map is written next to the file without being mentioned in it.
  const beside = `${code.address.pathname}.map`;
  return [...declared, beside].map((reference) => toAddress(reference, code.address)).filter(Boolean);
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
 * @param {string | null} homeOrigin the one site the file may be read from, or null for the page itself
 * @returns {Promise<{ text: string, sourceMapHeader: string | null, address: URL } | null>}
 *   null when there is nothing usable; `address` is where the file was finally read from
 */
async function fetchText(address, skippedLargeFiles, homeOrigin) {
  try {
    const response = await request(address, homeOrigin);
    if (!response?.ok) return null;
    const text = await readCapped(response);
    if (text === null) {
      skippedLargeFiles.push(address.pathname);
      return null;
    }
    // ECMA-426 section 11.1.1: `sourcemap` is the header, `x-sourcemap` its deprecated name.
    const sourceMapHeader = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap');
    return { text, sourceMapHeader, address: new URL(response.url) };
  } catch {
    // Unreachable, timed out or cut off: treated the same as a file that is not there.
    return null;
  }
}

/**
 * One GET. The page itself may be redirected anywhere. A file of the page is followed by
 * hand, and only while it stays on the page's own site: a redirect is the served content
 * speaking, and it does not get to send the check to another address.
 *
 * @returns {Promise<Response | null>} null when a redirect leads away or never ends
 */
async function request(address, homeOrigin) {
  let current = address;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: homeOrigin ? 'manual' : 'follow',
    });
    const isRedirect = homeOrigin && response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get('location') : null;
    if (!location) return response;
    await response.body?.cancel();
    const next = toAddress(location, current);
    if (next?.origin !== homeOrigin) return null;
    current = next;
  }
  return null;
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
