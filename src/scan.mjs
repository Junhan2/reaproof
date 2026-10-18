import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { checkAndroidPackage, checkDexClasses, checkHermes, collectDexClasses, findAndroidManifest, startDexClasses } from './android.mjs';
import { openAsar } from './asar.mjs';
import { fileBytes, lazyBytes, readChunks, utf16Text } from './bytes.mjs';
import { checkDebugFile, checkStrayDirectory, isSealedContainer, isTextless, strayDirectoryKind } from './checks/paths.mjs';
import { checkSecrets, checkSecretsInBytes, MAX_KEYS_IN_A_FILE } from './checks/secrets.mjs';
import { checkLargeMap, collectLargeMap, startLargeMap } from './checks/sourcemaps.mjs';
import { checkElectronFuses } from './electron.mjs';
import { checkElf, readElf } from './elf.mjs';
import { checkEnvValues, checkEnvValuesInBytes, readEnvSecrets } from './env.mjs';
import { checkGo, collectGo, startGo } from './go.mjs';
import { readIgnoreFile } from './ignore.mjs';
import { readMachO } from './macho.mjs';
import { checkMachO } from './macos.mjs';
import { checkPe, readPe } from './pe.mjs';
import { isLinuxOrWindowsProgram } from './program.mjs';
import { archiveFinding, checkFile, checkPath, hasContentChecks, isScript, isSourceMap, summarizeFindings } from './rules.mjs';
import { checkRustSourcePaths, collectRustSourcePaths, startRustSourcePaths } from './rust.mjs';
import { browserPartsOf, isDirectory, readServerSent } from './server-build.mjs';
import { isTarName, openTar } from './tar.mjs';
import { holdsTauriScreenCode } from './tauri.mjs';
import { INSIDE_ARCHIVE, toShown, toShownText } from './text.mjs';
import { checkWasm } from './wasm.mjs';
import { isZip, openZip } from './zip.mjs';

// Where JavaScript toolchains put what actually ships. For Next.js only `.next/static` reaches
// browsers. Of a server-rendering build in one of these, Nuxt's `.output` among them, only the
// part browsers load is read.
const KNOWN_OUTPUT_DIRS = ['.next/static', 'out', 'dist', 'build', 'release', '.output'];
// SvelteKit's own build, which its adapters copy from. Its default adapter writes nothing else
// on a machine that is not the platform it deploys to.
const FALLBACK_OUTPUT_DIRS = ['.svelte-kit/output'];
// What marks the root of a project in a language whose builds land wherever its developer says.
const NATIVE_PROJECT_FILE =
  /^(?:Package\.swift|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|pubspec\.yaml|CMakeLists\.txt|.+\.xcodeproj|.+\.xcworkspace)$/;
