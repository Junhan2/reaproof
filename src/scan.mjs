import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { openAsar } from './asar.mjs';
import { fileBytes, lazyBytes, readChunks } from './bytes.mjs';
import { checkStrayDirectory, isSealedContainer, isTextless, strayDirectoryKind } from './checks/paths.mjs';
import { checkSecrets, checkSecretsInBytes } from './checks/secrets.mjs';
import { checkElectronFuses } from './electron.mjs';
import { checkEnvValues, readEnvSecrets } from './env.mjs';
import { readMachO } from './macho.mjs';
import { checkMachO } from './macos.mjs';
import { isLinuxOrWindowsProgram } from './program.mjs';
import { archiveFinding, checkFile, checkPath, hasContentChecks, isScript, summarizeFindings } from './rules.mjs';
import { toShown, toShownText } from './text.mjs';

// Where JavaScript toolchains put what actually ships. For Next.js only `.next/static` reaches browsers.
const KNOWN_OUTPUT_DIRS = ['.next/static', 'out', 'dist', 'build', 'release', '.output/public'];
// What marks the root of a project in a language whose builds land wherever its developer says.
const NATIVE_PROJECT_FILE =
  /^(?:Package\.swift|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|pubspec\.yaml|CMakeLists\.txt|.+\.xcodeproj|.+\.xcworkspace)$/;
// The most that is read of one file held whole in memory: a text file, wherever it is, and
// any file inside an archive.
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
// The most that is searched of one file on disk as bytes. It is read a chunk at a time, so
// what this limits is time.
const MAX_SEARCHED_BYTES = 1024 * 1024 * 1024;
// A chunk read as text stays in V8's own heap, and is freed at once, only under about a
// megabyte: larger strings are kept outside the heap and pile up until it gets to them.
export const CHUNK_BYTES = 896 * 1024;
// Each chunk runs this far into the next, so a key across the join is whole in one of them,
// with what stands around it.
export const OVERLAP_BYTES = 64 * 1024;
// One file full of key-shaped bytes is noise or an attack, not that many keys.
const MAX_FINDINGS_IN_BYTES = 200;
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
   * @param {'path-not-found' | 'no-build-output' | 'artifact-needed' | 'build-failed' | 'page-unreachable' | 'local-only'} code
   * @param {{ buildCommand?: string[] | null, projectFile?: string, reason?: string }} [details]
   *   the command that would produce a missing output, the file that marks a project root,
   *   or why an address did not answer
   */
  constructor(code, path, details = {}) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

/**
 * Decides what to scan for the path someone gave. A folder with a package.json is a
 * JavaScript project, and what ships from one sits where its toolchain puts it. Anything
 * else is taken as the thing that ships. The exception is the root of a project in another
 * language: its builds land wherever its developer says, so the answer is asked for and
 * not guessed.
 *
 * @param {string} root absolute path
 * @returns {{ targets: string[], targetsPickedByName: boolean }} absolute paths of what to
 *   scan, and whether they were picked by folder name and not pointed at
 */
