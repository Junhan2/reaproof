import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyFix, planFix, undoLastFix } from './fix.mjs';
import { MeasureError, measureWithRea, REA_PACKAGE } from './measure.mjs';
import { isWebAddress, scanDeployedSite } from './remote.mjs';
import { createReporter, pickLanguage } from './report.mjs';
import { resolveTargets, scan, ScanError, withoutFiles } from './scan.mjs';
import { toPrintable, toVisibleJson } from './text.mjs';

const COMMANDS = { scan: runScan, fix: runFix, undo: runUndo, measure: runMeasure };
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

/**
 * Everything the command needs from the outside world, so the flow can be driven by a
 * person at a terminal, by an agent reading output, or by a test.
 *
 * @typedef {object} Terminal
 * @property {(text: string) => void} print
 * @property {(text: string) => void} printError
 * @property {((question: string) => Promise<boolean>) | null} ask null when nobody is there to answer
 * @property {(command: string[], directory: string) => boolean} runBuild true when the build succeeded
 */

/**
 * @param {string[]} argv arguments after the program name
 * @param {Terminal} outside
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, outside) {
  // Whatever a path, a message or another program's output carries, nothing unseen gets out.
  const terminal = {
    ...outside,
    print: (text) => outside.print(toPrintable(text)),
    printError: (text) => outside.printError(toPrintable(text)),
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        lang: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    terminal.printError(createReporter(pickLanguage()).usageError(error));
    return EXIT_USAGE;
  }

  const { values: options, positionals } = parsed;
  const report = createReporter(pickLanguage(options.lang));
  if (options.help) {
    terminal.print(report.help);
    return EXIT_OK;
  }
  if (options.version) {
    terminal.print(readPackageVersion());
    return EXIT_OK;
  }

  // `hasOwn`, not `in`: a folder named `toString` is a path, not a command.
  const command = Object.hasOwn(COMMANDS, positionals[0]) ? positionals.shift() : 'scan';
  const target = positionals[0] ?? '.';
  try {
    return await COMMANDS[command](target, options, report, terminal);
  } catch (error) {
    if (error instanceof ScanError) {
      terminal.printError(report.scanError(error));
      return EXIT_USAGE;
    }
    if (error instanceof MeasureError) {
      terminal.printError(report.measureFailed(error));
      return EXIT_USAGE;
    }
    throw error;
  }
}

/**
 * The one command most people need. For a person at a terminal it carries on from the
 * report: it offers to build when nothing is built yet, and to take out what can be taken
 * out. With `--json`, or with nobody there to answer, it only reports.
 */
async function runScan(target, options, report, terminal) {
  const ask = options.json ? null : terminal.ask;
  const result = isWebAddress(target)
    ? await scanDeployedSite(target)
    : await scanOrOfferBuild(resolve(target), ask, report, terminal);
  terminal.print(options.json ? toJson(withExplanation(result, report), report) : report.scan(result));

  // A deployed result plans nothing: none of its findings is a file on disk.
  const mapPaths = planFix(result);
  if (!ask || mapPaths.length === 0) return exitCodeFor(result);
  terminal.print(`\n${report.fixPlan(result.root, mapPaths)}`);
  if (!(await ask(report.confirmQuestion))) return exitCodeFor(result);
  return takeOutMaps(result, mapPaths, options, report, terminal);
}

async function scanOrOfferBuild(root, ask, report, terminal) {
  try {
    return scan(root);
  } catch (error) {
    // Only a missing build output carries the command that would produce it.
    const buildCommand = error instanceof ScanError ? error.buildCommand : null;
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
  if (mapPaths.length === 0) {
    terminal.print(options.json ? toJson({ movedCount: 0, before }, report) : report.nothingToFix);
    return exitCodeFor(before);
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
      return exitCodeFor(before);
    }
  }
  return takeOutMaps(before, mapPaths, options, report, terminal);
}

function takeOutMaps(before, mapPaths, options, report, terminal) {
  const applied = applyFix(before.root, mapPaths);
  // The moved files are the only change, so the rest of the output is not read again.
  const after = withoutFiles(before, mapPaths);
  terminal.print(options.json ? toJson({ ...applied, before, after }, report) : report.fixDone(before, after, applied));
  return exitCodeFor(after);
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
  const targets = resolveTargets(root);
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

/** The JSON a scan prints: the result, plus what it means and what to do, in words. */
function withExplanation(result, report) {
  return { ...result, explain: report.explain(result) };
}

/** Critical and high leaks are the ones worth failing a release check over. */
function exitCodeFor({ leaks }) {
  return leaks.critical + leaks.high > 0 ? EXIT_FINDINGS : EXIT_OK;
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
