# Reaproof

One command that rates how exposed your shipped app is to AI reverse-engineering agents, and closes what can be closed.

Tools such as [rea](https://github.com/morluto/rea) let a coding agent inspect a shipped app without its source, explain how a feature works and rebuild it. Reaproof checks what you ship for the things that make that easy, rates the risk, explains each finding in plain language, and fixes the ones that are safe to fix automatically.

It is written for people who have never dealt with security before. There is nothing to install and nothing to configure. It needs Node.js 18.3 or later.

> The npm package is not live yet. Until it is, type `npx github:Junhan2/reaproof` wherever this page says `npx reaproof`. It runs the same code straight from this repository.

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

The JSON carries the risk level and, for every kind of finding, what it means and what to do, so the agent needs no setup.

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

`npx reaproof` exits with 1 when something critical or high would ship, so it can stop a release. Add it after your build step.

## Reading the result

Every report starts with the risk.

| rea risk | What it means |
| --- | --- |
| very high | A tool like rea can take your original source or your secret values as they are |
| high | Near-secret values, data, or the inside of the running app are exposed |
| moderate | The names and structure of your code read easily |
| baseline | No leak was found. Minified code, server addresses and screen structure are still readable, as in any shipped app |

There is no "safe" level, because there is no such state: see "What it cannot do".

Below the risk, the report counts kinds of leak, each at its worst severity. Three hundred exposed maps are the same mistake as one. Notes are not counted.

Exit codes: 0 when nothing critical or high was found, 1 when something was, 2 for a usage error.

## Commands

| Command | What it does |
| --- | --- |
| `reaproof [path]` | Rates the risk of the build output, reports, and offers the fix |
| `reaproof <https://your-site>` | Checks whether a deployed site serves its source maps |
| `reaproof fix [path]` | Takes source map files out of the output, after showing the list and asking |
| `reaproof undo [path]` | Puts back what the last fix took out |
| `reaproof measure [path]` | Runs the real rea on the output and counts what it reads |

Options: `--json` for machine-readable output, `--yes` to skip the question in `fix`, `--lang ko|en` for the report language. Questions are asked only at a terminal; with `--json`, in a pipe or in CI nothing is asked and nothing is changed.

The path can be a project folder, a build output folder, an Electron `.asar` archive or a packaged app. In a project folder Reaproof looks for `.next/static`, `out`, `dist`, `build`, `release` and `.output/public`.

## What it checks

| Finding | Severity | Automatic fix |
| --- | --- | --- |
| Settings files (`.env`), a `.git` folder, key stores, database files and debug symbols mixed into the output | Critical or high | No, delete them and stop them being copied in |
| Server-only keys in shipped code: Stripe secret and restricted keys, Supabase secret and `service_role` keys, GitHub tokens, AWS access keys, private keys, AI service keys, database addresses that carry a password | Critical or high | No, revoke the key and move it to a server |
| A secret value from the project's own `.env` that appears word for word in shipped code | Critical or high | No, change the value and move it to a server |
| Source map files that contain your original source text | Critical | Yes |
| Source maps embedded inside code files | Critical | No, turn it off in the build settings |
| A macOS app signed with the development entitlement `get-task-allow` | High | No, leave it out of release signing |
| Source map files that list file names without the source text | Medium | Yes |
| A macOS app signed without the Hardened Runtime | Medium | No, turn it on when signing |
| A packaged Electron app with development fuses left on (`runAsNode`, `nodeOptions`, `nodeCliInspect`) | Medium | No, turn them off with `@electron/fuses` |
| Source and test files packed into the app or output | Medium | No, take them out of the packaging list |
| Long text in client code that looks like an AI prompt | Medium, a guess | No, keep prompts on a server |
| Code that is not minified | Medium | No, turn on minification |
| Server addresses named in the code | Note | Cannot be hidden; a list to review |
| Electron `.asar` archives, which anyone can unpack | Note | No |

Keys that are meant for browsers, such as Stripe publishable keys and Supabase `anon` and publishable keys, are not reported. Secrets are never printed in full, and values from `.env` are reported by variable name only.

For the `.env` comparison, variables with a prefix their framework documents as public (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`) are expected in the output, unless the name itself says `SECRET`, `PRIVATE`, `PASSWORD` or `SERVICE_ROLE`.

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

It checks source maps only. Looking for keys and stray files is done on the build output, by someone who holds the files. Code that the page loads later or from another address is not checked, and the report says how many files were left out. Use it on sites you run.

## Measuring with the real rea

`reaproof measure` downloads the `rea-agents` package with `npx` and runs its static JavaScript analysis on your build output only, with install scripts disabled. It reports how many readable source maps, original file names, server addresses, request sites and functions rea recovered. Run it before and after the fix to see the difference.

rea ships several releases a week, so asking the real tool gives a more current answer than a fixed list of what it can read.

## Not covered yet

- Android apps. There was no real APK to test a check against, so none was written.
- Electron fuses of Linux builds. macOS apps and Windows `.exe` files are read.
- iOS apps and symbol stripping in native binaries.
- Public-variable prefixes of frameworks other than the five listed above.
- Files larger than 30 MB. They are not read, and the report counts them as skipped, so a source map that large goes unrated.

## Development

```bash
npm test
```

No dependencies. Node.js 18.3 or later. The macOS signing test runs only on a Mac with `clang` and `codesign`; it builds and signs throwaway bundles and never starts them.

## License

MIT