// The most that is read of one text file, which is searched as one piece.
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
// The most that is searched of one file on disk as bytes. It is read a chunk at a time, so
// what this limits is time.
const MAX_SEARCHED_BYTES = 1024 * 1024 * 1024;
// A file inside an archive is held whole in memory while it is searched. The limit lets in
// the largest programs apps ship, such as Electron's own, and keeps out what would not fit.
const MAX_HELD_BYTES = 512 * 1024 * 1024;
// The most that is read out of one archive on disk, with everything nested in it. An
// archive can state far more than it weighs, so its own size bounds nothing.
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
// What looking at one file in an archive counts for, of that, however little the file
// holds. Archives can hold one another many times over, and would otherwise list files
// without end at no cost.
export const FILE_COST_BYTES = 2048;
// An archive in an archive in an archive is still opened. One more level down is left shut.
const MAX_ARCHIVE_DEPTH = 3;
// A chunk read as text stays in V8's own heap, and is freed at once, only under about a
// megabyte: larger strings are kept outside the heap and pile up until it gets to them.
export const CHUNK_BYTES = 896 * 1024;
// Each chunk runs this far into the next, so a key across the join is whole in one of them,
// with what stands around it.
export const OVERLAP_BYTES = 64 * 1024;
// What a folder answers when it is not ours to list.
const UNLISTABLE = new Set(['EACCES', 'EPERM']);
// Where JavaScript and Python keep the libraries a program is built on.
const DEPENDENCY_FOLDERS = new Set(['node_modules', 'site-packages', 'dist-packages']);
// Flutter keeps the files of the packages an app uses in `packages`, beside the manifests it
// writes of the app's assets: in `flutter_assets` in an app, in `assets` in a web build.
const FLUTTER_PACKAGES = 'packages';
const FLUTTER_ASSET_MANIFESTS = new Set(['AssetManifest.bin', 'AssetManifest.json', 'FontManifest.json']);
// React Native writes an app's code to one bundle, `index.android.bundle` or `main.jsbundle`
// unless the build names it otherwise, as JavaScript or, with Hermes, as bytecode. As
// JavaScript, which has no zero byte in it as Hermes's header has, it gets every check a `.js` file gets.
const SCRIPT_BUNDLE = /\.(?:bundle|jsbundle)$/;
// How a Linux and a Windows program open. Other files are not read for what those keep.
const ELF_OPENING = '\x7fELF';
const PE_OPENING = 'MZ';
const WASM_OPENING = '\0asm';
const FRAMEWORK_BY_PACKAGE = {
  next: 'next',
  vite: 'vite',
  astro: 'astro',
  nuxt: 'nuxt',
  'react-scripts': 'cra',
  electron: 'electron',
  '@tauri-apps/cli': 'tauri',
  '@tauri-apps/api': 'tauri',
};
// What these make is installed whole on a user's machine, any server in it included.
export const APP_FRAMEWORKS = new Set(['electron', 'tauri']);
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
 * @returns {{ targets: string[], targetsPickedByName: boolean, serverBuilds: string[] }}
 *   absolute paths of what to scan, whether they were picked by folder name and not pointed
 *   at, and the server-rendering builds among them, whose server part is not read
 */
export function resolveTargets(root) {
  if (!existsSync(root)) throw new ScanError('path-not-found', root);
  if (statSync(root).isFile()) return { targets: [root], targetsPickedByName: false, serverBuilds: [] };

  if (existsSync(join(root, 'package.json'))) {
    const found = KNOWN_OUTPUT_DIRS.map((dir) => join(root, dir)).filter(isDirectory);
    const outputDirs = found.length > 0 ? found : FALLBACK_OUTPUT_DIRS.map((dir) => join(root, dir)).filter(isDirectory);
    // A project root without output would only "find" the developer's own source tree.
    if (outputDirs.length === 0) throw new ScanError('no-build-output', root, { buildCommand: findBuildCommand(root) });
    return { ...toBrowserParts(outputDirs, keepsServerApart(root)), targetsPickedByName: true };
  }
  // A folder closed to this user is checked as it is, and named there as not read.
  const names = unlessUnlistable(() => readdirSync(root)) ?? [];
  const projectFile = names.find((name) => NATIVE_PROJECT_FILE.test(name));
  if (projectFile) throw new ScanError('artifact-needed', root, { projectFile });
  // The output folder of a server-rendering build, pointed at, is read as when it is picked by name.
  return { ...toBrowserParts([root], keepsServerApart(findProjectFolder(root))), targetsPickedByName: false };
}

/**
 * Whether the server of a project's build stays on a server. A website's does. All of an app's
 * output, Electron's or Tauri's, is installed on the user's machine, a server in it included.
 *
 * @param {string | null} project
 */
function keepsServerApart(project) {
  if (project === null || !existsSync(join(project, 'package.json'))) return false;
  return !detectFrameworks(project).some((framework) => APP_FRAMEWORKS.has(framework));
}

/**
 * Output folders as the folders of them that reach browsers. A server-rendering build is read
 * for its browser part, and is named among the server builds, whose server part is not read.
 */
