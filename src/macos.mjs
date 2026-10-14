import { worstSeverity } from './rules.mjs';

// What a Mach-O file, the format of macOS and iOS programs, gives away or leaves open. The
// facts come from `readMachO`; nothing here runs the file or asks the system about it, so
// the checks give the same answer on any machine.

// A stripped build keeps a marker or two. A handful of names says little about the code,
// so names alone are reported from a hundred up.
const MIN_NAMES = 100;
const HOME_FOLDER = /^(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/;
// A path is long, and one is enough to show whose machine it names.
const MAX_SAMPLE_SOURCES = 1;

const HARDENED_RUNTIME = 0x10000;
// The names `codesign -dv` prints for the bits of `flags=`, so the evidence can be compared with it.
const SIGNATURE_FLAG_NAMES = [
  [0x1, 'host'],
  [0x2, 'adhoc'],
  [0x100, 'hard'],
  [0x200, 'kill'],
  [0x400, 'expires'],
  [0x800, 'restrict'],
  [0x1000, 'enforcement'],
  [0x2000, 'library-validation'],
  [HARDENED_RUNTIME, 'runtime'],
  [0x20000, 'linker-signed'],
];
// Entitlements that open the running program to others, by the system the program is for.
// `get-task-allow` lets another process attach to it, and is spelled differently on the
// Mac. `disable-library-validation` lets a Mac program load plug-ins and libraries whoever
// signed them. Others are left alone: `allow-dyld-environment-variables` still needs that
// one before it can bring in code from another signer (Apple's page for it says so), and
// those that loosen memory protection, as a JavaScript engine needs, are a different matter.
const OPENING_ENTITLEMENTS = {
  macos: [
    ['com.apple.security.get-task-allow', 'high'],
    ['com.apple.security.cs.disable-library-validation', 'medium'],
  ],
  ios: [['get-task-allow', 'high']],
};
const isGranted = (entitlements, key) =>
  new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`).test(entitlements);

/**
 * @param {string} path how the file is shown to the user
 * @param {import('./macho.mjs').MachOImage[]} images one per architecture
 */
export function checkMachO(path, images) {
  // The system grants entitlements and the Hardened Runtime to a process, by its own executable.
  const executables = images.filter(({ kind }) => kind === 'executable');
  const programs = images.filter(({ kind }) => kind !== 'other');
  return [
    ...checkNames(path, programs),
    ...checkKeptNames(path, programs),
    ...checkEntitlements(path, executables),
    ...checkRuntime(path, executables),
  ];
}

/**
 * Names and paths that only a developer or a debugger needs, left in what ships. Other
 * files link against the names a library exports, so those have to stay; nothing links
 * against a program's, so there every name it defines counts.
 */
function checkNames(path, images) {
  const builds = images.map((image) => ({
    architecture: image.architecture,
    names: image.localNames + (image.kind === 'executable' ? image.exportedNames : 0),
    debugEntries: image.debugEntries,
    sources: image.sourcePaths,
  }));
  if (builds.length === 0) return [];
  // The builds in a universal binary are of the same code. The one with the most names
  // speaks for the file, so that its numbers can be checked against that one build.
  const [{ architecture, names, debugEntries, sources }] = builds.sort((one, other) => other.names - one.names);
  if (sources.length === 0 && names < MIN_NAMES) return [];
  const detail = {
    architecture,
    names,
    debugEntries,
    sourceCount: sources.length,
    sampleSources: sources.slice(0, MAX_SAMPLE_SOURCES),
    // A path under someone's home folder names the account that built the file.
    namesBuilder: sources.some((source) => HOME_FOLDER.test(source)),
  };
  return [{ rule: 'native-symbols', severity: 'medium', path, detail }];
}

/**
 * Names that stripping does not take out, because the program uses them while it runs. They
 * cannot all be closed, so this is a note: it says what a stripped program still tells.
 */
function checkKeptNames(path, images) {
  const count = ({ keptNames }) => keptNames.types + keptNames.members;
  // As with the names above, the build with the most speaks for the file.
  const [most] = [...images].sort((one, other) => count(other) - count(one));
  if (!most || count(most) === 0) return [];
  return [{ rule: 'kept-names', severity: 'info', path, detail: { architecture: most.architecture, ...most.keptNames } }];
}

function checkEntitlements(path, executables) {
  const granted = new Map();
  for (const { system, signature } of executables) {
    for (const [key, severity] of OPENING_ENTITLEMENTS[system] ?? []) {
      if (signature && isGranted(signature.entitlements, key)) granted.set(key, { severity });
    }
  }
  if (granted.size === 0) return [];
  const severity = worstSeverity([...granted.values()]);
  return [{ rule: 'macos-entitlement', severity, path, detail: { entitlements: [...granted.keys()] } }];
}

/**
 * The Hardened Runtime is a protection of the Mac, and a Mac program that is not signed
 * has none either. Each architecture's build carries its own signature, so each is listed
 * with what it says.
 */
function checkRuntime(path, executables) {
  const unprotected = executables.filter(
    ({ system, signature }) => system === 'macos' && !(signature && signature.flags & HARDENED_RUNTIME),
  );
  if (unprotected.length === 0) return [];
  const slices = unprotected.map(({ architecture, signature }) => ({
    architecture,
    flags: signature ? describeFlags(signature.flags) : null,
  }));
  return [{ rule: 'macos-runtime', severity: 'medium', path, detail: { slices } }];
}

/** @returns {string} for example '0x10002(adhoc,runtime)', the way `codesign -dv` writes it */
function describeFlags(flags) {
  const names = SIGNATURE_FLAG_NAMES.filter(([bit]) => flags & bit).map(([, name]) => name);
  return `0x${flags.toString(16)}(${names.join(',') || 'none'})`;
}
