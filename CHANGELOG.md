# Changelog

What changed in each release published to npm, newest first.

## 0.5.0 (2026-10-14)

- Opens ZIP archives, told by how the file opens and not by its name (`.zip`, `.ipa`, `.apk`, `.aab`, `.jar`, `.msix` and others), and archives inside archives, three deep. Each file in one is read as if it lay on disk, and nothing is unpacked to disk.
- Does not trust an archive about itself: a file in one cannot come out larger than it states, at most 2 GB is read out of one archive with every file counting for at least 2 kB of that, and one that lists more than 250,000 files or folders is not opened. A file inside an archive is read up to 512 MB (it was 30 MB inside an ASAR).
- Counts the names that stay in a macOS or iOS program after stripping (Swift types, properties and enum cases, Objective-C classes and methods) and lists them as a note. On a test program rea 6.4.0 listed the same classes before and after `strip`. The counts take in the names of system frameworks the program uses; the examples shown are the program's own.
- Fixes a false finding on Next.js builds: the page list the framework writes (`_buildManifest.js`, seen with Next.js 16.2) was taken for code left unminified.
- Names files that could not be opened (no permission, a password, a kind of compression that is not undone) instead of counting them with pictures. Gives no rating when no file's content was read, or when something was left unread and no program or script was read beside it.
- Reads code files saved as UTF-16.
- No longer aborts on Node 24.21.0 on Linux and Windows. That Node release corrupts its memory when it decodes an odd number of bytes that start at an odd place as UTF-16, which 0.4.0 does in every program it searches for keys.
- Names the Xcode settings that strip a program, and that they do so only with Deployment Postprocessing on.
- Counts the names a program keeps once when the same program is met twice, in a folder and in an archive of it, and says how many archives it opened.
- The README says what the fixes were measured to change, with rea 6.4.0, and what was not measured.
- Agent skill: `kept-names` is a note to report, not something to fix by renaming or obfuscating code, and leaving out Swift property names is the user's call.

## 0.4.0 (2026-10-13)

- Reads macOS and iOS programs (Mach-O) directly, without running them or any other tool: the names left in the symbol table, the paths of the original files, and each program's own signature (Hardened Runtime, `get-task-allow`, `disable-library-validation`).
- Searches every shipped file for keys, whatever it is called. A file with no zero byte is text, where a key has to stand apart and a private key is reported. Other bytes are also searched where strings sit end to end or two bytes to a character.
- Gives no rating (`unrated`, exit code 3) when what ships could not be read, names what was not read, and says how to open a disk image.
- Adds `--fail-on critical|high|medium`, a closing line that says why a command ends with 1 or 3, and `failOn` and `exitCode` in the JSON, failures included.
- Looks for a build output by folder name only next to a `package.json`. At the root of a Swift, Rust or Go project it asks for the thing that ships.
- Reads the `.env` of the project a path belongs to, and stops short of the home folder.
- Reads Electron's fuses from Linux and Windows builds too.
- Agent skill: an `unrated` result is never reported as clean, and `.dSYM` files are kept instead of deleted.

## 0.3.0 (2026-10-13)

The first release on npm.

- `npx reaproof` rates the risk of a build output, lists what it found in plain language, offers to build when nothing is built yet, and asks before it takes source maps out.
- `--json` carries the risk level and, for each kind of finding, what it means and what to do, so that a coding agent can act on it without setup.
- Checks: source maps, standalone and embedded; server-only keys; secret values from the project's `.env`; settings files, repositories, key stores and database files mixed into the output; source and test files; code that is not minified; Electron `.asar` archives and fuses; macOS signing; and, by address, whether a deployed site serves its source maps.
- `fix` moves source map files into a backup outside the project and `undo` puts them back. `measure` runs rea 6.4.0 on the output and counts what it reads.
- Ships as an agent skill and as a Claude Code plugin.
