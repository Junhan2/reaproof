import { checkEndpoints, checkPromptCandidates, checkUnminifiedCode } from './checks/content.mjs';
import { checkStrayFile, checkUnshippedSource } from './checks/paths.mjs';
import { checkSecrets } from './checks/secrets.mjs';
import { checkInlineMaps, checkMapFile } from './checks/sourcemaps.mjs';

export { SOURCE_MAP_RULES, STANDALONE_MAP_RULES } from './checks/sourcemaps.mjs';

/**
 * @typedef {'critical' | 'high' | 'medium' | 'info'} Severity
 * @typedef {{ rule: string, severity: Severity, path: string, detail: Record<string, unknown> }} Finding
 */

const MAP_EXTENSIONS = new Set(['.map']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const CODE_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, '.css']);
const SECRET_SCAN_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, '.html', '.json', '.pem', '.key']);
const SEVERITIES_ASCENDING = ['info', 'medium', 'high', 'critical'];
const RISK_BY_WORST_SEVERITY = { critical: 'very-high', high: 'high', medium: 'moderate', info: 'baseline' };

/** Tells the scanner which files are worth reading; every file still gets the name checks. */
export function hasContentChecks(extension) {
  return (
    MAP_EXTENSIONS.has(extension) ||
    CODE_EXTENSIONS.has(extension) ||
    SECRET_SCAN_EXTENSIONS.has(extension)
  );
}

/** @param {{ severity: Severity }[]} findings */
export function worstSeverity(findings) {
  const rank = (severity) => SEVERITIES_ASCENDING.indexOf(severity);
  return findings.reduce((worst, { severity }) => (rank(severity) > rank(worst) ? severity : worst), 'info');
}

/** Findings grouped by the kind of problem, in the order each kind first appeared. */
export function groupByRule(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const sameRule = groups.get(finding.rule);
    if (sameRule) sameRule.push(finding);
    else groups.set(finding.rule, [finding]);
  }
  return groups;
}

/**
 * The two things a result says at a glance.
 *
 * `risk` is how exposed the build is to an agent with a tool like rea. Its lowest level is
 * "baseline", never "safe": minified code, server addresses and screens are readable in
 * any shipped app.
 *
 * `leaks` counts kinds of leak, each at its worst severity: three hundred exposed maps are
 * the same mistake as one, not three hundred times as bad. Notes are not leaks.
 */
export function summarizeFindings(findings) {
  const leaks = { critical: 0, high: 0, medium: 0 };
  for (const sameRule of groupByRule(findings).values()) {
    const severity = worstSeverity(sameRule);
    if (severity !== 'info') leaks[severity] += 1;
  }
  return { risk: RISK_BY_WORST_SEVERITY[worstSeverity(findings)], leaks };
}

/** An ASAR archive is not something to fix, only a fact its owner should know. */
export function archiveFinding(path, fileCount) {
  return { rule: 'asar-readable', severity: 'info', path, detail: { fileCount } };
}

/**
 * Checks that need only where a file sits and what it is called.
 *
 * @param {{ path: string, name: string, extension: string, isInsideArchive: boolean }} file
 * @returns {Finding[]}
 */
export function checkPath(file) {
  return [...checkStrayFile(file), ...checkUnshippedSource(file)];
}

/**
 * Runs every check that applies to the text of one shipped file.
 *
 * @param {{ path: string, extension: string, text: string }} file
 * @returns {Finding[]}
 */
export function checkFile({ path, extension, text }) {
  if (MAP_EXTENSIONS.has(extension)) return checkMapFile(path, text);

  const findings = [];
  if (CODE_EXTENSIONS.has(extension)) findings.push(...checkInlineMaps(path, text));
  if (SECRET_SCAN_EXTENSIONS.has(extension)) findings.push(...checkSecrets(path, text));
  if (SCRIPT_EXTENSIONS.has(extension)) {
    findings.push(
      ...checkUnminifiedCode(path, text),
      ...checkEndpoints(path, text),
      ...checkPromptCandidates(path, text),
    );
  }
  // A piece cut out of `text` can be a view into it, and one kept in a finding would keep the
  // whole file in memory until the report is printed. Findings leave here as copies.
  return structuredClone(findings);
}
