// Checks that need only a name, so they also cover files too large or too binary to read.

const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist|defaults?)$/i;
const KEY_FILE_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc', '.htpasswd']);
const KEY_FILE_EXTENSIONS = new Set(['.p12', '.pfx', '.jks', '.keystore']);
const DATABASE_EXTENSIONS = new Set(['.sql', '.sqlite', '.sqlite3', '.db', '.dump', '.bak']);
// Windows writes this thumbnail cache next to images; it is not application data.
const HARMLESS_DATABASE_NAMES = new Set(['Thumbs.db']);
const STRAY_SEVERITY = { env: 'critical', git: 'critical', 'key-file': 'critical', database: 'high', 'debug-symbols': 'high' };

const ALWAYS_SOURCE_EXTENSIONS = new Set(['.tsx', '.vue', '.svelte']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

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
 * @param {{ path: string, name: string, extension: string, isInsideArchive: boolean }} file
 */
export function checkUnshippedSource({ path, name, extension, isInsideArchive }) {
  const segments = path.split('/');
  if (TEST_FILE.test(name) || segments.includes('__tests__')) return [sourceFinding(path, 'test')];
  if (ALWAYS_SOURCE_EXTENSIONS.has(extension)) return [sourceFinding(path, 'source')];
  // On a website `.ts` is usually a video segment; inside an app or under `src` it is TypeScript.
  const isTypeScript = extension === '.ts' && !name.endsWith('.d.ts');
  if (isTypeScript && (isInsideArchive || segments.includes('src'))) return [sourceFinding(path, 'source')];
  return [];
}

/** A dotenv file that holds real values, as opposed to a template with the values left blank. */
export function isEnvFileName(name) {
  return name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATE_SUFFIX.test(name));
}

function strayFileKind(name, extension) {
  if (isEnvFileName(name)) return 'env';
  if (KEY_FILE_NAMES.has(name) || KEY_FILE_EXTENSIONS.has(extension)) return 'key-file';
  if (DATABASE_EXTENSIONS.has(extension) && !HARMLESS_DATABASE_NAMES.has(name)) return 'database';
  return null;
}

function strayFinding(path, kind) {
  return { rule: 'stray-file', severity: STRAY_SEVERITY[kind], path, detail: { kind } };
}

function sourceFinding(path, kind) {
  return { rule: 'unshipped-source', severity: 'medium', path, detail: { kind } };
}
