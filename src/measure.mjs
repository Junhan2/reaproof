import { spawnSync } from 'node:child_process';

const REA_PACKAGE = 'rea-agents@latest';
const REA_TIMEOUT_MS = 15 * 60 * 1000;
const REA_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** rea could not be run, or answered with something other than its analysis JSON. */
export class MeasureError extends Error {}

// Asked once per run: every `npx` start costs a registry lookup.
let reaVersion;

/**
 * Runs the real rea against one shipped directory or `.asar` and counts what it recovered.
 * rea ships several releases a week, so asking it directly ages better than a fixed
 * rulebook of what it can read.
 *
 * @param {string} targetPath absolute path
 */
export function measureWithRea(targetPath) {
  reaVersion ??= runRea(['--version']).trim();
  const output = runRea(['analyze-javascript-application', targetPath, '--json']);
  let evidence;
  try {
    evidence = JSON.parse(output);
  } catch {
    throw new MeasureError('rea did not return JSON');
  }
  return { reaVersion, ...summarizeEvidence(evidence) };
}

function runRea(args) {
  const result = spawnSync('npx', ['-y', REA_PACKAGE, ...args], {
    encoding: 'utf8',
    maxBuffer: REA_MAX_OUTPUT_BYTES,
    timeout: REA_TIMEOUT_MS,
    // rea's analysis runs without install scripts, so none are allowed to run.
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    shell: process.platform === 'win32',
  });
  if (result.error) throw new MeasureError(result.error.message);
  if (result.status !== 0) {
    const lastLines = (result.stderr ?? '').trim().split('\n').slice(-3).join('\n');
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

  const originalSources = ofKind(graphNodes, 'source-module')
    .map((node) => node.identity?.original_source)
    .filter((source) => typeof source === 'string');
  const urls = ofKind(semanticNodes, 'literal')
    .map((node) => node.properties?.value)
    .filter((value) => typeof value === 'string' && /^https?:\/\//.test(value));

  return {
    readableSourceMaps: sourceMapNodes.length - danglingMapReferences,
    danglingMapReferences,
    originalSources,
    urls: [...new Set(urls)],
    requests: ofKind(semanticNodes, 'request').length,
    functions: ofKind(semanticNodes, 'function').length,
  };
}
