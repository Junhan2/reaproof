import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { openAsar } from './asar.mjs';
import { checkStrayDirectory, strayDirectoryKind } from './checks/paths.mjs';
import { checkElectronFuses, electronBinaryIn } from './electron.mjs';
import { checkEnvValues, readEnvSecrets } from './env.mjs';
import { checkAppBundle, isAppBundleName } from './macos.mjs';
import { archiveFinding, checkFile, checkPath, hasContentChecks, summarizeFindings } from './rules.mjs';
import { toShown, toShownText } from './text.mjs';

// Where common toolchains put what actually ships. For Next.js only `.next/static` reaches browsers.
const KNOWN_OUTPUT_DIRS = ['.next/static', 'out', 'dist', 'build', 'release', '.output/public'];
// The most that is read of one file, on disk, in an archive or from a deployed site.
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const FRAMEWORK_BY_PACKAGE = { next: 'next', vite: 'vite', 'react-scripts': 'cra', electron: 'electron' };
const PACKAGE_MANAGER_BY_LOCKFILE = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** A problem with what the user pointed at, as opposed to a bug in the scan. */
export class ScanError extends Error {
  /**
   * @param {'path-not-found' | 'no-build-output' | 'build-failed' | 'page-unreachable' | 'local-only'} code
   * @param {string[] | null} [buildCommand] the command that would produce the missing output, when known
   */
  constructor(code, path, buildCommand) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
    this.buildCommand = buildCommand;
  }
}

/**
 * Finds the shipped output under a project, or accepts the path itself when it is the output.
 *
 * @param {string} root absolute path
 * @returns {string[]} absolute paths of directories or archives to scan
 */
export function resolveTargets(root) {
  if (!existsSync(root)) throw new ScanError('path-not-found', root);
  if (statSync(root).isFile()) return [root];

  const outputDirs = KNOWN_OUTPUT_DIRS.map((dir) => join(root, dir)).filter(isDirectory);
  if (outputDirs.length > 0) return outputDirs;
  // A project root without output would only "find" the developer's own source tree.
  if (existsSync(join(root, 'package.json'))) {
    throw new ScanError('no-build-output', root, findBuildCommand(root));
  }
  return [root];
}

/**
 * How a path is shown: relative to what the user pointed at, or by its own name when it is
 * that. Always written with `/`, like a path inside an archive or on a site, so a report
 * reads the same on every system and the name checks can split it. It is for showing only:
 * a file name is written by whoever made the build, so it is cleaned on the way.
 */
export function toDisplayPath(root, path) {
  return toShownText((relative(root, path) || basename(path)).split(sep).join('/'));
}

/**
 * The result every scan starts from, so the reporter reads one shape wherever the files were.
 *
 * @param {{ root: string, targets: string[], frameworks: string[] }} subject what was looked at
 */
export function startResult(subject) {
  return { ...subject, findings: [], filesScanned: 0, skippedLargeFiles: [], unreadableArchives: [] };
}

/**
 * Reads shipped files the way an analysis tool would and reports what they give away.
 *
 * @param {string} inputPath project root, output directory, packaged app or `.asar` archive
 */
export function scan(inputPath) {
  const root = resolve(inputPath);
  const result = startResult({ root, targets: resolveTargets(root), frameworks: detectFrameworks(root) });
  const state = { result, envSecrets: readEnvSecrets(root), outermostApp: null };

  for (const target of result.targets) {
    // What was pointed at is an entry like any other, so it gets the checks its kind gets.
    const pointedAt = { path: target, name: basename(target), isDirectory: statSync(target).isDirectory() };
    for (const { path, isDirectory } of walk(pointedAt, listDisk)) {
      const displayPath = toDisplayPath(root, path);
      if (isDirectory) scanDirectory(path, displayPath, state);
      else scanDiskFile(path, displayPath, state);
    }
  }
  return Object.assign(result, summarizeFindings(result.findings));
}

/**
 * The scan result as it stands once some scanned files have left the output, without
 * reading the rest of the output a second time. This holds because every finding is about
 * one file by itself: no check carries anything over from one file to the next.
 *
 * @param {string[]} removedPaths absolute paths
 */
export function withoutFiles(scanResult, removedPaths) {
  const removed = new Set(removedPaths);
  const findings = scanResult.findings.filter(({ diskPath }) => !removed.has(diskPath));
  return {
    ...scanResult,
    findings,
    filesScanned: scanResult.filesScanned - removed.size,
    ...summarizeFindings(findings),
  };
}

