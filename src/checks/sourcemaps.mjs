const MAX_SAMPLE_SOURCES = 5;
// A map too large to read whole is searched for these keys, a stretch at a time. In the
// source text a map carries, a quote is escaped, so these do not match inside it.
const SOURCES_KEY = Buffer.from('"sources"');
const CONTENT_KEY = Buffer.from('"sourcesContent"');
// How much is read at a time when what follows a key runs past the stretch it was found in.
const READ_AHEAD_BYTES = 64 * 1024;
const JSON_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const [QUOTE, COMMA, COLON, OPENING_BRACKET, N, U, L] = Array.from('",:[nul', (character) => character.charCodeAt(0));

/** Map files that stand on their own in the output, as opposed to maps embedded in code. */
export const STANDALONE_MAP_RULES = new Set(['sourcemap-sources', 'sourcemap-names']);
export const SOURCE_MAP_RULES = new Set([...STANDALONE_MAP_RULES, 'sourcemap-inline']);

// ECMA-426 section 11.1.2: generators emit `//#`, consumers also accept the legacy `//@`.
// CSS carries the same annotation inside a block comment.
// The lookbehind skips an annotation that begins inside the unbroken run of an earlier one
// written without spaces. That one reads to the same end, so starting again here can find
// nothing new, and without the skip a run of repeated annotations is read once per repeat.
const SOURCE_MAP_ANNOTATION =
  /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=(?<!(?:\/\/|\/\*)[#@]sourceMappingURL=\S*?(?:\/\/|\/\*)[#@]sourceMappingURL=)(\S+?)\s*(?:\*\/\s*)?$/gm;

export function checkMapFile(path, text) {
  const summary = summarizeSourceMap(text);
  if (!summary) return [];
  return [mapFinding(summary.embeddedCount > 0 ? 'sourcemap-sources' : 'sourcemap-names', path, summary)];
}

/** What a map too large to read whole has shown so far, read a stretch at a time. */
export function startLargeMap() {
  return { carriesSource: false, namesSources: false };
}

/**
 * Looks in one stretch of a large map for a `sourcesContent` that holds source text and a
 * `sources` that holds a name. A key that lay whole in the overlap with the stretch before
 * was looked at there.
 *
 * @param {import('../bytes.mjs').ByteSource} source
 * @param {{ position: number, bytes: Buffer }} stretch
 */
export function collectLargeMap(source, { position, bytes }, overlapBytes, found) {
  for (const [key, field] of [[CONTENT_KEY, 'carriesSource'], [SOURCES_KEY, 'namesSources']]) {
    const firstNew = position === 0 ? 0 : Math.max(0, overlapBytes - key.length + 1);
    for (let at = bytes.indexOf(key, firstNew); at !== -1 && !found[field]; at = bytes.indexOf(key, at + 1)) {
      found[field] = arrayHoldsText(source, bytes, position, position + at + key.length);
    }
  }
}

/** A large map is reported as a smaller one is, without the count of the files it names or carries. */
export function checkLargeMap(path, { carriesSource, namesSources }) {
  if (!carriesSource && !namesSources) return [];
  return [
    {
      rule: carriesSource ? 'sourcemap-sources' : 'sourcemap-names',
      severity: mapSeverity(carriesSource),
      path,
      detail: { sourceCount: null, embeddedCount: null, sampleSources: [] },
    },
  ];
}

/**
 * Whether the array that follows a key holds a string with something in it, as opposed to
 * nothing but nulls and empty strings. It is read from the bytes in hand and, past their end,
 * from the file, until it can tell.
 */
function arrayHoldsText(source, bytes, position, from) {
  let block = bytes;
  let blockStart = position;
  const byteAt = (place) => {
    if (place < blockStart || place >= blockStart + block.length) {
      blockStart = place;
      block = source.read(place, Math.min(READ_AHEAD_BYTES, source.byteLength - place));
    }
    return block[place - blockStart];
  };
  const end = source.byteLength;
  let at = from;
  const passSpace = () => {
    while (at < end && JSON_SPACE.has(byteAt(at))) at += 1;
  };
  passSpace();
  if (at >= end || byteAt(at) !== COLON) return false;
  at += 1;
  passSpace();
  if (at >= end || byteAt(at) !== OPENING_BRACKET) return false;
  at += 1;
  while (at < end) {
    const byte = byteAt(at);
    const isNull = byte === N && at + 4 <= end && byteAt(at + 1) === U && byteAt(at + 2) === L && byteAt(at + 3) === L;
    if (byte === COMMA || JSON_SPACE.has(byte)) at += 1;
    else if (isNull) at += 4;
    else if (byte === QUOTE && at + 1 < end && byteAt(at + 1) === QUOTE) at += 2;
    else return byte === QUOTE;
  }
  return false;
}

/** A map that carries the original source gives it away; one that only names the files, less. */
function mapSeverity(carriesSource) {
  return carriesSource ? 'critical' : 'medium';
}

/** A map appended to the bundle as a data URI ships inside the code file itself. */
export function checkInlineMaps(path, text) {
  const findings = [];
  for (const url of findMapAnnotations(text)) {
    if (!url.startsWith('data:')) continue;
    const summary = summarizeSourceMap(decodeDataUri(url));
    if (summary) findings.push(mapFinding('sourcemap-inline', path, summary));
  }
  return findings;
}

/** Addresses of separate map files a code file points at, for a caller that has to fetch them. */
export function findMapReferences(text) {
  return findMapAnnotations(text).filter((url) => !url.startsWith('data:'));
}

function findMapAnnotations(text) {
  return Array.from(text.matchAll(SOURCE_MAP_ANNOTATION), ([, url]) => url);
}

function mapFinding(rule, path, { sources, embeddedCount }) {
  return {
    rule,
    severity: mapSeverity(embeddedCount > 0),
    path,
    detail: {
      sourceCount: sources.length,
      embeddedCount,
      sampleSources: sources.slice(0, MAX_SAMPLE_SOURCES),
    },
  };
}

/**
 * @param {string | null} text
 * @returns {{ sources: string[], embeddedCount: number } | null} null when the text is not a source map
 */
function summarizeSourceMap(text) {
  if (text === null) return null;
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return null;
  }
  if (map === null || typeof map !== 'object') return null;

  // An index map nests ordinary maps under `sections`.
  const parts = Array.isArray(map.sections) ? map.sections.map((section) => section?.map) : [map];
  const sources = [];
  let embeddedCount = 0;
  for (const part of parts) {
    if (!Array.isArray(part?.sources)) continue;
    // A large app lists more sources than a single spread call can take as arguments.
    for (const source of part.sources) {
      if (typeof source === 'string') sources.push(source);
    }
    const contents = Array.isArray(part.sourcesContent) ? part.sourcesContent : [];
    embeddedCount += contents.filter((content) => typeof content === 'string' && content.length > 0).length;
  }
  return sources.length > 0 || embeddedCount > 0 ? { sources, embeddedCount } : null;
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const mediaType = uri.slice('data:'.length, comma);
  const payload = uri.slice(comma + 1);
  try {
    return /;base64$/i.test(mediaType)
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}
