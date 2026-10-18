// A build that renders pages on a server: what of it reaches browsers, and what browsers are
// sent from the code that stays on the server.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isScript } from './rules.mjs';

// Such a build puts what browsers load beside its own server: `client` next to `server`, as
// SvelteKit's Node adapter, React Router and Astro write it, or `public` next to `server`, as
// Nuxt does. SvelteKit keeps its prerendered pages in `prerendered` beside them.
const BROWSER_HALVES = ['client', 'public'];
const PRERENDERED = 'prerendered';
const SERVER_HALF = 'server';

// Astro writes the scripts it puts into the pages it renders into the manifest of its server
// build, as JSON: `inlinedScripts`, each an id and the code. Nuxt writes the runtime config
// into its server build, as JSON, and puts its `public` part into every page it sends.
const SERVER_SENT = [
  { framework: 'astro', marker: 'deserializeManifest({', read: astroScripts },
  { framework: 'nuxt', marker: 'const _inlineRuntimeConfig = {', read: nuxtPublicConfig },
];
// Bounds on looking through a server build for those: each sits in one file of a few hundred
// kilobytes among some dozens. A file larger than this is not one of them.
const MAX_SERVER_FILES = 2000;
const MAX_SERVER_FILE_BYTES = 30 * 1024 * 1024;
const MAX_SERVER_BYTES = 512 * 1024 * 1024;

/**
 * The folders of an output folder that reach browsers, when it is a server-rendering build:
 * its browser half and its prerendered pages. Null when it is not one, and reaches them whole.
 *
 * @param {string} folder absolute path
 * @returns {string[] | null}
 */
export function browserPartsOf(folder) {
  if (!isDirectory(join(folder, SERVER_HALF))) return null;
  const halves = BROWSER_HALVES.filter((half) => isDirectory(join(folder, half)));
  if (halves.length === 0) return null;
  return [...halves, PRERENDERED].map((part) => join(folder, part)).filter(isDirectory);
}

/**
 * What the server of such a build sends to browsers that is written into its own code: the
 * scripts Astro puts into the pages it renders, and the public runtime config Nuxt puts into
 * each page. They come back by the file they sit in, each piece as text with a name for it
 * inside that file. `isWhole` is false when a framework's part was not found, or not in the
 * form it is read in: a release that writes it another way is not to be read as clean.
 *
 * @param {string} folder absolute path of the output folder
 * @param {string[]} frameworks
 * @returns {{ sent: { path: string, pieces: { inner: string, text: string }[] }[], isWhole: boolean }}
 */
export function readServerSent(folder, frameworks) {
  let wanted = SERVER_SENT.filter(({ framework }) => frameworks.includes(framework));
  const sent = [];
  let isWhole = true;
  if (wanted.length === 0) return { sent, isWhole };
  let budget = MAX_SERVER_BYTES;
  for (const path of serverCodeFiles(join(folder, SERVER_HALF))) {
    if (wanted.length === 0 || budget <= 0) break;
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      // One that cannot be read is passed over; if what is looked for sat in it, that shows.
      continue;
    }
    budget -= bytes.length;
    // The markers are ASCII: they are looked for in the bytes, and only a file that holds one is decoded.
    const found = wanted.filter(({ marker }) => bytes.includes(marker));
    if (found.length === 0) continue;
    const text = bytes.toString('utf8');
    for (const { marker, read } of found) {
      const pieces = read(text, text.indexOf(marker) + marker.length - 1);
      if (pieces) sent.push({ path, pieces });
      else isWhole = false;
    }
    wanted = wanted.filter((one) => !found.includes(one));
  }
  return { sent, isWhole: isWhole && wanted.length === 0 };
}

/** @returns {{ inner: string, text: string }[] | null} null when the manifest is not in the form it is read in */
function astroScripts(text, start) {
  const manifest = readJsonObject(text, start);
  if (!Array.isArray(manifest?.inlinedScripts)) return null;
  const root = typeof manifest.rootDir === 'string' ? fileUrlPath(manifest.rootDir) : null;
  return manifest.inlinedScripts
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([id, code], index) => ({ inner: `${scriptName(id, root, index)}.js`, text: code }));
}

/** `/app/src/pages/index.astro?astro&type=script&index=0&lang.ts` as `src/pages/index.astro.script-1`. */
function scriptName(id, root, index) {
  const [file, query = ''] = id.split('?');
  const page = root && file.startsWith(root) ? file.slice(root.length) : file.split('/').pop();
  const number = /(?:^|&)index=(\d+)/.exec(query);
  return `${page}.script-${number ? Number(number[1]) + 1 : index + 1}`;
}

/** @returns {{ inner: string, text: string }[] | null} null when the config is not in the form it is read in */
function nuxtPublicConfig(text, start) {
  const config = readJsonObject(text, start);
  if (config?.public === null || typeof config?.public !== 'object') return null;
  return [{ inner: 'runtimeConfig.public.json', text: JSON.stringify(config.public, null, 2) }];
}

/** The JSON object that opens at `start`, or null where none does. */
function readJsonObject(text, start) {
  let depth = 0;
  let isInString = false;
  for (let at = start; at < text.length; at += 1) {
    const character = text[at];
    if (isInString) {
      if (character === '\\') at += 1;
      else if (character === '"') isInString = false;
    } else if (character === '"') isInString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, at + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function fileUrlPath(url) {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * The code files of a server build, up to the bound. A folder or a file that cannot be looked
 * at is passed over, and so are the dependencies a server build may carry, as Nuxt's does.
 */
function* serverCodeFiles(folder) {
  const toVisit = [folder];
  let count = 0;
  while (toVisit.length > 0) {
    const current = toVisit.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') toVisit.push(path);
      } else if (entry.isFile() && isScript(extname(entry.name)) && sizeOf(path) <= MAX_SERVER_FILE_BYTES) {
        if (count === MAX_SERVER_FILES) return;
        count += 1;
        yield path;
      }
    }
  }
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return Infinity;
  }
}

/** Whether a path is a folder that can be looked at. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