export function resolveTargets(root) {
  if (!existsSync(root)) throw new ScanError('path-not-found', root);
  if (statSync(root).isFile()) return { targets: [root], targetsPickedByName: false };

  if (existsSync(join(root, 'package.json'))) {
    const outputDirs = KNOWN_OUTPUT_DIRS.map((dir) => join(root, dir)).filter(isDirectory);
    // A project root without output would only "find" the developer's own source tree.
    if (outputDirs.length === 0) throw new ScanError('no-build-output', root, { buildCommand: findBuildCommand(root) });
    return { targets: outputDirs, targetsPickedByName: true };
  }
  const projectFile = readdirSync(root).find((name) => NATIVE_PROJECT_FILE.test(name));
  if (projectFile) throw new ScanError('artifact-needed', root, { projectFile });
  return { targets: [root], targetsPickedByName: false };
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
 * `filesSeen` counts every file met and `filesScanned` those read for their content, so a
 * file that was passed over shows in the difference whatever the reason. `scriptsScanned`
 * and `programsScanned` say how many of the files read were JavaScript and native programs.
 * The three lists name what could not be read for a reason worth telling.
 *
 * @param {{ root: string, targets: string[], targetsPickedByName: boolean, frameworks: string[] }} subject what was looked at
 */
export function startResult(subject) {
  return {
    ...subject,
    findings: [],
    filesSeen: 0,
    filesScanned: 0,
    scriptsScanned: 0,
    programsScanned: 0,
    skippedLargeFiles: [],
    unreadableArchives: [],
    unopenedContainers: [],
  };
}

/**
 * Closes a result with its risk and leak counts, which follow from what was found and from
 * whether what ships was read at all. It was not when nothing was read. Nor was it when a
 * container stayed unopened and no program or script was read beside it: what ships is
 * then most likely inside the container, whatever small files lie around it.
 */
export function finishResult(result) {
  const readCode = result.programsScanned + result.scriptsScanned > 0;
  const wasRead = result.filesScanned > 0 && (readCode || result.unopenedContainers.length === 0);
  return Object.assign(result, summarizeFindings(result.findings, wasRead));
}

/**
 * Reads shipped files the way an analysis tool would and reports what they give away.
 *
 * @param {string} inputPath project root, output directory, packaged app, program or `.asar` archive
 */
export function scan(inputPath) {
  const root = resolve(inputPath);
  const targets = resolveTargets(root);
  // What must not ship, and what built it, is said by the project the path belongs to, also
  // when the path given is the build output inside it.
  const project = findProjectFolder(root) ?? root;
  const result = startResult({ root, ...targets, frameworks: detectFrameworks(project) });
  const envSecrets = readEnvSecrets(project).map((secret) => ({
    ...secret,
    envFile: toDisplayPath(root, join(project, secret.envFile)),
  }));
  const state = { result, envSecrets };

  for (const target of result.targets) {
    // What was pointed at is an entry like any other, so it gets the checks its kind gets.
    const pointedAt = { path: target, name: basename(target), isDirectory: statSync(target).isDirectory() };
    for (const { path, name, isDirectory } of walk(pointedAt, listDisk)) {
      const displayPath = toDisplayPath(root, path);
      if (isDirectory) addFindings(state, checkStrayDirectory({ path: displayPath, name }), path);
      else scanFile({ displayPath, name, diskPath: path, open: (use) => openOnDisk(path, use) }, state);
    }
  }
  return finishResult(result);
}

/**
 * The nearest folder, the path itself or one above it, that holds a project file. The
 * search stops short of the home folder: a package.json left there would make everything
 * under it one project, and the `.env` beside it a file to read.
 */
function findProjectFolder(path) {
  const home = toRealPath(homedir());
  for (let folder = path; toRealPath(folder) !== home; folder = dirname(folder)) {
    if (listNames(folder).some((name) => name === 'package.json' || NATIVE_PROJECT_FILE.test(name))) return folder;
    if (dirname(folder) === folder) break;
  }
  return null;
}

/** A path as the system itself spells it, so that two spellings of one folder compare equal. */
function toRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** @returns {string[]} what a folder holds; nothing for a file, or a folder that cannot be listed */
function listNames(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
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
  return finishResult({
    ...scanResult,
    findings,
    filesSeen: scanResult.filesSeen - removed.size,
    filesScanned: scanResult.filesScanned - removed.size,
  });
}

/**
 * One file, wherever it sits. Its name decides how it is read, by the same rules on disk
 * and inside an archive: text gets every check, and whatever else can hold text is searched
 * as bytes.
 *
 * @param {object} file
 * @param {string | null} file.diskPath null for a file inside an archive
 * @param {(use: (source: import('./bytes.mjs').ByteSource) => void) => void} file.open hands
 *   the file's bytes to `use`, or does nothing when they cannot be had
 */
function scanFile({ displayPath, name, diskPath, open }, state) {
  const { result } = state;
  const extension = extname(name).toLowerCase();
  const isInsideArchive = diskPath === null;
  result.filesSeen += 1;
  addFindings(state, checkPath({ path: displayPath, name, extension, isInsideArchive }), diskPath);

  if (isSealedContainer(name)) {
    result.unopenedContainers.push(displayPath);
  } else if (extension === '.asar' && !isInsideArchive) {
    scanArchive(diskPath, displayPath, state);
  } else if (!isTextless(extension)) {
    const isText = hasContentChecks(extension);
    open((source) => {
      if (source.byteLength > (isText || isInsideArchive ? MAX_FILE_BYTES : MAX_SEARCHED_BYTES)) {
        result.skippedLargeFiles.push(displayPath);
        return;
      }
      result.filesScanned += 1;
      if (isText) scanText({ displayPath, extension, diskPath, source }, state);
      else scanBytes({ displayPath, diskPath, source }, state);
    });
  }
}

function openOnDisk(file, use) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    // A file that cannot be opened stays counted as met and not as read.
    return;
  }
  try {
    use(fileBytes(fd));
  } finally {
    closeSync(fd);
  }
}

