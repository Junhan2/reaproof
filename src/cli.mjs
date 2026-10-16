import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyFix, planFix, undoLastFix } from './fix.mjs';
import { MeasureError, measureWithRea, REA_PACKAGE } from './measure.mjs';
import { isWebAddress, scanDeployedSite } from './remote.mjs';
import { createReporter, pickLanguage } from './report.mjs';
import { toSarif } from './sarif.mjs';
import { hasLeakAtOrAbove, LEAK_SEVERITIES } from './rules.mjs';
import { resolveTargets, scan, ScanError, withoutFiles } from './scan.mjs';
import { toPrintable, toVisibleJson } from './text.mjs';

const COMMANDS = { scan: runScan, fix: runFix, undo: runUndo, measure: runMeasure };
const OPTIONS = {
  json: { type: 'boolean' },
  // SARIF, the format GitHub code scanning and other review tools read, for a scan only.
  sarif: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  // The mildest leak that still stops a release.
  'fail-on': { type: 'string' },
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
// Nothing could be read: an address that did not answer, or a target with nothing in it
// that this scanner opens. A check that read nothing must not pass for a clean one.
const EXIT_UNREAD = 3;
// A fault in this tool and not in what was checked, which a release check must not take for
// a leak found (1).
const EXIT_INTERNAL = 4;

/**
 * Everything the command needs from the outside world, so the flow can be driven by a
 * person at a terminal, by an agent reading output, or by a test.
 *
 * @typedef {object} Terminal
 * @property {(text: string) => void} print
 * @property {(text: string) => void} printError
 * @property {((question: string) => Promise<boolean>) | null} ask null when nobody is there to answer
 * @property {(command: string[], directory: string) => boolean} runBuild true when the build succeeded
 * @property {boolean} [color] whether what is printed is shown in a terminal that takes color
 */

/**
 * @param {string[]} argv arguments after the program name
 * @param {Terminal} outside
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, outside) {
  // Whatever a path, a message or another program's output carries, nothing unseen gets out.
  // Color goes on after that, so nothing a scanned file holds can color a terminal.
  let paint = (text) => text;
  const terminal = {
    ...outside,
    print: (text) => outside.print(paint(toPrintable(text))),
    printError: (text) => outside.printError(toPrintable(text)),
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    // What can still be read of the command says how to answer it: in which language, and as JSON or not.
    const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
    const report = createReporter(pickLanguage(typeof values.lang === 'string' ? values.lang : undefined));
    const wantsJson = wantsMachineOutput(values);
    const reason = report.usageError(error, findMisusedOption(values));
    // A person is shown how the command is used. An agent gets the reason alone.
    const message = wantsJson ? reason : `${reason}\n\n${report.help}`;
    return fail(terminal, report, wantsJson, EXIT_USAGE, { code: 'usage', message });
  }

  const { values, positionals } = parsed;
  const options = { ...values, json: wantsMachineOutput(values), failOn: values['fail-on'] ?? 'high' };
  const report = createReporter(pickLanguage(options.lang));
  if (outside.color && !options.json) paint = report.paint;
  if (!LEAK_SEVERITIES.includes(options.failOn)) {
    return fail(terminal, report, options.json, EXIT_USAGE, { code: 'usage', message: report.failOnError(options.failOn) });
  }

  // `hasOwn`, not `in`: a folder named `toString` is a path, not a command.
  const command = Object.hasOwn(COMMANDS, positionals[0]) ? positionals.shift() : 'scan';
  const target = positionals[0] ?? '.';
  if (values.sarif && (values.json || command !== 'scan')) {
    return fail(terminal, report, true, EXIT_USAGE, { code: 'usage', message: report.sarifError });
  }
  try {
    if (options.help) {
      terminal.print(report.help);
      return EXIT_OK;
    }
    if (options.version) {
      terminal.print(readPackageVersion());
      return EXIT_OK;
    }
    return await COMMANDS[command](target, options, report, terminal);
  } catch (error) {
    if (error instanceof ScanError) {
      const { code, path, details } = error;
      const exitCode = code === 'page-unreachable' ? EXIT_UNREAD : EXIT_USAGE;
      return fail(terminal, report, options.json, exitCode, { code, message: report.scanError(error), path, ...details });
    }
    if (error instanceof MeasureError) {
      const failure = { code: 'measure-failed', message: report.measureFailed(error) };
      return fail(terminal, report, options.json, EXIT_USAGE, failure);
    }
    // A report of the fault needs where it happened, and the message asks for one.
    const stack = error instanceof Error ? error.stack : String(error);
    const message = report.internalError(error);
    const failure = { code: 'internal', message: options.json ? message : `${message}\n${stack}`, stack };
    return fail(terminal, report, options.json, EXIT_INTERNAL, failure);
  }
}

/** Whoever asks for SARIF reads machines' output, and is answered as one asking for JSON is. */
function wantsMachineOutput(values) {
  return values.json === true || values.sarif === true;
}

/**
 * The option that made a command unreadable, from what a loose reading made of it and not
 * from the words of Node's message: a name this command does not take, or a value of the
 * wrong kind, such as `--yes=1` or `--lang` with nothing after it.
 *
 * @returns {{ kind: 'unknown' | 'invalid', option: string } | null}
 */
function findMisusedOption(values) {
  for (const [name, value] of Object.entries(values)) {
    const option = name.length === 1 ? `-${name}` : `--${name}`;
    if (!Object.hasOwn(OPTIONS, name)) return { kind: 'unknown', option };
    if (typeof value !== OPTIONS[name].type) return { kind: 'invalid', option };
    // In `--fail-on --yes` a loose reading takes `--yes` for the value, which Node refuses.
    if (typeof value === 'string' && value.startsWith('-')) return { kind: 'invalid', option };
  }
  return null;
}

/**
 * Says why the command stopped, and hands back the code it ends with. When JSON was asked
 * for it is JSON on standard output like any other answer, so that whoever parses the
 * output is never handed nothing.
 *
 * @param {{ code: string, message: string }} failure and whatever else is known about it
 */
function fail(terminal, report, wantsJson, exitCode, failure) {
  if (wantsJson) terminal.print(toJson({ exitCode, error: failure }, report));
  else terminal.printError(failure.message);
  return exitCode;
}

/**
 * The one command most people need. For a person at a terminal it carries on from the
 * report: it offers to build when nothing is built yet, and to take out what can be taken
 * out. With `--json`, or with nobody there to answer, it only reports.
 */
async function runScan(target, options, report, terminal) {
  const ask = options.json ? null : terminal.ask;
  // A person at a terminal is told what is happening, and that it changes nothing, before it starts.
  if (ask) terminal.print(report.starting);
  const result = isWebAddress(target)
    ? await scanDeployedSite(target)
    : await scanOrOfferBuild(resolve(target), ask, report, terminal);
  const ending = endingOf(result, options);
  if (options.sarif) terminal.print(toVisibleJson(toSarif(result, report, readPackageVersion())));
  else terminal.print(options.json ? toJson(withExplanation(result, report, ending), report) : report.scan(result));

  // A deployed result plans nothing: none of its findings is a file on disk.
  const mapPaths = planFix(result);
  if (!ask || mapPaths.length === 0) return closeWith(ending, options, report, terminal);
  terminal.print(`\n${report.fixPlan(result.root, mapPaths)}`);
  if (!(await ask(report.confirmQuestion))) return closeWith(ending, options, report, terminal);
  return takeOutMaps(result, mapPaths, options, report, terminal);
}

async function scanOrOfferBuild(root, ask, report, terminal) {
  try {
    return scan(root);
  } catch (error) {
    // Only a missing build output carries the command that would produce it.
    const buildCommand = error instanceof ScanError ? error.details.buildCommand : null;
    if (!ask || !buildCommand || !(await ask(report.buildQuestion(buildCommand.join(' '))))) throw error;
    if (!terminal.runBuild(buildCommand, root)) throw new ScanError('build-failed', root);
    return scan(root);
  }
}

/** Fixing, undoing and measuring work on files someone holds, never on an address. */
function toLocalRoot(target) {
  if (isWebAddress(target)) throw new ScanError('local-only', target);
  return resolve(target);
}

async function runFix(target, options, report, terminal) {
  const root = toLocalRoot(target);
  const before = scan(root);
  const mapPaths = planFix(before);
  const ending = endingOf(before, options);
  if (mapPaths.length === 0) {
    terminal.print(options.json ? toJson({ ...ending, movedCount: 0, before }, report) : report.nothingToFix);
    return closeWith(ending, options, report, terminal);
  }

  if (!options.yes) {
    if (options.json) {
      terminal.print(toJson({ needsApproval: true, mapPaths }, report));
      return EXIT_USAGE;
    }
    terminal.print(report.fixPlan(root, mapPaths));
    if (!terminal.ask) {
      terminal.printError(report.needsApproval);
      return EXIT_USAGE;
    }
    if (!(await terminal.ask(report.confirmQuestion))) {
      terminal.print(report.cancelled);
      return closeWith(ending, options, report, terminal);
    }
  }
  return takeOutMaps(before, mapPaths, options, report, terminal);
}

function takeOutMaps(before, mapPaths, options, report, terminal) {
  const applied = applyFix(before.root, mapPaths);
  // The moved files are the only change, so the rest of the output is not read again.
  const notMoved = new Set(applied.failed.map(({ path }) => path));
  const after = withoutFiles(before, mapPaths.filter((path) => !notMoved.has(path)));
  // The check has been made already, so an output with nothing left in it is not a failure.
  const exitCode = hasLeakAtOrAbove(after.leaks, options.failOn) ? EXIT_FINDINGS : EXIT_OK;
  const ending = { failOn: options.failOn, exitCode };
  terminal.print(
    options.json ? toJson({ ...ending, ...applied, before, after }, report) : report.fixDone(before, after, applied),
  );
  return closeWith(ending, options, report, terminal);
}

function runUndo(target, options, report, terminal) {
  const outcome = undoLastFix(toLocalRoot(target));
  if (!outcome) {
    terminal.print(options.json ? toJson({ restored: [], conflicts: [] }, report) : report.nothingToUndo);
    return EXIT_OK;
  }
  terminal.print(options.json ? toJson(outcome, report) : report.undo(outcome));
  return EXIT_OK;
}

async function runMeasure(target, options, report, terminal) {
  const root = toLocalRoot(target);
  const { targets } = resolveTargets(root);
  // rea is someone else's program: it is downloaded and run only after a yes.
  if (!options.yes) {
    if (options.json) {
      terminal.print(toJson({ needsApproval: true, downloadsAndRuns: REA_PACKAGE }, report));
      return EXIT_USAGE;
    }
    if (!terminal.ask) {
      terminal.printError(report.measureNeedsApproval(REA_PACKAGE));
      return EXIT_USAGE;
    }
    if (!(await terminal.ask(report.measureQuestion(REA_PACKAGE)))) {
      terminal.print(report.cancelled);
      return EXIT_OK;
    }
  }
  if (!options.json) terminal.printError(report.measureNotice);
  const measurements = targets.map((measured) => ({ target: measured, ...measureWithRea(measured) }));
  if (options.json) {
    terminal.print(toJson({ measurements }, report));
    return EXIT_OK;
  }
  for (const { target: measured, ...summary } of measurements) {
    terminal.print(report.measure(root, measured, summary));
  }
  return EXIT_OK;
}

/**
 * The JSON a scan prints: the result, plus what it means and what to do, in words. The
 * verdict comes first and the list of findings last, so an answer that a reader cuts short
 * still says the most important thing.
 *
 * @param {{ failOn: string, exitCode: number }} ending
 */
function withExplanation(result, report, ending) {
  const { risk, leaks, findings, ...facts } = result;
  return { risk, leaks, ...ending, explain: report.explain(result), ...facts, findings };
}

/**
 * How a command ends when that follows from a result. A leak is worth failing a release
 * check over when it is critical or high, unless `--fail-on` says otherwise: medium ones
 * too, or critical ones alone. The answer says how it ends as well, for whoever reads a
 * log later and for an agent that is not shown the exit code: `failOn` and `exitCode` in
 * the JSON, and a closing line in the text (`closeWith`).
 */
function endingOf(result, options) {
  const stops = hasLeakAtOrAbove(result.leaks, options.failOn);
  const exitCode = stops ? EXIT_FINDINGS : result.risk === 'unrated' ? EXIT_UNREAD : EXIT_OK;
  return { failOn: options.failOn, exitCode };
}

function closeWith({ failOn, exitCode }, options, report, terminal) {
  const closing = options.json ? null : report.closing(exitCode, failOn);
  if (closing) terminal.print(`\n${closing}`);
  return exitCode;
}

function readPackageVersion() {
  const manifestUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(manifestUrl, 'utf8')).version;
}

/**
 * Every JSON answer opens with the caution, so a reader meets it before any text that was
 * copied from a scanned file.
 */
function toJson(value, report) {
  return toVisibleJson({ caution: report.caution, ...value });
}
