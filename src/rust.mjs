import { HOME_FOLDER } from './program.mjs';

// Rust keeps the path of each source file in which the program can stop on an error, so that
// the error can say where it happened. The paths are text the program prints, not names in its
// symbol table, so `strip` leaves them where they are.

const SOURCE_ENDING = '.rs';
const [DOT, LETTER_R, LETTER_S] = Buffer.from(SOURCE_ENDING);
// A path is read backwards from its ending, and no further than this: a long run of bytes that
// could all be part of a path, such as base64, then costs no more than the endings in it.
const MAX_PATH_BYTES = 512;
// The largest Rust programs hold a few thousand paths, met some ten thousand times. A file with
// far more is noise or made to be slow, and the search in it stops at these.
const MAX_PATHS = 10_000;
const MAX_ENDINGS = 200_000;
const IS_PATH_BYTE = new Uint8Array(256);
for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.+@~-/\\') {
  IS_PATH_BYTE[character.charCodeAt(0)] = 1;
}
const IS_SEPARATOR = new Uint8Array(256);
IS_SEPARATOR['/'.charCodeAt(0)] = 1;
IS_SEPARATOR['\\'.charCodeAt(0)] = 1;
const DRIVE = /^[A-Za-z]:[\\/]/;
const SOURCE_PATH = /^(?:[A-Za-z]:[\\/]|\/)?(?:[\w.+@~-]+[\\/])+[\w.+@~-]+\.rs$/;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
// Where a path starts when other text runs straight into it: a folder at the top of a Mac or
// Linux disk, or one that Rust's own builds put in place of their machine's folders.
const RUN_INTO_ABSOLUTE = /\/(?:Users|home|root|usr|opt|var|tmp|private|Volumes|rustc|rust)\//;
// The folders a relative path most often opens with: a program's own `src`, and the
// `library` of a Rust built from source.
const RELATIVE_OPENINGS = ['src', 'library'];
// Rust's standard library, and what it is built from. Official builds name it by a stand-in
// for the folder they were built in; a Rust built from source, as Homebrew's is, by its own
// `library` folder, often relative to it. It is in every Rust program, and says nothing of
// yours but that the program is a Rust one.
const STANDARD_LIBRARY =
  /^\/rustc\/|^\/rust\/deps\/|(?:^|[\\/])library[\\/](?:core|std|alloc|proc_macro|test|panic_abort|panic_unwind|unwind|portable-simd|stdarch|backtrace)[\\/]/;
// Cargo unpacks each dependency under its own home folder, from a registry or a git
// repository, or finds it in a vendor folder.
const DEPENDENCY = /[\\/](?:registry[\\/]src|git[\\/]checkouts)[\\/]|(?:^|[\\/])vendor[\\/]/;

/** What `collectRustSourcePaths` gathers from one program, a stretch at a time. */
export function startRustSourcePaths() {
  return { paths: new Set(), endingsLeft: MAX_ENDINGS };
}

/**
 * Adds the paths of Rust source files that a stretch of a program holds.
 *
 * @param {Buffer} bytes the stretch
 * @param {boolean} hasMoreBefore whether the stretch starts inside the file, where the one
 *   before it overlaps it: a path cut off at its start is whole in that one
 * @param {ReturnType<typeof startRustSourcePaths>} found
 */
export function collectRustSourcePaths(bytes, hasMoreBefore, found) {
  for (
    let at = bytes.indexOf(SOURCE_ENDING);
    at !== -1 && found.endingsLeft > 0 && found.paths.size < MAX_PATHS;
    at = bytes.indexOf(SOURCE_ENDING, at + 1)
  ) {
    found.endingsLeft -= 1;
    const path = readPathEndingAt(bytes, at, hasMoreBefore);
    if (path !== null) found.paths.add(path);
  }
}

/**
 * A note for a program that holds paths of the code it was built from: of its own source
 * files, which show how its code is divided up, and any that name the home folder of the
 * machine that built it. Paths of Rust's standard library are in every Rust program and do
 * not count, but without one the program is not a Rust one: text in another program can
 * end in `.rs` too.
 *
 * @param {string} path how the file is shown to the user
 * @param {ReturnType<typeof startRustSourcePaths>} found
 */
export function checkRustSourcePaths(path, found) {
  const own = [];
  let dependencyFiles = 0;
  let namesBuilder = false;
  let isRust = false;
  for (const source of found.paths) {
    if (STANDARD_LIBRARY.test(source)) {
      isRust = true;
      continue;
    }
    namesBuilder ||= HOME_FOLDER.test(source);
    if (DEPENDENCY.test(source)) dependencyFiles += 1;
    else own.push(source);
  }
  if (!isRust || (own.length === 0 && !namesBuilder)) return [];
  const detail = {
    ownFiles: own.length,
    dependencyFiles,
    namesBuilder,
    // A path inside the project shows how it is laid out, and does not name whose machine built it.
    sample: own.find((source) => !ABSOLUTE.test(source)) ?? own[0] ?? null,
  };
  return [{ rule: 'source-paths', severity: 'info', path, detail }];
}

/** @returns {string | null} the path whose `.rs` starts at `at`, or null when what ends there is not one */
function readPathEndingAt(bytes, at, hasMoreBefore) {
  const end = at + SOURCE_ENDING.length;
  let start = at;
  let holdsSeparator = false;
  // A path that ends right before this one is another path: the two were stored end to end.
  while (start > 0 && IS_PATH_BYTE[bytes[start - 1]] && !endsSourcePath(bytes, start)) {
    start -= 1;
    holdsSeparator ||= IS_SEPARATOR[bytes[start]] === 1;
    if (end - start > MAX_PATH_BYTES) return null;
  }
  // What has no folder in it is not a path to report, and is not decoded at all.
  if (!holdsSeparator || (start === 0 && hasMoreBefore)) return null;
  // A Windows path opens with its drive.
  const opensWithDrive = start >= 2 && DRIVE.test(bytes.toString('latin1', start - 2, start + 1));
  return startOfPath(bytes.toString('latin1', opensWithDrive ? start - 2 : start, end));
}

function endsSourcePath(bytes, at) {
  return at >= 3 && bytes[at - 3] === DOT && bytes[at - 2] === LETTER_R && bytes[at - 1] === LETTER_S;
}

/**
 * The path in what reads as one, with any text that runs straight into it left off. Strings
 * in a program are stored end to end, so the text before a path is often part of another.
 */
function startOfPath(candidate) {
  let path = candidate;
  if (!ABSOLUTE.test(candidate)) {
    const absoluteAt = candidate.search(RUN_INTO_ABSOLUTE);
    const [first] = candidate.split(/[\\/]/, 1);
    const opening = RELATIVE_OPENINGS.find((folder) => first !== folder && first.endsWith(folder));
    if (absoluteAt > 0) path = candidate.slice(absoluteAt);
    else if (opening) path = candidate.slice(first.length - opening.length);
  }
  return SOURCE_PATH.test(path) ? path : null;
}
