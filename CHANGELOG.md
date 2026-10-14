# Changelog

What changed in each release published to npm, newest first.

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
