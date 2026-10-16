// Checks that need only a name, so they also cover files too large or too binary to read.

const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist|defaults?)$/i;
const KEY_FILE_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc', '.htpasswd']);
const KEY_FILE_EXTENSIONS = new Set(['.p12', '.pfx', '.jks', '.keystore']);
const DATABASE_EXTENSIONS = new Set(['.sql', '.sqlite', '.sqlite3', '.db', '.dump', '.bak']);
// Not application data: the thumbnail cache Windows writes next to images, and the build
// state the Swift package manager keeps in its working folder.
const HARMLESS_DATABASE_NAMES = new Set(['Thumbs.db', 'build.db']);
// The Finder writes a `.DS_Store` into each folder it shows, with the names of the files in it.
// On a website anyone can fetch it, and with it the names of files nothing links to.
const FINDER_DATA_NAME = '.DS_Store';
const STRAY_SEVERITY = {
  env: 'critical',
  git: 'critical',
  'key-file': 'critical',
  database: 'high',
  'debug-symbols': 'high',
  'finder-data': 'medium',
};

const ALWAYS_SOURCE_EXTENSIONS = new Set(['.tsx', '.vue', '.svelte']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEVELOPER_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.py', '.sh', '.rb', '.pl', '.ps1']);
// Disk images, installers and archives hold the real files inside. A file named like one
// is opened when it turns out to be a ZIP, and is otherwise listed as not opened. A lone
// compressed file such as `app.js.gz` is not one of them.
const SEALED_CONTAINER =
  /\.(?:dmg|pkg|xip|iso|zip|ipa|apk|aab|jar|7z|rar|msi|msix|appx|deb|rpm|appimage|tar|tgz|tar\.(?:gz|bz2|xz|zst))$/i;
// Formats in which a search of the bytes has nothing to find: pictures, sound, video and
// fonts hold no text, and what a compressed file holds cannot be seen in its bytes.
const TEXTLESS_EXTENSIONS = new Set(
  [
    ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.ico', '.icns', '.bmp', '.tif', '.tiff'],
    ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac'],
    ['.woff', '.woff2', '.ttf', '.otf', '.ttc', '.pdf', '.gz', '.br', '.zst', '.xz', '.bz2'],
  ].flat(),
);

/**
 * A file that should never be part of what ships: settings with secrets, key stores, data dumps.
 *
 * @param {{ path: string, name: string, extension: string }} file
 */
export function checkStrayFile({ path, name, extension }) {
  const kind = strayFileKind(name, extension);
  return kind ? [strayFinding(path, kind)] : [];
}

/** A whole directory that should never ship. It is reported once and not looked into. */
export function checkStrayDirectory({ path, name }) {
  const kind = strayDirectoryKind(name);
  return kind ? [strayFinding(path, kind)] : [];
}

/** @returns {'git' | 'debug-symbols' | null} null for a directory that may ship */
export function strayDirectoryKind(name) {
  if (name === '.git') return 'git';
  if (name.endsWith('.dSYM')) return 'debug-symbols';
  return null;
}

/**
 * Source and test files that a build should have left behind.
 *
 * @param {{ path: string, name: string, extension: string, isInsideAsar: boolean }} file
 */
export function checkUnshippedSource({ path, name, extension, isInsideAsar }) {
  const segments = path.split('/');
  if (TEST_FILE.test(name) || segments.includes('__tests__')) return [sourceFinding(path, 'test')];
  if (ALWAYS_SOURCE_EXTENSIONS.has(extension)) return [sourceFinding(path, 'source')];
  // On a website `.ts` is usually a video segment, also when the site is in a ZIP. In an
  // Electron app's ASAR, which holds its code, or under `src` it is TypeScript.
  const isTypeScript = extension === '.ts' && !name.endsWith('.d.ts');
  if (isTypeScript && (isInsideAsar || segments.includes('src'))) return [sourceFinding(path, 'source')];
  return [];
}

/**
 * Notes and scripts written for whoever works on the project. Some ship on purpose, so
 * this is a note to review, not a leak.
 *
 * @param {{ path: string, extension: string }} file
 */
export function checkDeveloperFile({ path, extension }) {
  if (!DEVELOPER_FILE_EXTENSIONS.has(extension)) return [];
  return [{ rule: 'developer-file', severity: 'info', path, detail: {} }];
}

/** Whether a file is named like a container. One that is a ZIP is opened; any other is listed as not opened. */
export function isSealedContainer(name) {
  return SEALED_CONTAINER.test(name);
}

/**
 * Whether a file is of a kind that reading would tell nothing about. Every other file is
 * read. An archive compressed as a whole, a `.tar.gz`, is named like a compressed file and
 * is a container all the same.
 *
 * @param {{ name: string, extension: string }} file
 */
export function isTextless({ name, extension }) {
  return TEXTLESS_EXTENSIONS.has(extension) && !isSealedContainer(name);
}

/** A dotenv file that holds real values, as opposed to a template with the values left blank. */
export function isEnvFileName(name) {
  return name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATE_SUFFIX.test(name));
}

function strayFileKind(name, extension) {
  if (isEnvFileName(name)) return 'env';
  if (KEY_FILE_NAMES.has(name) || KEY_FILE_EXTENSIONS.has(extension)) return 'key-file';
  if (DATABASE_EXTENSIONS.has(extension) && !HARMLESS_DATABASE_NAMES.has(name)) return 'database';
  if (name === FINDER_DATA_NAME) return 'finder-data';
  return null;
}

function strayFinding(path, kind) {
  return { rule: 'stray-file', severity: STRAY_SEVERITY[kind], path, detail: { kind } };
}

function sourceFinding(path, kind) {
  return { rule: 'unshipped-source', severity: 'medium', path, detail: { kind } };
}
