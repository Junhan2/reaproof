import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { STANDALONE_MAP_RULES } from './rules.mjs';

const MANIFEST_NAME = 'manifest.json';

/**
 * What can be closed without touching a single line of shipped code: a standalone map file
 * on disk. Bundles are left alone, because editing them would break integrity hashes, and
 * a file inside an archive cannot be taken out without repacking it.
 */
export function isFixable({ rule, diskPath }) {
  return STANDALONE_MAP_RULES.has(rule) && Boolean(diskPath);
}

/** @returns {string[]} absolute paths of map files to take out of the output */
export function planFix(scanResult) {
  const mapPaths = scanResult.findings.filter(isFixable).map(({ diskPath }) => diskPath);
  return [...new Set(mapPaths)];
}

/**
 * Moves the map files out of the output into a backup kept outside the project, so the
 * backup can never be deployed along with the build. A file that cannot be moved, because it
 * is locked or not ours to move, is left where it is and said so; the others still move.
 *
 * @param {string} root absolute path the scan ran on
 * @param {string[]} mapPaths from `planFix`
 * @returns {{ backupDir: string, movedCount: number, failed: { path: string, code: string }[] }}
 */
export function applyFix(root, mapPaths) {
  const now = new Date();
  const backupDir = join(projectBackupsDir(root), now.toISOString().replace(/[:.]/g, '-'));
  // The exact relative path, not the one cleaned for showing: two files must never share a place.
  const files = mapPaths.map((original) => ({
    original,
    stored: join('files', relative(root, original) || basename(original)),
  }));

  // The manifest goes first so an interrupted move can still be undone.
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(
    join(backupDir, MANIFEST_NAME),
    JSON.stringify({ root, createdAt: now.toISOString(), files }, null, 2),
  );
  const failed = [];
  for (const { original, stored } of files) {
    try {
      moveFile(original, join(backupDir, stored));
    } catch (error) {
      failed.push({ path: original, code: error.code ?? 'EUNKNOWN' });
    }
  }
  return { backupDir, movedCount: files.length - failed.length, failed };
}

/**
 * Puts back the files taken out by the most recent fix. A file that has reappeared in the
 * output (after a rebuild, say) is left as it is rather than overwritten.
 *
 * @returns {{ backupDir: string, restored: string[], conflicts: string[] } | null} null when there is nothing to undo
 */
export function undoLastFix(root) {
  const projectDir = projectBackupsDir(root);
  if (!existsSync(projectDir)) return null;
  const latest = readdirSync(projectDir)
    .filter((name) => existsSync(join(projectDir, name, MANIFEST_NAME)))
    .sort()
    .at(-1);
  if (!latest) return null;

  const backupDir = join(projectDir, latest);
  const manifest = JSON.parse(readFileSync(join(backupDir, MANIFEST_NAME), 'utf8'));
  const restored = [];
  const conflicts = [];
  for (const { original, stored } of manifest.files) {
    const storedPath = join(backupDir, stored);
    if (!existsSync(storedPath)) continue;
    if (existsSync(original)) {
      conflicts.push(original);
      continue;
    }
    moveFile(storedPath, original);
    restored.push(original);
  }
  if (conflicts.length === 0) rmSync(backupDir, { recursive: true, force: true });
  return { backupDir, restored, conflicts };
}

/** Where Reaproof keeps what it writes, outside every project: backups and report pages. */
export function reaproofHome() {
  // An empty REAPROOF_HOME counts as unset, so nothing is written under the current folder.
  return process.env.REAPROOF_HOME || join(homedir(), '.reaproof');
}

/** A name of its own for each checked path: its last part and a hash of the whole of it. */
export function projectKey(root) {
  const pathKey = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return `${basename(root)}-${pathKey}`;
}

function projectBackupsDir(root) {
  return join(reaproofHome(), 'backups', projectKey(root));
}

function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    // The backup may sit on another volume than the project.
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    try {
      unlinkSync(from);
    } catch (unlinkError) {
      // A file that cannot be taken away stays where it was, and the copy goes.
      unlinkSync(to);
      throw unlinkError;
    }
  }
}
