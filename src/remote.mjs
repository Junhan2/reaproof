import { extname } from 'node:path';
import { lazyBytes } from './bytes.mjs';
import { checkInlineMaps, checkMapFile, findMapReferences } from './checks/sourcemaps.mjs';
import { isScript } from './rules.mjs';
import { finishResult, MAX_FILE_BYTES, ScanError, scanLargeMap, startResult } from './scan.mjs';
import { toShown, toShownText } from './text.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
// A map can be far larger than the code it maps. One up to this size is downloaded, given the
// time that takes, and one larger than a code file is read a stretch at a time, as a large map
// on disk is.
const MAX_MAP_BYTES = 256 * 1024 * 1024;
const MAP_TIMEOUT_MS = 120_000;
const CODE_LIMITS = { mostBytes: MAX_FILE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS };
const MAP_LIMITS = { mostBytes: MAX_MAP_BYTES, timeoutMs: MAP_TIMEOUT_MS };
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
// Why a file of the site could not be used is the message of the error thrown for it: a
// short code such as this one or 'HTTP 404'.
const TOO_LARGE = 'TOO_LARGE';

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
  const html = await fetchPage(pageAddress);
  // A site may answer from another address than the one typed (www, https). That one is home.
  const page = html.address;
  const result = startResult({
    root: page.href,
    isDeployed: true,
    targets: [page.href],
    targetsPickedByName: false,
    serverBuilds: [],
    frameworks: [],
  });
  // A file that is not there, or does not answer, is no finding. One too large to read is
  // put on the same list the local scan puts one on.
  const read = async (address, limits) => {
    try {
      return await fetchFile(address, page.origin, limits);
    } catch (error) {
      if (error.message === TOO_LARGE) result.skippedLargeFiles.push(address.pathname);
      return null;
    }
  };
  const { ownAssets, otherOriginCount } = listCodeAssets(html.text.slice(0, MAX_PAGE_CHARACTERS), page);
  result.filesSeen = ownAssets.length;
  result.skippedOtherOrigins = otherOriginCount;
  const addFindings = (findings) => {
    for (const finding of findings) result.findings.push({ ...toShown(finding), diskPath: null });
  };

  const checkedMaps = new Set();
  for (const asset of ownAssets.slice(0, MAX_ASSETS)) {
    const code = await read(asset, CODE_LIMITS);
    if (!code) continue;
    result.filesScanned += 1;
    if (isScript(extname(asset.pathname).toLowerCase())) result.scriptsScanned += 1;
    addFindings(checkInlineMaps(asset.pathname, code.text));

    for (const mapAddress of listMapCandidates(code)) {
      if (mapAddress.origin !== page.origin || checkedMaps.has(mapAddress.href)) continue;
      checkedMaps.add(mapAddress.href);
      const map = await read(mapAddress, MAP_LIMITS);
      // A single-page app answers unknown paths with its HTML; that does not parse as a map.
      if (map) addFindings(checkMap(mapAddress.pathname, map.bytes));
    }
  }
  return finishResult(result);
}

/** The page itself has to be read, so a failure here ends the check and says why. */
async function fetchPage(pageAddress) {
  const unreachable = (reason) => new ScanError('page-unreachable', pageAddress, { reason });
  const requested = toAddress(pageAddress);
  if (!requested) throw unreachable('INVALID_ADDRESS');
  try {
    return await fetchFile(requested, null, CODE_LIMITS);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw unreachable('TIMEOUT');
    // Node wraps a network error in "fetch failed" and keeps underneath the system's code
    // for it, or for a request it refuses to make (a blocked port, say) a few words. An
    // answer that could not be used carries its own short code as the message.
    const cause = error.cause ?? error;
    throw unreachable(toShownText(String(cause.code ?? cause.message)));
  }
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

/** A map's findings, read whole when it is no larger than a code file and a stretch at a time when it is. */
function checkMap(path, bytes) {
  if (bytes.length <= MAX_FILE_BYTES) return checkMapFile(path, bytes.toString('utf8'));
  // A site's maps are not searched for `.env` values: those are looked for where the files are.
  return scanLargeMap(path, lazyBytes(bytes.length, () => bytes), []);
}

/**
 * @param {URL} address
 * @param {string | null} homeOrigin the one site the file may be read from, or null for the page itself
 * @param {{ mostBytes: number, timeoutMs: number }} limits
 * @returns {Promise<{ bytes: Buffer, text: string, sourceMapHeader: string | null, address: URL }>}
 *   `address` is where the file was finally read from
 * @throws when the server answered with something that cannot be used, with a short code
 *   as the message, and whatever `fetch` throws when it did not answer
 */
async function fetchFile(address, homeOrigin, limits) {
  const response = await request(address, homeOrigin, limits.timeoutMs);
  if (!response) throw new Error('LEFT_THE_SITE');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readCapped(response, limits.mostBytes);
  if (bytes === null) throw new Error(TOO_LARGE);
  // ECMA-426 section 11.1.1: `sourcemap` is the header, `x-sourcemap` its deprecated name.
  const sourceMapHeader = response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap');
  let text;
  return {
    bytes,
    // Decoded once, when first asked for: a map is read as bytes and never is.
    get text() {
      text ??= bytes.toString('utf8');
      return text;
    },
    sourceMapHeader,
    address: new URL(response.url),
  };
}

/**
 * One GET. The page itself may be redirected anywhere. A file of the page is followed by
 * hand, and only while it stays on the page's own site: a redirect is the served content
 * speaking, and it does not get to send the check to another address.
 *
 * @returns {Promise<Response | null>} null when a redirect leads away or never ends
 */
async function request(address, homeOrigin, timeoutMs) {
  let current = address;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
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

/** Reads a response body. @returns {Promise<Buffer | null>} null for one larger than `mostBytes` */
async function readCapped(response, mostBytes) {
  // A server that states the size up front spares the download of what would be dropped anyway.
  if (Number(response.headers.get('content-length')) > mostBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > mostBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