function toBrowserParts(outputDirs, isServerApart) {
  const targets = [];
  const serverBuilds = [];
  for (const dir of outputDirs) {
    const parts = isServerApart ? browserPartsOf(dir) : null;
    targets.push(...(parts ?? [dir]));
    if (parts) serverBuilds.push(dir);
  }
  return { targets, serverBuilds };
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
 * file that was passed over shows in the difference whatever the reason. An archive that
 * was opened is one file read, and so is each file in it; `archivesOpened` says how many
 * of the files read were such archives. `scriptsScanned` and `programsScanned` say how many
 * were JavaScript and native programs. The lists name what could not be read for a reason
 * worth telling. `unreadScreenCode` names programs that were read and carry a screen inside
 * them that was not: a Tauri app's HTML and JavaScript. `serverBuilds` names the output folders
 * of server-rendering builds, of which only what browsers load was read, and `serverSent` what
 * was read out of their server code because the server puts it into the pages it sends;
 * `serverSentUnread` names those whose server code did not hold that in the form it is read in.
 *
 * @param {{ root: string, targets: string[], targetsPickedByName: boolean, serverBuilds: string[], frameworks: string[] }} subject what was looked at
 */
export function startResult(subject) {
  return {
    ...subject,
    findings: [],
    filesSeen: 0,
    filesScanned: 0,
    archivesOpened: 0,
    scriptsScanned: 0,
    programsScanned: 0,
    skippedLargeFiles: [],
    unreadableFiles: [],
    unreadableArchives: [],
    unopenedContainers: [],
    nestedTooDeep: [],
    unreadScreenCode: [],
    unreadableFolders: [],
    keysOnlyFiles: [],
    ignored: [],
    serverSent: [],
    serverSentUnread: [],
  };
}

/** How many files were met and not read for a reason that the result names them for. */
export function countLeftUnread(result) {
  return (
    result.unopenedContainers.length +
    result.nestedTooDeep.length +
    result.unreadableArchives.length +
    result.unreadableFiles.length +
    result.skippedLargeFiles.length
  );
}

/**
 * Closes a result with its risk and leak counts, which follow from what was found and from
 * whether what ships was read at all. It was not when no file's content was read: opening
 * an archive reads its list of files and nothing of what they hold. Nor was it when
 * something was left unread, shut or too large, and no program or script was read beside
 * it: what ships is then most likely in there, whatever small files lie around it.
 */
export function finishResult(result) {
  const readCode = result.programsScanned + result.scriptsScanned > 0;
  // A folder that could not be opened may hold anything, and a file searched for keys alone
  // may hold more than keys, such as a map appended to the code. Both count as left unread.
  const leftUnread = countLeftUnread(result) + result.unreadableFolders.length + result.keysOnlyFiles.length;
  const wasRead = result.filesScanned > result.archivesOpened && (readCode || leftUnread === 0);
  return Object.assign(result, summarizeFindings(result.findings, wasRead));
}

/**
 * Reads shipped files the way an analysis tool would and reports what they give away.
 *
 * @param {string} inputPath project root, output directory, packaged app, program or archive
 * @param {{ environment?: Record<string, string | undefined> }} [options] the environment the
 *   build ran in, whose secret values must not ship either: this process's, unless given
 */
export function scan(inputPath, { environment = process.env } = {}) {
  const root = resolve(inputPath);
  const targets = resolveTargets(root);
  // What must not ship, and what built it, is said by the project the path belongs to, also
  // when the path given is the build output inside it.
  const project = findProjectFolder(root) ?? root;
  const result = startResult({ root, ...targets, frameworks: detectFrameworks(project) });
  const envSecrets = readEnvSecrets(project, environment).map((secret) => ({
    ...secret,
    envFile: secret.envFile === null ? null : toDisplayPath(root, join(project, secret.envFile)),
  }));
  // What the project says to leave out is matched against each path as it is from the project
  // folder, as `.gitignore` is, and not as it is shown.
  const ignores = readIgnoreFile(project);
  const fromProject = (path) => relative(project, path).split(sep).join('/');
  const state = { result, envSecrets, ignores };
  const listOnDisk = (folder) => {
    const listed = unlessUnlistable(() => listDisk(folder));
    if (!listed) {
      result.unreadableFolders.push(toDisplayPath(root, folder.path));
      return [];
    }
    if (!ignores) return listed;
    // Each keeps the path it is matched by, for what an archive among them holds.
    return listed
      .map((child) => ({ ...child, matchedAs: fromProject(child.path) }))
      .filter((child) => !isIgnored(state, child.matchedAs, child, () => toDisplayPath(root, child.path)));
  };

  for (const target of result.targets) {
    // What was pointed at is an entry like any other, so it gets the checks its kind gets.
    const pointedAt = { path: target, name: basename(target), isDirectory: statSync(target).isDirectory() };
    if (ignores) pointedAt.matchedAs = fromProject(target);
    for (const { path, name, isDirectory, matchedAs = null } of walk(pointedAt, listOnDisk)) {
      const displayPath = toDisplayPath(root, path);
      if (isDirectory) addFindings(state, checkStrayDirectory({ path: displayPath, name }), path);
      else scanFile({ displayPath, name, diskPath: path, matchedAs, open: (use) => openOnDisk(path, use) }, state);
    }
  }
  // What a server puts into the pages it sends is browser code, wherever in its own code it sits.
  // Each piece is read as a file in an archive is, named by the file it sits in, and is left out
  // with that file or a folder it sits in, as a walk from the build down would leave them out.
  const isLeftOut = (serverBuild, path) => {
    const below = relative(serverBuild, path).split(sep);
    return below.some((name, at) => {
      const part = join(serverBuild, ...below.slice(0, at + 1));
      return isIgnored(state, fromProject(part), { name, isDirectory: at < below.length - 1 }, () => toDisplayPath(root, part));
    });
  };
  for (const serverBuild of result.serverBuilds) {
    const { sent, isWhole } = readServerSent(serverBuild, result.frameworks);
    if (!isWhole) result.serverSentUnread.push(toDisplayPath(root, serverBuild));
    for (const { path, pieces } of sent) {
      if (ignores && isLeftOut(serverBuild, path)) continue;
      const host = toDisplayPath(root, path);
      for (const { inner, text } of pieces) {
        const displayPath = `${host}${INSIDE_ARCHIVE}${toShownText(inner)}`;
        const bytes = Buffer.from(text, 'utf8');
        const open = (use) => {
          use(lazyBytes(bytes.length, () => bytes));
          return true;
        };
        result.serverSent.push(displayPath);
        scanFile({ displayPath, name: basename(inner), diskPath: null, matchedAs: null, open }, state);
      }
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
 * One file, wherever it sits, by the same rules on disk and inside an archive. A file that
 * is itself an archive is opened and each file in it comes back here. Text gets every
 * check, and whatever else can hold text is searched as bytes.
 *
 * @param {object} file
 * @param {string | null} file.diskPath null for a file inside an archive
 * @param {string | null} file.matchedAs its path from the project folder, written with `/`, an
 *   archive counting as a folder: what the project's ignore list is matched against, when it has one
 * @param {(use: (source: import('./bytes.mjs').ByteSource) => void) => boolean} file.open
 *   hands the file's bytes to `use`; false when the file cannot be opened at all
 * @param {{ depth: number, budget: { left: number }, isAsar: boolean, dexClasses?: object } | null} [file.within]
 *   the archives the file sits in: how many of them, how much may still be read out of the
 *   outermost, whether the one right around the file is an ASAR, and, in an Android app
 *   package, where the classes of the app's own code are counted
 */
function scanFile({ displayPath, name, diskPath, matchedAs, open, within = null }, state) {
  const { result } = state;
  const extension = extname(name).toLowerCase();
  result.filesSeen += 1;
  if (within) within.budget.left -= FILE_COST_BYTES;
  addFindings(state, checkPath({ path: displayPath, name, extension, isInsideAsar: within?.isAsar ?? false }), diskPath);
  if (isTextless({ name, extension })) return;

  const isText = hasContentChecks(extension);
  const wasOpened = open((source) => {
    // Text too large to read whole is read a stretch at a time: a map for what a smaller one is
    // read for, since it can still carry all of the original source, and anything else for keys
    // and `.env` values alone, as a program is, and said to be.
    const isLarge = source.byteLength > MAX_FILE_BYTES;
    const isReadWhole = isText && !isLarge;
    const isLargeMap = isSourceMap(extension) && isLarge;
    // A file inside an archive is held whole in memory once read, and counts against what
    // may still be read out of that archive.
    const mostBytesOfOne = within ? MAX_HELD_BYTES : Infinity;
    if (source.byteLength > Math.min(mostBytesOfOne, within?.budget.left ?? Infinity)) {
      result.skippedLargeFiles.push(displayPath);
      return;
    }
    if (within) within.budget.left -= source.byteLength;
    // A file inside an archive is unpacked by the first read of it, which is where one
    // that is locked or damaged shows.
    const readStart = (bytes) => source.read(0, Math.min(source.byteLength, bytes));
    let opening;
    try {
      opening = readStart(4);
    } catch {
      result.unreadableFiles.push(displayPath);
      return;
    }
    addFindings(state, checkDebugFile({ path: displayPath, name, extension, readStart }), diskPath);

    const openArchive = isText ? null : isZip(opening) ? openZip : extension === '.asar' ? openAsar : isTarName(name) ? openTar : null;
    if (openArchive) {
      const depth = (within?.depth ?? 0) + 1;
      const budget = within?.budget ?? { left: MAX_UNPACKED_BYTES };
      if (depth > MAX_ARCHIVE_DEPTH) result.nestedTooDeep.push(displayPath);
      else scanArchive(openArchive, source, displayPath, { depth, budget, isAsar: openArchive === openAsar, matchedAs }, state);
    } else if (isSealedContainer(name)) {
      result.unopenedContainers.push(displayPath);
    } else if (source.byteLength > MAX_SEARCHED_BYTES) {
      result.skippedLargeFiles.push(displayPath);
    } else {
      result.filesScanned += 1;
      const isScriptBundle = SCRIPT_BUNDLE.test(name) && !holdsZeroByte(source);
      if (isReadWhole || (isScriptBundle && !isLarge)) {
        scanText({ displayPath, extension: isScriptBundle ? '.js' : extension, diskPath, source }, state);
      } else if (isLargeMap) addFindings(state, scanLargeMap(displayPath, source, state.envSecrets), diskPath);
      else {
        scanBytes({ displayPath, diskPath, source, opening }, state);
        // Text that comes this way was too large to read whole.
        if (isText || isScriptBundle) result.keysOnlyFiles.push(displayPath);
        // The classes of an Android app's own code are counted as each of its DEX files goes by.
        if (within?.dexClasses) collectDexClasses(name, source, within.dexClasses);
      }
    }
  });
  if (!wasOpened) result.unreadableFiles.push(displayPath);
}

function openOnDisk(file, use) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    use(fileBytes(fd));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * @param {typeof openZip | typeof openAsar | typeof openTar} openArchive
 * @param {{ depth: number, budget: { left: number }, isAsar: boolean, matchedAs: string | null }} within what the files of this archive sit in
 */
function scanArchive(openArchive, source, displayPath, within, state) {
  let archive;
  try {
    // What an archive unpacks to read itself counts against what may be read out of the outermost.
    archive = openArchive(source, within.budget);
  } catch {
    state.result.unreadableArchives.push(displayPath);
    return;
  }
  state.result.filesScanned += 1;
  state.result.archivesOpened += 1;
  // That an ASAR is no more closed than a ZIP is news to some who ship one.
  if (within.isAsar) addFindings(state, [archiveFinding(displayPath, archive.fileCount)], null);
  // An Android app package or bundle says how it was built in its manifest and its signature.
  // The classes of the app's own code are counted as each DEX file is read for keys.
  const manifest = openArchive === openZip ? findAndroidManifest(archive.root) : null;
  const android = manifest ? checkAndroidPackage(displayPath, source, archive, manifest, within.budget) : null;
  if (android) addFindings(state, android.findings, null);
  const dexClasses = android?.manifest?.appPackage ? startDexClasses(android.manifest) : null;
  const inside = dexClasses ? { ...within, dexClasses } : within;

  // A path is worked out only where something is said about it. An archive can put one
  // file under tens of thousands of folders, each with a path longer than the last.
  const shownPath = (inner) => toShownText(`${displayPath}${INSIDE_ARCHIVE}${inner.path}`);
  const matchedAs = (inner) => `${within.matchedAs}/${inner.path}`;
  const files = [];
  const listInside = state.ignores
    ? (directory) =>
        archive.list(directory).filter((inner) => !isIgnored(state, matchedAs(inner), inner, () => shownPath(inner)))
    : archive.list;
  for (const inner of walk(archive.root, listInside)) {
    if (!inner.isDirectory) files.push(inner);
    else if (strayDirectoryKind(inner.name) !== null) {
      addFindings(state, checkStrayDirectory({ path: shownPath(inner), name: inner.name }), null);
    }
  }
  // Smallest first: should what may be read run out, it is the few largest files that go
  // unread, and those are data far more often than they are the program.
  files.sort((one, other) => one.size - other.size);
  for (const inner of files) {
    const open = (use) => {
      use(lazyBytes(inner.size, () => archive.read(inner)));
      return true;
    };
    const innerMatchedAs = state.ignores ? matchedAs(inner) : null;
    scanFile({ displayPath: shownPath(inner), name: inner.name, diskPath: null, matchedAs: innerMatchedAs, open, within: inside }, state);
  }
  if (dexClasses) addFindings(state, checkDexClasses(displayPath, dexClasses), null);
}

function scanText({ displayPath, extension, diskPath, source }, state) {
  if (isScript(extension)) state.result.scriptsScanned += 1;
  const text = decodeText(source.read(0, source.byteLength));
  addFindings(state, checkFile({ path: displayPath, extension, text }), diskPath);
  addFindings(state, checkEnvValues(displayPath, text, state.envSecrets), diskPath);
}

/**
 * A source map too large to read whole, read a stretch at a time for whether it carries the
 * original source and for values from `.env`. Keys are not looked for by their shape, as in
 * any map: a map carries the sources of dependencies too, and the example keys in their docs.
 */
export function scanLargeMap(displayPath, source, envSecrets) {
  const map = startLargeMap();
  const envFindings = new Map();
  const hasEnvValues = envSecrets.length > 0;
  for (const chunk of readChunks(source, CHUNK_BYTES, OVERLAP_BYTES)) {
    // Once the source shows, nothing more of the map is looked for, only `.env` values.
    if (!map.carriesSource) collectLargeMap(source, chunk, OVERLAP_BYTES, map);
    // With no `.env` value to look for, the rest can tell nothing more once the source shows.
    if (!hasEnvValues && map.carriesSource) break;
    if (!hasEnvValues) continue;
    // The same value where two chunks overlap is one finding.
    for (const finding of checkEnvValues(displayPath, chunk.bytes.toString('latin1'), envSecrets)) {
      envFindings.set(JSON.stringify(finding), finding);
    }
  }
  return [...checkLargeMap(displayPath, map), ...envFindings.values()];
}

/**
 * Text in the encoding its first bytes announce. Nearly all of it is UTF-8; a file that
 * opens with a UTF-16 mark would read as every other character missing.
 */
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16Text(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Node reads UTF-16 low byte first, so a copy has each pair of bytes swapped.
    const pairs = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return pairs.swap16().toString('utf16le');
  }
  return bytes.toString('utf8');
}

/**
 * A file whose name does not say it is code is searched for keys a chunk at a time: a
 * program, bytecode, a data file, a script, a note. A native program has no file name to go
 * by and is known by how it opens. A Mach-O, ELF or PE program is also read for the names
 * and debug information it keeps, a Mach-O for its signature, a .NET assembly for what it
 * defines, and Electron's binary for its fuses. Any program is read for the paths of the
 * Rust source it was built from, for what Go keeps of its own, and for a Tauri app's screen.
 * Hermes bytecode is read for its header. A WebAssembly module is read for the names and debug
 * information it keeps, and, as a program is, for Rust's and Go's paths.
 */
function scanBytes({ displayPath, diskPath, source, opening }, state) {
  const images = readMachO(source);
  const openingText = opening.toString('latin1');
  const elf = openingText === ELF_OPENING ? readElf(source) : null;
  const pe = openingText.startsWith(PE_OPENING) ? readPe(source) : null;
  // An object file is a step of a build, not a program anyone runs.
  const isProgram = images?.some(({ kind }) => kind !== 'other') || isLinuxOrWindowsProgram(source);
  if (isProgram) state.result.programsScanned += 1;
  // A WebAssembly module is compiled code too, and keeps the paths of Rust's and Go's sources as a program does.
  const isWasm = openingText === WASM_OPENING;

  if (images) addFindings(state, checkMachO(displayPath, images), diskPath);
  if (elf) addFindings(state, checkElf(displayPath, elf), diskPath);
  if (pe) addFindings(state, checkPe(displayPath, pe), diskPath);
  addFindings(state, checkHermes(displayPath, source), diskPath);
  if (isWasm) addFindings(state, checkWasm(displayPath, source), diskPath);
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
  const sourcePaths = startRustSourcePaths();
  const go = startGo();
  let holdsScreenCode = false;
  for (const chunk of readChunks(source, CHUNK_BYTES, OVERLAP_BYTES)) {
    const place = {
      hasMoreBefore: chunk.position > 0,
      hasMoreAfter: chunk.position + chunk.bytes.length < source.byteLength,
    };
    if (isProgram || isWasm) {
      collectRustSourcePaths(chunk.bytes, place.hasMoreBefore, sourcePaths);
      collectGo(chunk, go);
    }
    if (isProgram) holdsScreenCode ||= holdsTauriScreenCode(chunk.bytes);
    // `.env` values are looked for in the bytes as they are, in each form a value is kept in.
    const inThisChunk = [checkElectronFuses(displayPath, source, chunk), checkEnvValuesInBytes(displayPath, chunk.bytes, state.envSecrets)];
    // The search for keys stops at its limit; the rest goes on to the end of the file.
    if (keys.length < MAX_KEYS_IN_A_FILE) {
      for (const text of readAsText(chunk.bytes, isText)) {
        // What a finding quotes is a view into the text, and kept as it is would keep the
        // whole chunk in memory until the file is done. Findings leave here as copies.
        const found = findKeys(displayPath, text, place, seenKeys);
        if (found.length > 0) keys.push(...structuredClone(found));
      }
    }
    for (const finding of inThisChunk.flat()) others.set(JSON.stringify(finding), finding);
  }
  if (holdsScreenCode) state.result.unreadScreenCode.push(displayPath);
  const reading = { chunkBytes: CHUNK_BYTES, overlapBytes: OVERLAP_BYTES };
  const notes = [...checkRustSourcePaths(displayPath, sourcePaths), ...checkGo(displayPath, source, go, reading)];
  addFindings(state, [...keys.slice(0, MAX_KEYS_IN_A_FILE), ...others.values(), ...notes], diskPath);
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
 * programs, .NET and Hermes keep some of theirs. Each is made only when the one before is
 * done with, so no more than one is held at a time.
 */
function* readAsText(bytes, isText) {
  yield bytes.toString('latin1');
  if (isText) return;
  yield utf16Text(bytes);
  yield utf16Text(bytes.subarray(1));
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
 * What is still to visit is kept as a list and not as calls within calls: an archive can
 * put a file under more folders than calls can nest.
 *
 * @param {{ name: string, isDirectory: boolean }} entry
 * @param {(directory: object) => { name: string, isDirectory: boolean }[]} list
 */
function* walk(entry, list) {
  const toVisit = [entry];
  while (toVisit.length > 0) {
    const current = toVisit.pop();
    yield current;
    // A directory that should never ship is reported whole and not looked into.
    if (!current.isDirectory || strayDirectoryKind(current.name) !== null) continue;
    const listed = list(current);
    // Dependencies are public code, and their docs and tests carry example keys.
    const holdsFlutterAssets = listed.some(({ name, isDirectory }) => !isDirectory && FLUTTER_ASSET_MANIFESTS.has(name));
    const isDependency = ({ name }) => DEPENDENCY_FOLDERS.has(name) || (name === FLUTTER_PACKAGES && holdsFlutterAssets);
    const children = listed.filter((child) => !(child.isDirectory && isDependency(child)));
    // The last one in is the next one out, so they go in backwards to come out as listed.
    for (let index = children.length - 1; index >= 0; index -= 1) toVisit.push(children[index]);
  }
}

/**
 * Whether the project's ignore list leaves a file or folder out; one it does is named in the
 * result as it is shown, which is worked out only then.
 */
function isIgnored(state, matchedAs, { name, isDirectory }, toShownPath) {
  if (!state.ignores(matchedAs, name, isDirectory)) return false;
  state.result.ignored.push(toShownPath());
  return true;
}

/** What `list` returns, or null for a folder that is not ours to list. */
function unlessUnlistable(list) {
  try {
    return list();
  } catch (error) {
    if (!UNLISTABLE.has(error.code)) throw error;
    return null;
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
  const frameworks = Object.entries(FRAMEWORK_BY_PACKAGE)
    .filter(([packageName]) => packageName in installed)
    .map(([, framework]) => framework);
  return [...new Set(frameworks)];
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

