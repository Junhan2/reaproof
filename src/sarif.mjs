import { createHash } from 'node:crypto';
import { basename, relative, sep } from 'node:path';
import { groupByRule, worstSeverity } from './rules.mjs';
import { INSIDE_ARCHIVE } from './text.mjs';

// A result as SARIF 2.1.0, the format GitHub code scanning and other review tools read, with
// what GitHub's "SARIF support for code scanning" marks required: for each rule an id, a short
// and a full description and help; for each result a message, where it is and a fingerprint
// that stays the same from one run to the next.

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/Junhan2/reaproof';
const LEVELS = { critical: 'error', high: 'error', medium: 'warning', info: 'note' };
// GitHub reads a score above 9.0 as critical, from 7.0 as high and from 4.0 as medium. A note
// has none, and so is not shown as a security result.
const SECURITY_SEVERITIES = { critical: '9.5', high: '8.0', medium: '5.0' };

/**
 * @param {{ root: string, isDeployed?: boolean, findings: object[] }} result what a scan of a folder or of a deployed site returned
 * @param {ReturnType<import('./report.mjs').createReporter>} report whose words the rules and results are given in
 * @param {string} version Reaproof's own
 */
export function toSarif(result, report, version) {
  const explanation = report.explain(result);
  const rules = [...groupByRule(result.findings)].map(([id, findings]) => {
    const { title, explanation: lines } = explanation.rules[id];
    const worst = worstSeverity(findings);
    const score = SECURITY_SEVERITIES[worst];
    return {
      id,
      shortDescription: { text: title },
      fullDescription: { text: lines.join(' ') },
      help: { text: lines.join('\n') },
      defaultConfiguration: { level: LEVELS[worst] },
      properties: { tags: ['security'], ...(score ? { 'security-severity': score } : {}) },
    };
  });
  const results = result.findings.map((finding) => ({
    ruleId: finding.rule,
    level: LEVELS[finding.severity],
    message: { text: `${explanation.rules[finding.rule].title}: ${report.describeFinding(finding)}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: result.isDeployed ? new URL(finding.path, result.root).href : toRelativeUri(result.root, finding) },
          // Reaproof reports a file, not a place in it. GitHub asks for all four.
          region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        },
      },
    ],
    partialFingerprints: { primaryLocationLineHash: `${fingerprint(finding)}:1` },
  }));
  return {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'Reaproof', version, informationUri: INFORMATION_URI, rules } }, results }],
  };
}

/**
 * The file a finding is about, as a URI relative to the folder that was scanned. A file on
 * disk is placed by its own path; one inside an archive by the archive, which is what sits in
 * the repository.
 */
function toRelativeUri(root, { path, diskPath }) {
  const file = diskPath ? (relative(root, diskPath) || basename(diskPath)).split(sep).join('/') : path.split(INSIDE_ARCHIVE)[0];
  return file.split('/').map(encodeURIComponent).join('/');
}

/**
 * What tells one finding from another across runs: its rule, its file, which of the rule's
 * kinds it is and, where one file can hold several of a kind, what it shows of itself (the
 * redacted key, the start of a prompt). Not the counts and samples, which change as code does.
 */
function fingerprint({ rule, path, detail }) {
  const kind = detail.secretId ?? detail.kind ?? detail.variable ?? '';
  const which = detail.redacted ?? detail.preview ?? '';
  return createHash('sha256').update(`${rule}\0${path}\0${kind}\0${which}`).digest('hex').slice(0, 16);
}
