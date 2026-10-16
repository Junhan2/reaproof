// What a program in any native format keeps that only a developer or a debugger needs: the
// names of its functions and variables, and the paths of the files it was built from. Each
// format's reader says how many there are; the finding is the same for all of them.

// A stripped build keeps a marker or two. A handful of names says little about the code,
// so names alone are reported from a hundred up.
const MIN_NAMES = 100;
// A path is long, and one is enough to show whose machine it names.
const MAX_SAMPLE_SOURCES = 1;

/** Nothing links against a program's names; a library has to keep the ones it exports. */
export function countedNames({ kind, localNames, exportedNames }) {
  return localNames + (kind === 'executable' ? exportedNames : 0);
}

/**
 * The names and paths a program kept, as a finding when they say something about the code: a
 * hundred names or more, any original path, or any section of debug information.
 *
 * @param {string} path how the file is shown to the user
 * @param {object} build the build with the most names, which speaks for the file
 * @param {'mach-o' | 'elf' | 'pe'} build.format
 * @param {string} build.architecture
 * @param {number} build.names names of functions and variables that stripping takes out
 * @param {string[]} build.sources the original files, as the build recorded them
 * @param {boolean} build.namesBuilder whether a recorded path names the home folder of the machine that built it
 * @param {{ debugEntries?: number, debugSections?: number }} [debug] what the format writes for a
 *   debugger, where it does: entries in a Mach-O's symbol table, sections of DWARF in an ELF
 */
export function checkNativeNames(path, { format, architecture, names, sources, namesBuilder }, debug = {}) {
  if (names < MIN_NAMES && sources.length === 0 && !(debug.debugSections > 0)) return [];
  const detail = {
    format,
    architecture,
    names,
    ...debug,
    sourceCount: sources.length,
    // A path cut out of a section's text would keep all of that text in memory with the finding.
    sampleSources: structuredClone(sources.slice(0, MAX_SAMPLE_SOURCES)),
    namesBuilder,
  };
  return [{ rule: 'native-symbols', severity: 'medium', path, detail }];
}