function scanDirectory(directory, displayPath, state) {
  const name = basename(directory);
  addFindings(state, checkStrayDirectory({ path: displayPath, name }), directory);
  const electronBinary = electronBinaryIn(directory, name);
  if (electronBinary) addFindings(state, checkElectronFuses(displayPath, electronBinary), electronBinary);
  // Helper apps nested inside a bundle are signed along with it; the outer one speaks for them.
  // A directory arrives before what is inside it, so a helper sits inside the last outer app seen.
  const isNestedApp = state.outermostApp !== null && directory.startsWith(state.outermostApp + sep);
  if (isAppBundleName(name) && !isNestedApp) {
    state.outermostApp = directory;
    addFindings(state, checkAppBundle(displayPath, directory), directory);
  }
}

function scanDiskFile(file, displayPath, state) {
  const name = basename(file);
  const extension = extname(name).toLowerCase();
  addFindings(state, checkPath({ path: displayPath, name, extension, isInsideArchive: false }), file);

  if (extension === '.asar') {
    scanArchive(file, displayPath, state);
  } else if (extension === '.exe') {
    // On Windows the fuses sit in the app's own executable.
    addFindings(state, checkElectronFuses(displayPath, file), file);
  } else if (hasContentChecks(extension)) {
    const readText = () => readFileSync(file, 'utf8');
    scanContent({ displayPath, extension, diskPath: file, bytes: statSync(file).size, readText }, state);
  }
}

function scanArchive(archivePath, displayPath, state) {
  let archive;
  try {
    archive = openAsar(archivePath);
    addFindings(state, [archiveFinding(displayPath, archive.fileCount)], null);
    for (const inner of walk(archive.root, archive.list)) {
      const innerDisplayPath = toShownText(`${displayPath}:/${inner.path}`);
      if (inner.isDirectory) {
        addFindings(state, checkStrayDirectory({ path: innerDisplayPath, name: inner.name }), null);
        continue;
      }
      const extension = extname(inner.name).toLowerCase();
      const file = { path: innerDisplayPath, name: inner.name, extension, isInsideArchive: true };
      addFindings(state, checkPath(file), null);
      if (!hasContentChecks(extension)) continue;
      const readText = () => archive.read(inner).toString('utf8');
      scanContent({ displayPath: innerDisplayPath, extension, diskPath: null, bytes: inner.size, readText }, state);
    }
  } catch {
    state.result.unreadableArchives.push(displayPath);
  } finally {
    archive?.close();
  }
}

/** The size limit, the count and the checks are the same wherever the bytes come from. */
function scanContent({ displayPath, extension, diskPath, bytes, readText }, state) {
  if (bytes > MAX_FILE_BYTES) {
    state.result.skippedLargeFiles.push(displayPath);
    return;
  }
  // Counted before reading, so a file that cannot be read still shows as attempted.
  state.result.filesScanned += 1;
  const text = readText();
  addFindings(state, checkFile({ path: displayPath, extension, text }), diskPath);
  addFindings(state, checkEnvValues(displayPath, text, state.envSecrets), diskPath);
}

/** Everything a finding quotes from a file is cleaned here; `diskPath` stays exact, for acting on the file. */
function addFindings(state, findings, diskPath) {
  for (const finding of findings) state.result.findings.push({ ...toShown(finding), diskPath });
}

/**
 * Yields an entry and then everything under it, each directory before what is inside it.
 * `list` says what sits directly inside a directory, so the rules about what to enter are
 * the same on disk and inside an archive: an opaque directory is yielded but not entered.
 *
 * @param {{ name: string, isDirectory: boolean }} entry
 * @param {(directory: object) => { name: string, isDirectory: boolean }[]} list
 */
function* walk(entry, list) {
  yield entry;
  if (!entry.isDirectory || isOpaqueDirectory(entry.name)) return;
  for (const child of list(entry)) {
    // Dependencies are public code, and their docs and tests carry example keys.
    if (child.isDirectory && child.name === 'node_modules') continue;
    yield* walk(child, list);
  }
}

function listDisk({ path }) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => ({ path: join(path, entry.name), name: entry.name, isDirectory: entry.isDirectory() }));
}

/** A stray directory is reported whole; a framework is read only for its fuses. */
function isOpaqueDirectory(name) {
  return strayDirectoryKind(name) !== null || name.endsWith('.framework');
}

/** @returns {string[] | null} the command that builds this project, for example ['pnpm', 'run', 'build'] */
function findBuildCommand(root) {
  if (!readManifest(root)?.scripts?.build) return null;
  const lockfile = PACKAGE_MANAGER_BY_LOCKFILE.find(([name]) => existsSync(join(root, name)));
  return [lockfile ? lockfile[1] : 'npm', 'run', 'build'];
}

function detectFrameworks(root) {
  const manifest = readManifest(root);
  const installed = { ...manifest?.dependencies, ...manifest?.devDependencies };
  return Object.entries(FRAMEWORK_BY_PACKAGE)
    .filter(([packageName]) => packageName in installed)
    .map(([, framework]) => framework);
}

/** @returns {Record<string, any> | null} null when there is no package.json here or it does not parse */
function readManifest(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' ? manifest : null;
  } catch {
    return null;
  }
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}
