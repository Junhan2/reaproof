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

Right under the count of files read, the report says what it met and did not read: disk images and archives it does not open, files too large to read, and how many files it passed over because there is nothing to find in them (pictures, sound, video, fonts, compressed files). The result is "not rated", never "baseline", when nothing could be read, and also when a container stayed unopened and no program or script was read beside it: what ships is then most likely inside the container.

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

The path can be a build output folder, a packaged app, a single program or an Electron `.asar` archive, and it is scanned as given. Only a JavaScript project folder, one with a `package.json`, is searched for its output: Reaproof looks there for `.next/static`, `out`, `dist`, `build`, `release` and `.output/public`, and the report says the folders were picked by name. For a project in another language (a folder with `Package.swift`, an Xcode project, `Cargo.toml`, `go.mod` and the like) it does not guess where the build went. Point it at the thing that ships, for example the `.app`.

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
| Notes and scripts written for developers (`.md`, `.py`, `.sh` and the like) | Note | A list to review; on a website each one gets a public address |
| Server addresses named in the code | Note | Cannot be hidden; a list to review |
| Electron `.asar` archives, which anyone can unpack | Note | No |

Keys that are meant for browsers, such as Stripe publishable keys and Supabase `anon` and publishable keys, are not reported. Neither is a key with the word `example` in it, which is how documentation and self-tests write a stand-in, nor the password of a database on the same machine (`localhost`, `127.0.0.1`). Secrets are never printed in full, and values from `.env` are reported by variable name only.

For the `.env` comparison, Reaproof reads the `.env` files of the project the path belongs to: the nearest folder, the path itself or one above it, that holds a `package.json` or another project file such as `Package.swift` or `Cargo.toml`. The search stops short of your home folder, so a `package.json` left there does not make everything under it one project. The values are compared and never printed. Variables with a prefix their framework documents as public (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`) are expected in the output, unless the name itself says `SECRET`, `PRIVATE`, `PASSWORD` or `SERVICE_ROLE`.

## How files are read

Every file under the path is read, whatever it is called. The exceptions are named in the report: containers that are not opened, and pictures, sound, video, fonts and compressed files, in which there is nothing to find. `node_modules` is not entered, because dependencies are public code.

- JavaScript, CSS, HTML, JSON and source map files are read whole. JavaScript gets every check in the table above. In CSS and source map files a key is not looked for by its shape, only as a value from `.env`.
- Every other file is searched for keys and `.env` values a piece at a time. A file with no zero byte anywhere in it is text, whatever it is called: there a key has to stand apart from what is around it, and a private key is reported, as in an Apple `.p8` key file left in an app.
- Anything else is searched as bytes: programs, bytecode, data files. A key is found there also where strings are stored end to end with nothing between them, as Rust, Go and Hermes bytecode store them, and where text is kept two bytes to a character, as Windows programs keep it.
- Two things are not reported in bytes. A private key, because TLS libraries compile their self-test keys into programs in the same form. And an AWS key ID that sits in a long run of base64, or holds fewer than ten different characters: encoded data spells one out by chance, as the WebAssembly inside Node.js does.

## Native programs

Reaproof tells a native program by how the file opens, not by its name, and reads it without running it or any other tool, so the result is the same on every machine.

- A macOS or iOS program (Mach-O) is read for what it says about itself: its symbol table and its signature. This covers every program and library in an app, frameworks and helper programs included, and each processor's build of a universal binary.
- For a program, every name it defines counts, the ones it exports too: nothing links against a program, and plain `strip` takes out all of them but one. For a library, the exported names have to stay, so only the rest count, which is what `strip -x` takes out. A file with fewer than 100 names and no original paths is not reported.
- Each program is judged by its own signature, by the rules of the system it is built for. A helper inside a hardened Mac app can still be signed without the Hardened Runtime, and it is the helper that gets reported. An iOS program has no Hardened Runtime to turn on, and is checked for `get-task-allow` only.
- The numbers come from the symbol table itself, for the processor's build that has the most names. Apple's `nm` adds entries of its own for a stripped program (`<redacted function 1>` and so on), so to compare, run `nm --no-dyldinfo`.
- Keep the debug information (`.dSYM`) before you strip, outside what ships. It is what makes crash reports readable.
- A Windows or Linux program is searched for keys, and for Electron's fuse list, which sits in Electron's own binary on every system.

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

- Disk images, installers and archives (`.dmg`, `.pkg`, `.zip`, `.ipa`, `.apk` and the like). They are not opened. The report lists them as unread; point Reaproof at the app or folder inside. For a `.dmg` it says how to open one.
- Names that `strip` cannot remove. The type and property names Swift keeps for reflection, and the class and method names of Objective-C, stay in a stripped program and are not counted.
- Names and signatures of Windows and Linux programs. They are searched for keys and for Electron's fuses, nothing more.
- Server addresses and prompts inside a native program. Those two are looked for in JavaScript only.
- Keys written in source map and CSS files. A map that embeds your sources is reported as critical by itself, but a key in those sources is not listed with it. A map embeds the sources of dependencies too, and their documentation carries example keys, so the two have to be told apart first.
- Which certificate signed a macOS program. An ad-hoc or development signature is not told apart from a release one.
- Android apps. There was no real APK to test a check against, so none was written.
- Dependencies other than `node_modules`. A Python `site-packages` folder or a Ruby gem folder is read like your own files, so the notes, scripts and test keys of the libraries in it are reported as if they were yours.
- Public-variable prefixes of frameworks other than the five listed above.
- Very large files. A code or text file over 30 MB, any file over 30 MB inside an `.asar` archive, and any other file over 1 GB are not read. The report counts them as skipped, so a source map that large goes unrated.

## Development

```bash
npm test
```

No dependencies. Node.js 18.3 or later. The tests write their own Mach-O files and run anywhere. One more test runs only on a Mac with `clang` and `codesign`: it builds and signs throwaway bundles, never starts them, and checks that Reaproof reads them the way `codesign` does.

## License

MIT
