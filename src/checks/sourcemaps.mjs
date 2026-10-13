const MAX_SAMPLE_SOURCES = 5;

/** Map files that stand on their own in the output, as opposed to maps embedded in code. */
export const STANDALONE_MAP_RULES = new Set(['sourcemap-sources', 'sourcemap-names']);
export const SOURCE_MAP_RULES = new Set([...STANDALONE_MAP_RULES, 'sourcemap-inline']);

// ECMA-426 section 11.1.2: generators emit `//#`, consumers also accept the legacy `//@`.
// CSS carries the same annotation inside a block comment.
const SOURCE_MAP_ANNOTATION = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=(\S+?)\s*(?:\*\/\s*)?$/gm;

export function checkMapFile(path, text) {
  const summary = summarizeSourceMap(text);
  if (!summary) return [];
  return [mapFinding(summary.embeddedCount > 0 ? 'sourcemap-sources' : 'sourcemap-names', path, summary)];
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
    severity: embeddedCount > 0 ? 'critical' : 'medium',
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
