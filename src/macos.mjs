import { spawnSync } from 'node:child_process';

const GET_TASK_ALLOW = /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\/>/;
// `codesign -dv` prints for example: CodeDirectory v=20500 size=278 flags=0x10002(adhoc,runtime)
const CODE_DIRECTORY_FLAGS = /^CodeDirectory .*\bflags=0x[0-9a-f]+\(([^)]*)\)/m;

export function isAppBundleName(name) {
  return name.endsWith('.app');
}

/**
 * Reports release-signing settings of a macOS app that make it easy to look inside while
 * it runs. Reads the signature with the system's own `codesign`; the app is never started.
 *
 * @param {string} path how the bundle is shown to the user
 * @param {string} appPath absolute path of the `.app` directory
 */
export function checkAppBundle(path, appPath) {
  if (process.platform !== 'darwin') return [];
  const signature = runCodesign(['-dv', appPath]);
  // Unsigned, or no codesign on this machine: there is no release signature to judge.
  if (signature.status !== 0) return [];

  const findings = [];
  const entitlements = runCodesign(['-d', '--entitlements', '-', '--xml', appPath]).stdout ?? '';
  if (GET_TASK_ALLOW.test(entitlements)) {
    findings.push({ rule: 'macos-entitlement', severity: 'high', path, detail: {} });
  }
  const flags = signature.stderr.match(CODE_DIRECTORY_FLAGS)?.[1].split(',') ?? [];
  if (!flags.includes('runtime')) {
    findings.push({ rule: 'macos-runtime', severity: 'medium', path, detail: {} });
  }
  return findings;
}

function runCodesign(args) {
  return spawnSync('codesign', args, { encoding: 'utf8' });
}
