import { spawnSync } from 'node:child_process';
import { toShownText } from './text.mjs';

// The release of rea this version was tested against. A published release cannot change
// after the fact, and its result format is the one the count below reads.
const REA_VERSION = '6.4.0';
/** What `measure` downloads and runs; shown to the user before they agree to it. */
export const REA_PACKAGE = `rea-agents@${REA_VERSION}`;
const REA_TIMEOUT_MS = 15 * 60 * 1000;
const REA_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const UNSAFE_IN_WINDOWS_SHELL = /["%^&|<>!`\r\n]/;

/** rea could not be run, or answered with something other than its analysis JSON. */
export class MeasureError extends Error {}

/**
 * Runs the real rea against one shipped directory or `.asar` and counts what it recovered.
 * It is someone else's program, so the caller asks before calling this.
 *
 * @param {string} targetPath absolute path
 */
export function measureWithRea(targetPath) {
  const usesShell = process.platform === 'win32';
  const shownToRea = usesShell ? toWindowsShellArgument(targetPath) : targetPath;
  const output = runRea(['analyze-javascript-application', shownToRea, '--json'], usesShell);
  let evidence;
  try {
    evidence = JSON.parse(output);
  } catch {
    throw new MeasureError('rea did not return JSON');
  }
  return { reaVersion: REA_VERSION, ...summarizeEvidence(evidence) };
}

/**
 * On Windows `npx` is a command file that only a shell can start, and a shell reads `&` or
 * `|` inside an argument as the start of another command. The path goes in quotes, and a
 * path that could get out of them is refused instead of escaped.
 */
export function toWindowsShellArgument(path) {
  if (UNSAFE_IN_WINDOWS_SHELL.test(path)) {
    throw new MeasureError(`this path has a character that is not safe to pass on: ${toShownText(path)}`);
  }
  // A backslash right before the closing quote would escape it, so a trailing run is doubled.
  return `"${path.replace(/\\+$/, '$&$&')}"`;
}

function runRea(args, usesShell) {
  const result = spawnSync('npx', ['-y', REA_PACKAGE, ...args], {
    encoding: 'utf8',
    maxBuffer: REA_MAX_OUTPUT_BYTES,
    timeout: REA_TIMEOUT_MS,
    // rea's analysis runs without install scripts, so none are allowed to run.
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    shell: usesShell,
  });
  if (result.error) throw new MeasureError(result.error.message);
  if (result.status !== 0) {
    const lastLines = (result.stderr ?? '').trim().split('\n').slice(-3).map(toShownText).join('\n');
    throw new MeasureError(`rea exited with status ${result.status}\n${lastLines}`);
  }
  return result.stdout;
}

/** Reads only node kinds, so fields rea adds between releases do not break the count. */
function summarizeEvidence(evidence) {
  const graphNodes = evidence?.normalized_result?.graph?.nodes ?? [];
  const semanticNodes = evidence?.normalized_result?.semantic_graph?.nodes ?? [];
  const ofKind = (nodes, kind) => nodes.filter((node) => node.kind === kind);

  // rea also records a map that a bundle merely points at; that one has nothing to read.
  const sourceMapNodes = ofKind(graphNodes, 'source-map');
  const danglingMapReferences = sourceMapNodes.filter(
    (node) =>
      node.identity?.namespace === 'unresolved-source-map' ||
      node.observations?.some((observation) => observation.properties?.available === false),
  ).length;

  // Names and addresses come out of the build by way of rea, so they are cleaned like any other.
  const originalSources = ofKind(graphNodes, 'source-module')
    .map((node) => node.identity?.original_source)
    .filter((source) => typeof source === 'string')
    .map(toShownText);
  const urls = ofKind(semanticNodes, 'literal')
    .map((node) => node.properties?.value)
    .filter((value) => typeof value === 'string' && /^https?:\/\//.test(value))
    .map(toShownText);

  return {
    readableSourceMaps: sourceMapNodes.length - danglingMapReferences,
    danglingMapReferences,
    originalSources,
    urls: [...new Set(urls)],
    requests: ofKind(semanticNodes, 'request').length,
    functions: ofKind(semanticNodes, 'function').length,
  };
}
