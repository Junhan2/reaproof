import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// What a project says to leave out of the check, in `.reaproofignore` in the project folder,
// one pattern to a line as in `.gitignore`: `#` starts a comment, `*` stands for any part of a
// name and `**` for any number of folders, a pattern that ends with `/` is for folders only,
// and one with a `/` before its end counts from the project folder. A line that starts with
// `!` is not read: a file left out stays left out.

const IGNORE_FILE = '.reaproofignore';
const MAX_PATTERNS = 1000;
const MAX_PATTERN_LENGTH = 1000;
// What each part of a glob stands for in a regular expression over a path written with `/`.
const GLOB_PARTS = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };
// A pattern with neither `/` nor `**` in it can only match a name, and is matched against the
// name alone. Any other is matched against the whole path, when the path is no longer than
// this: an archive can nest folders far deeper than a project does, and a path costs as much
// to match as it is long.
const MAX_MATCHED_PATH = 1024;

/**
 * @param {string} root the project folder
 * @returns {((path: string, name: string, isDirectory: boolean) => boolean) | null} whether a
 *   file or folder is left out, by its path from the project folder written with `/` and its
 *   name; null when the project has no such file
 */
export function readIgnoreFile(root) {
  let text;
  try {
    text = readFileSync(join(root, IGNORE_FILE), 'utf8');
  } catch {
    return null;
  }
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!') && line.length <= MAX_PATTERN_LENGTH)
    .slice(0, MAX_PATTERNS)
    .map(compile);
  return (path, name, isDirectory) =>
    rules.some(
      ({ isDirectoryOnly, isNameOnly, expression }) =>
        (isDirectory || !isDirectoryOnly) &&
        (isNameOnly ? expression.test(name) : path.length <= MAX_MATCHED_PATH && expression.test(path)),
    );
}

function compile(pattern) {
  const isDirectoryOnly = pattern.endsWith('/');
  const body = pattern.replace(/\/+$/, '');
  const isAnchored = body.includes('/');
  const glob = body.replace(/^\/+/, '');
  const isNameOnly = !isAnchored && !glob.includes('**');
  const expression = glob.replace(/\*\*\/|\*\*|[*?]|[.+^${}()|[\]\\]/g, (part) => GLOB_PARTS[part] ?? `\\${part}`);
  // Matched against a path, one that is not anchored may start after any `/`.
  const opening = isAnchored || isNameOnly ? '^' : '(?:^|/)';
  return { isDirectoryOnly, isNameOnly, expression: new RegExp(`${opening}${expression}$`) };
}
