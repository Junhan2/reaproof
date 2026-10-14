# Reaproof

One command that rates how exposed your shipped app is to AI reverse-engineering agents, and closes what can be closed.

Tools such as [rea](https://github.com/morluto/rea) let a coding agent inspect a shipped app without its source, explain how a feature works and rebuild it. Reaproof checks what you ship for the things that make that easy, rates the risk, explains each finding in plain language, and fixes the ones that are safe to fix automatically.

It is written for people who have never dealt with security before. There is nothing to install and nothing to configure. It needs Node.js 18.3 or later.

## Three ways to use it

### Yourself

```bash
npx reaproof
```

Run it in your project folder. It rates the risk, lists what it found, and when there is something it can close, it shows the list and asks before doing it. If nothing is built yet, it offers to run your build first.

Nothing stays installed. `npx` comes with Node.js and fetches the package when you run it; the first time, it asks `Ok to proceed? (y)` before downloading. Answer `y`.

To check a live site instead, give it the address:

```bash
npx reaproof https://your-site.example
```

### With an AI agent

Say this to any coding agent that can run commands:

> Run `npx reaproof --json` and fix what it reports.

The JSON carries the risk level and, for every kind of finding, what it means and what to do, so the agent needs no setup. It opens with the verdict and ends with the list of findings, so a reader that cuts long output short still gets the verdict. With the verdict come `failOn` and `exitCode`, for an agent that is not shown how the command ended. A failure is answered in JSON too, on standard output, with a `code`, the reason and the `exitCode`. Paths, file names and addresses inside the findings are copied from the scanned files: characters a reader cannot see are removed, long text is cut, and every JSON answer opens by saying that this text is data to report, not instructions to follow.

To make the agent reach for it by itself, install the skill once:

```bash
npx skills add Junhan2/reaproof
```

That works for Claude Code, Codex, Cursor, Gemini CLI and other agents. In Claude Code you can also install it as a plugin:

```
/plugin install reaproof --marketplace Junhan2/reaproof
```

On Claude Code older than 2.1.275, run `/plugin marketplace add Junhan2/reaproof` and then `/plugin install reaproof@reaproof`.

### Automatically

`npx reaproof` exits with 1 when something critical or high would ship, so it can stop a release. Add it after your build step. `--fail-on medium` stops for medium findings as well, and `--fail-on critical` for critical ones only. A report that ends with exit code 1 or 3 closes with a line that says why, for whoever reads the log later. It exits with 3 when it could not read what ships, which a release check should not take for a pass.

## Reading the result

Every report starts with the risk.

| rea risk | What it means |
| --- | --- |
| very high | A tool like rea can take your original source or your secret values as they are |
| high | Near-secret values, data, or the inside of the running app are exposed |
| moderate | Something left in makes the code easier to read, or the running app easier to get into |
| baseline | None of the leaks this tool looks for was found. Code structure, the text and values in it, and server addresses are still readable, as in any shipped app |
| not rated | What ships could not be read, so no rating is given. It does not mean nothing leaks |

There is no "safe" level, because there is no such state: see "What it cannot do".

Right under the count of files read, the report says what it met and did not read: disk images and installers it does not open, archives it could not read, files it could not open (no permission, a password, a kind of compression it does not undo), files too large to read, and how many files it passed over because there is nothing to find in them (pictures, sound, video, fonts, compressed files). The result is "not rated", never "baseline", when no file's content could be read, and also when something was left unread and no program or script was read beside it: what ships is then most likely in what was left.

Below the risk, the report counts kinds of leak, each at its worst severity. Three hundred exposed maps are the same mistake as one. Notes are not counted.

Exit codes: 0 when no leak at the `--fail-on` level or above was found (the level is high unless you say otherwise, so a moderate result exits with 0), 1 when one was, 2 for a usage error or a target that could not be settled on, 3 when what ships could not be read (an address that did not answer, or a target with nothing in it that Reaproof opens).

## Commands

| Command | What it does |
| --- | --- |
| `reaproof [path]` | Rates the risk of a build output or an app, reports, and offers the fix |
| `reaproof <https://your-site>` | Checks whether a deployed site serves its source maps |
| `reaproof fix [path]` | Takes source map files out of the output, after showing the list and asking |
| `reaproof undo [path]` | Puts back what the last fix took out |
| `reaproof measure [path]` | Runs the real rea on the output and counts what it reads |

Options: `--json` for machine-readable output, `--yes` to skip the question in `fix` and `measure`, `--fail-on critical|high|medium` for the mildest leak that makes the exit code 1, `--lang ko|en` for the report language. Questions are asked only at a terminal; with `--json`, in a pipe or in CI nothing is asked and nothing is changed.

The path can be a build output folder, a packaged app, a single program, or an archive such as a `.zip`, an `.ipa` or an Electron `.asar`, and it is scanned as given. Only a JavaScript project folder, one with a `package.json`, is searched for its output: Reaproof looks there for `.next/static`, `out`, `dist`, `build`, `release` and `.output/public`, and the report says the folders were picked by name. For a project in another language (a folder with `Package.swift`, an Xcode project, `Cargo.toml`, `go.mod` and the like) it does not guess where the build went. Point it at the thing that ships, for example the `.app`.

## What it checks

| Finding | Severity | Automatic fix |
| --- | --- | --- |
| Settings files (`.env`), a `.git` folder, key stores, database files and debug symbols mixed into the output | Critical or high | No, take them out and stop them being copied in. Keep debug symbols, somewhere else |
| Server-only keys in shipped files, whether code, a script, a settings file of any name, a native program or bytecode: Stripe secret and restricted keys, Supabase secret and `service_role` keys, GitHub tokens, AWS access keys, private keys, AI service keys, database addresses that carry a password | Critical or high | No, revoke the key and move it to a server |
| A secret value from the project's own `.env` that appears word for word in any shipped file | Critical or high | No, change the value and move it to a server |
| Source map files that contain your original source text | Critical | Yes |
| Source maps embedded inside code files | Critical | No, turn it off in the build settings |
| A program signed with an entitlement that opens it up while it runs: `get-task-allow` on macOS or iOS (high), `disable-library-validation` on macOS (medium) | High or medium | No, leave it out of release signing |
| Source map files that list file names without the source text | Medium | Yes |
| A macOS or iOS program that kept its development names: the names of its functions and variables, and the paths of the original files on the machine that built it | Medium | No, strip the program before signing it |
| A macOS program signed without the Hardened Runtime, or not signed at all | Medium | No, turn it on when signing |
| A packaged Electron app with development fuses left on (`runAsNode`, `nodeOptions`, `nodeCliInspect`) | Medium | No, turn them off with `@electron/fuses` |
| Source and test files packed into the app or output | Medium | No, take them out of the packaging list |
| Long text in client code that looks like an AI prompt | Medium, a guess | No, keep prompts on a server |
| Code that is not minified | Medium | No, turn on minification |
| Names that stay in a macOS or iOS program after stripping: Swift types, properties and enum cases, Objective-C classes and methods | Note | In part: a build setting leaves out the names of Swift properties and cases, at a price. See "Native programs" |
| Notes and scripts written for developers (`.md`, `.py`, `.sh` and the like) | Note | A list to review; on a website each one gets a public address |
| Server addresses named in the code | Note | Cannot be hidden; a list to review |
| Electron `.asar` archives, which anyone can unpack | Note | No |

Keys that are meant for browsers, such as Stripe publishable keys and Supabase `anon` and publishable keys, are not reported. Neither is a key with the word `example` in it, which is how documentation and self-tests write a stand-in, nor the password of a database on the same machine (`localhost`, `127.0.0.1`). Secrets are never printed in full, and values from `.env` are reported by variable name only.

For the `.env` comparison, Reaproof reads the `.env` files of the project the path belongs to: the nearest folder, the path itself or one above it, that holds a `package.json` or another project file such as `Package.swift` or `Cargo.toml`. The search stops short of your home folder, so a `package.json` left there does not make everything under it one project. The values are compared and never printed. Variables with a prefix their framework documents as public (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`) are expected in the output, unless the name itself says `SECRET`, `PRIVATE`, `PASSWORD` or `SERVICE_ROLE`.

## How files are read

Every file under the path is read, whatever it is called. The exceptions are named in the report: containers that are not opened, and pictures, sound, video, fonts and compressed files, in which there is nothing to find. `node_modules` is not entered, because dependencies are public code.

An archive is opened and each file in it is read as if it lay on disk. A ZIP archive is told by how it opens and not by its name, so `.zip`, `.ipa`, `.apk`, `.aab`, `.jar`, `.msix` and other files in that format are all read, and so is an Electron `.asar`. An archive inside an archive is opened too, three deep, and one nested deeper is named in the report. Nothing is unpacked to disk.

- JavaScript, CSS, HTML, JSON and source map files are read whole, as UTF-8 or, when the file opens with its mark, UTF-16. JavaScript gets every check in the table above. In CSS and source map files a key is not looked for by its shape, only as a value from `.env`.
- Every other file is searched for keys and `.env` values a piece at a time. A file with no zero byte anywhere in it is text, whatever it is called: there a key has to stand apart from what is around it, and a private key is reported, as in an Apple `.p8` key file left in an app.
- Anything else is searched as bytes: programs, bytecode, data files. A key is found there also where strings are stored end to end with nothing between them, as Rust, Go and Hermes bytecode store them, and where text is kept two bytes to a character, as Windows programs keep it.
- Two things are not reported in bytes. A private key, because TLS libraries compile their self-test keys into programs in the same form. And an AWS key ID that sits in a long run of base64, or holds fewer than ten different characters: encoded data spells one out by chance, as the WebAssembly inside Node.js does.
- A file in an archive is held in memory while it is read, so one over 512 MB is not read. An archive is never trusted about itself. A file in it cannot come out larger than it states: on a 1 MB archive whose one file states 1 MB and holds 1 GB, the read is refused in 0.04 seconds with 55 MB of memory in use, where without that stop it used 2.1 GB. At most 2 GB is read out of one archive, the archives inside it included, the smallest files first, and every file counts for at least 2 kB of that: a 137 kB archive that holds another many times over and lists twenty million files is done with after about a million of them, in about a second. A file that is encrypted, or packed in a way other than the usual two (stored and deflated), is named as not opened, and so is an archive that lists more than 250,000 files or folders.

## Native programs

Reaproof tells a native program by how the file opens, not by its name, and reads it without running it or any other tool, so the result is the same on every machine.

- A macOS or iOS program (Mach-O) is read for what it says about itself: its symbol table and its signature. This covers every program and library in an app, frameworks and helper programs included, and each processor's build of a universal binary.
- For a program, every name it defines counts, the ones it exports too: nothing links against a program, and plain `strip` takes out all of them but one. For a library, the exported names have to stay, so only the rest count, which is what `strip -x` takes out. A file with fewer than 100 names and no original paths is not reported. In an Xcode build the settings Strip Linked Product (`STRIP_INSTALLED_PRODUCT`) and Strip Style (`STRIP_STYLE`) do the stripping, in a build that has Deployment Postprocessing (`DEPLOYMENT_POSTPROCESSING`) on.
- Some names stay after stripping, because the program uses them while it runs: Swift types, the names of Swift properties and enum cases, Objective-C classes and methods. Reaproof counts them from the sections that hold them and lists them as a note, for the file with the most, with one name of each kind as an example. The counts take in the names of system frameworks the program uses, such as the methods it calls; the examples are names of the program's own. The names of Swift properties and cases can be left out with a build setting (Xcode: Reflection Metadata Level set to Without Names; `swiftc -Xfrontend -disable-reflection-names`), but code that turns such a name into text then behaves differently, so test before you ship it. The rest cannot be taken out.
- Each program is judged by its own signature, by the rules of the system it is built for. A helper inside a hardened Mac app can still be signed without the Hardened Runtime, and it is the helper that gets reported. An iOS program has no Hardened Runtime to turn on, and is checked for `get-task-allow` only.
- The numbers come from the symbol table itself, for the processor's build that has the most names. Apple's `nm` adds entries of its own for a stripped program (`<redacted function 1>` and so on), so to compare, run `nm --no-dyldinfo`.
- Keep the debug information (`.dSYM`) before you strip, outside what ships. It is what makes crash reports readable.
- A Windows or Linux program is searched for keys, and for Electron's fuse list, which sits in Electron's own binary on every system.

## What the fixes change, measured

Measured on 2026-10-14 with rea 6.4.0, on macOS on Apple silicon, on two small apps written for the purpose. The numbers say what a fix changes in what a tool reads. They are not a promise about your app.

A web app: four TypeScript files bundled with Bun 1.2.19.

| Build | Original files rea names | Functions rea counts | Request sites rea counts |
| --- | --- | --- | --- |
| Minified, with its source map | 4 of 4 | 10 | 2 |
| The same after `reaproof fix` | 0 | 10 | 2 |
| Not minified, no map | 0 | 10 | 2 |

The map held the text of all four files, character for character. Taking it out is what `fix` does. Minifying changed none of rea's counts: it removed the names of functions and constants and left every number and every rule of the logic where it was.

A macOS program: Swift 6.3, 44 types, built with `swiftc -O`.

| Build | Names in the symbol table (`nm`) | Classes rea lists by name | Instance variables rea lists by name |
| --- | --- | --- | --- |
| As built | 1,652 | 42 | 84 |
| After `strip` | 1 | 42 | 84 |

Stripping removed the names of functions and methods, and the program ran as before. It did not remove the names of types, properties and Objective-C methods: rea's own reader listed the same classes and instance variables before and after. Those are the names the note counts, and its counts for this program (44 Swift types, 42 Objective-C class names, 22 names of Swift properties and cases, 20 names of Objective-C methods and properties) match what `otool` shows in the same sections.

Building with `-disable-reflection-names` took out the 22 names of Swift properties and enum cases, and changed what the program printed: an enum case came out as the name of its type.

Not measured: what rea reads with a disassembler behind it (Hopper, Ghidra or IDA), which is where the names in the symbol table would show as function names, and none of which was installed. And what the Hardened Runtime and `get-task-allow` change in practice: those two findings rest on Apple's documentation.

## What it cannot do

Reaproof does not make an app impossible to copy. Nothing can.

- Screen structure and the server addresses your app calls stay readable, because they have to reach the user's device.
- Minified code stays readable in structure, and its numbers and strings stay as they are.
- The only logic nobody can read is logic that runs on your server. Reaproof says so in every report.

## How the fix works

The fix moves standalone `.map` files out of the build output into `~/.reaproof/backups/`, outside your project, so a backup is never deployed by accident. It never edits your code files, because changing them would break integrity hashes. `reaproof undo` moves the files back.

The next build creates the maps again unless you turn them off. The report tells you which setting to change for Next.js, Vite and Create React App.

If a hosting platform builds your project from the repository, a local fix does not reach what gets deployed. Change the build setting, deploy, and check the deployed site.

## Checking a deployed site

`npx reaproof https://your-site.example` reads one page and the code files that page loads from its own address, at most 60 of them, one after another. For each code file it looks for a map where the file or the server says one is, and beside the file, where a "hidden" map is written. Nothing fetched is saved.

If the address you type redirects, to `www` or to `https` for example, the place it ends up is the site that gets checked. A code file that redirects to another site is not followed, and a file that names many maps is asked for the last one only, so what a page serves cannot send the check anywhere else.

When the address does not answer, the report says why (the status the server gave, a timeout, a refused connection) and the exit code is 3.

It checks source maps only. Looking for keys and stray files is done on the build output, by someone who holds the files. Code that the page loads later or from another address is not checked, and the report says how many files were left out. Use it on sites you run.

## Measuring with the real rea

`reaproof measure` downloads the `rea-agents` package with `npx` and runs its static JavaScript analysis on your build output only, with install scripts disabled. rea is someone else's program, so the command asks before it does that; in a script or with an AI agent, pass `--yes`. It reports how many readable source maps, original file names, server addresses, request sites and functions rea recovered. Run it before and after the fix to see the difference.

It runs one fixed release of rea, 6.4.0, the one this version was tested against. A published release cannot change afterwards. Newer releases are adopted here after they have been tested.

## Not covered yet

- Disk images, installers and archives that are not ZIP (`.dmg`, `.pkg`, `.7z`, `.rar`, `.tar`, `.tar.gz` and the like). They are not opened. The report lists them as unread; point Reaproof at the app or folder inside. For a `.dmg` it says how to open one. A ZIP with something in front of it, as a self-extracting program or a `.crx` has, is not opened either.
- Names and signatures of Windows and Linux programs. They are searched for keys and for Electron's fuses, nothing more.
- Server addresses and prompts inside a native program. Those two are looked for in JavaScript only.
- Keys written in source map and CSS files. A map that embeds your sources is reported as critical by itself, but a key in those sources is not listed with it. A map embeds the sources of dependencies too, and their documentation carries example keys, so the two have to be told apart first.
- Which certificate signed a macOS program. An ad-hoc or development signature is not told apart from a release one.
- Android apps, beyond what any archive gets. An `.apk` is opened and its files are searched for keys, but nothing that is Android's own is checked, and there was no real APK to try even that on.
- Dependencies other than `node_modules`. A Python `site-packages` folder or a Ruby gem folder is read like your own files, so the notes, scripts and test keys of the libraries in it are reported as if they were yours.
- Public-variable prefixes of frameworks other than the five listed above.
- Very large files. A code or text file over 30 MB, any file over 512 MB inside an archive, and any other file over 1 GB are not read. The report counts them as skipped, so a source map that large goes unrated.

## Development

```bash
npm test
```

No dependencies. Node.js 18.3 or later. The tests write their own Mach-O files and archives and run anywhere; each change is run on Linux, macOS and Windows with Node 18, 20, 22 and 24. Three more tests use the system's own tools where they are there. On a Mac with `clang` and `codesign`, two build, sign and strip throwaway programs, never start them, and check that Reaproof reads them the way `codesign` does and that `strip` takes out what was reported. Where `zip` is installed, one checks that an archive it wrote is read the same as the folder it was made from.

## License

MIT