function scanArchive(archivePath, displayPath, state) {
  let archive;
  try {
    archive = openAsar(archivePath);
    state.result.filesScanned += 1;
    addFindings(state, [archiveFinding(displayPath, archive.fileCount)], null);
    for (const inner of walk(archive.root, archive.list)) {
      const innerDisplayPath = toShownText(`${displayPath}:/${inner.path}`);
      if (inner.isDirectory) {
        addFindings(state, checkStrayDirectory({ path: innerDisplayPath, name: inner.name }), null);
      } else {
        const open = (use) => use(lazyBytes(inner.size, () => archive.read(inner)));
        scanFile({ displayPath: innerDisplayPath, name: inner.name, diskPath: null, open }, state);
      }
    }
  } catch {
    state.result.unreadableArchives.push(displayPath);
  } finally {
    archive?.close();
  }
}

function scanText({ displayPath, extension, diskPath, source }, state) {
  if (isScript(extension)) state.result.scriptsScanned += 1;
  const text = source.read(0, source.byteLength).toString('utf8');
  addFindings(state, checkFile({ path: displayPath, extension, text }), diskPath);
  addFindings(state, checkEnvValues(displayPath, text, state.envSecrets), diskPath);
}

/**
 * A file whose name does not say it is code is searched for keys a chunk at a time: a
 * program, bytecode, a data file, a script, a note. A native program has no file name to go
 * by and is known by how it opens. A Mach-O is also read for what it says about its own
 * names and signature, and Electron's binary for its fuses.
 */
function scanBytes({ displayPath, diskPath, source }, state) {
  const images = readMachO(source);
  // An object file is a step of a build, not a program anyone runs.
  if (images?.some(({ kind }) => kind !== 'other') || isLinuxOrWindowsProgram(source)) {
    state.result.programsScanned += 1;
  }

  if (images) addFindings(state, checkMachO(displayPath, images), diskPath);
  // The same thing sits in each architecture's build and where two chunks overlap, and is
  // one finding. Keys are told apart by the search itself; the rest by what they say.
  const seenKeys = new Set();
  const keys = [];
  const others = new Map();
  // A file with no zero byte in it is text, whatever it is called. In text a key stands
  // apart from what is around it; in other bytes it may sit between its neighbours or be
  // stored two bytes to a character. This is said of the file and not of a chunk of it: a
  // program can go a whole chunk without a zero byte, and is no more text there.
  const isText = !holdsZeroByte(source);
  const findKeys = isText ? checkSecrets : checkSecretsInBytes;
  for (const chunk of readChunks(source, CHUNK_BYTES, OVERLAP_BYTES)) {
    const place = {
      hasMoreBefore: chunk.position > 0,
      hasMoreAfter: chunk.position + chunk.bytes.length < source.byteLength,
    };
    const inThisChunk = [checkElectronFuses(displayPath, source, chunk)];
    for (const text of readAsText(chunk.bytes, isText)) {
      // What a finding quotes is a view into the text, and kept as it is would keep the
      // whole chunk in memory until the file is done. Findings leave here as copies.
      const found = findKeys(displayPath, text, place, seenKeys);
      if (found.length > 0) keys.push(...structuredClone(found));
      inThisChunk.push(checkEnvValues(displayPath, text, state.envSecrets));
    }
    for (const finding of inThisChunk.flat()) others.set(JSON.stringify(finding), finding);
    if (keys.length >= MAX_FINDINGS_IN_BYTES) break;
  }
  addFindings(state, [...keys.slice(0, MAX_FINDINGS_IN_BYTES), ...others.values()], diskPath);
}

function holdsZeroByte(source) {
  for (const { bytes } of readChunks(source, CHUNK_BYTES, 0)) {
    if (bytes.includes(0)) return true;
  }
  return false;
}

/**
 * Bytes as the text they may hold: one byte to a character and, unless they are text to
 * begin with, two bytes to a character starting on either byte, which is how Windows
 * programs, .NET and Hermes keep some of theirs.
 */
function* readAsText(bytes, isText) {
  yield bytes.toString('latin1');
  if (isText) return;
  yield bytes.toString('utf16le');
  yield bytes.subarray(1).toString('utf16le');
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
  // A directory that should never ship is reported whole and not looked into.
  if (!entry.isDirectory || strayDirectoryKind(entry.name) !== null) return;
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
