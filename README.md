<div align="center">

# Reaproof

**Before you ship, see what an AI agent could lift from your app, and close it in one command.**

[![npm](https://img.shields.io/npm/v/reaproof?color=cb3837&label=npm)](https://www.npmjs.com/package/reaproof) [![test](https://github.com/Junhan2/reaproof/actions/workflows/test.yml/badge.svg)](https://github.com/Junhan2/reaproof/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node 18.3 or later](https://img.shields.io/badge/node-%E2%89%A5%2018.3-339933)](https://nodejs.org)

<img src="https://raw.githubusercontent.com/Junhan2/reaproof/main/docs/report.svg" width="808" alt="A terminal running npx reaproof on a web app: rea risk very high, because a source map holds the original source of four files; the map is taken out after a yes, and rea risk falls to baseline">

<sub>A real run on the web test app from <a href="#what-the-fixes-change-measured">What the fixes change, measured</a>. Lines left out are marked ⋯; the whole output is under <a href="#how-a-run-goes">How a run goes</a>.</sub>

</div>

Tools such as [rea](https://github.com/morluto/rea) let a coding agent inspect a shipped app without its source, explain how a feature works and rebuild it. What makes that easy is usually left in by accident: a source map that carries every original file, a server key in the code, a `.git` folder copied into the output. Reaproof finds those, rates the risk, explains each finding in plain words, and takes out what is safe to take out.

It is written for people who have never dealt with security before. There is nothing to install and nothing to configure. It needs Node.js 18.3 or later.

```bash
npx reaproof
```

## What it tells you

Every report opens with the rea risk and where it sits on the scale.

| | rea risk | What it means | What usually puts it there |
| --- | --- | --- | --- |
| 🔴 | **very high** | A tool like rea can take your original source or your secret values as they are | A source map that holds your source; a `.env` file, a `.git` folder or a server-only key in what ships |
| 🟠 | **high** | Near-secret values, data, or the inside of the running app are exposed | A database file or debug symbols in the output; a test key; a program signed with `get-task-allow` |
| 🟡 | **moderate** | Something left in makes the code easier to read, or the running app easier to get into | Code that is not minified; source maps that list file names; a program that kept its development names or runs without the Hardened Runtime |
| 🟢 | **baseline** | None of the leaks this tool looks for was found | Code structure, the text and values in it, and server addresses are still readable, as in any shipped app |
| ⚪ | **not rated** | What ships could not be read, so no rating is given | A disk image, an installer or an archive it does not open. It does not mean nothing leaks |

There is no "safe" level, because there is no such state: see "What it cannot do".

## How a run goes

1. **It reads, and changes nothing.** In a JavaScript project folder it finds the build output by name (`dist`, `.next/static`, `out`, `build` and the like). Anything else it reads as given: a folder, an app, a program or an archive.
2. **It rates and explains.** The rating comes first. Each finding follows, worst first, with what it exposes and how to close it. Right under the count of files read, it says what it did not read.
3. **It offers the fix it can make.** It lists the source map files it can take out and, after a `y`, moves them out of your output into a backup. `npx reaproof undo` puts them back.
4. **You close the rest and run it again.** Each finding names the setting to change. A finding that is gone is fixed. The report ends with what to do next.

<details>
<summary>The whole output of the run in the picture above</summary>

```text
Checking. This only reads; nothing is changed.
Target: dist (output folders picked by name, next to package.json)
Files read: 3

rea risk: very high
  Levels: [very high] · high · moderate · baseline
  A tool like rea can take your original source or your secret values as they are.
Leaks found: 1 kind (critical 1)

[CRITICAL] Your original source code is public
  1 source map file(s) contain the full text of 4 original file(s).
  Anyone who downloads them reads the code exactly as you wrote it.
  - dist/index.js.map (originals: ../../../src/pricing.ts, ../../../src/license.ts, ../../../src/client.ts, ../../../src/index.ts)
  Fix: reaproof fix (takes the map files out of the output; can be undone)

[NOTE] Server addresses that read straight from the code
  1 server address(es) are in the code as they are. They cannot be hidden.
  For each one, check that it is safe to call without signing in and never returns another user’s data.
  - https://api.shop-lab.test/v2

To keep them from coming back on the next build:
  Turn off production source maps in your build tool settings.
  If an error tracker needs the maps, upload them there and then delete them from the output.

[NOTE] What cannot be hidden
  Screen structure and the server addresses you call cannot be hidden once they reach a user device.
  Compute anything that must not be copied, such as pricing or permission checks, on a server.
  To see what is actually readable in the JavaScript, run reaproof measure.

What to do next:
  1. Fix the findings above from the top: the most damaging come first.
  2. Then rebuild and run npx reaproof again. A finding that is gone is fixed.
  3. After deploying, check the live site too: npx reaproof https://your-site

1 map file(s) will be taken out of the output:
  - dist/index.js.map
Continue? (y/N) y
Done: 1 taken out.
rea risk: very high → baseline
Leaks found: 1 kind (critical 1) → none
Kept at: /tmp/reaproof-demo/backups/shop-web-48f3456db025/2026-10-15T16-20-49-622Z
Undo: reaproof undo

To keep them from coming back on the next build:
  Turn off production source maps in your build tool settings.
  If an error tracker needs the maps, upload them there and then delete them from the output.
```

</details>

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

`npx reaproof` exits with 1 when something critical or high would ship, so it can stop a release. Add it after your build step. `--fail-on medium` stops for medium findings as well, and `--fail-on critical` for critical ones only. A report that ends with exit code 1 or 3 closes with a line that says why, for whoever reads the log later. It exits with 3 when it could not read what ships, which a release check should not take for a pass, and with 4 when Reaproof itself failed, which says nothing about your app.

## Reading the result

Right under the count of files read, the report says what it met and did not read: disk images and installers it does not open, archives it could not read, files it could not open (no permission, a password, a kind of compression it does not undo), files too large to read, the screen code inside a Tauri app, and how many files it passed over because there is nothing to find in them (pictures, sound, video, fonts, compressed files). The result is "not rated", never "baseline", when no file's content could be read, and also when something was left unread and no program or script was read beside it: what ships is then most likely in what was left.

Under the rea risk, one line shows every level with the result's own in brackets. Below it, the report counts kinds of leak, each at its worst severity. Three hundred exposed maps are the same mistake as one. Notes are not counted.

The report ends with what to do next: check first what it did not read, then fix from the top and run it again, or, when nothing leaks, run it after each build and check the deployed site as well.

At a terminal the rating and the kind of each finding are in color. Set `NO_COLOR` to turn color off; in a pipe, in CI and with `--json` there is none.

Exit codes: 0 when no leak at the `--fail-on` level or above was found (the level is high unless you say otherwise, so a moderate result exits with 0), 1 when one was, 2 for a usage error or a target that could not be settled on, 3 when what ships could not be read (an address that did not answer, or a target with nothing in it that Reaproof opens), 4 when Reaproof itself ran into an error. Please report a 4 at [Issues](https://github.com/Junhan2/reaproof/issues).

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
| Settings files (`.env`), a `.git` folder, key stores, database files and debug symbols (`.dSYM`, a `.pdb`, an R8 `mapping.txt`) mixed into the output | 🔴 Critical or 🟠 high | No, take them out and stop them being copied in. Keep debug symbols, somewhere else |
| Server-only keys in shipped files, whether code, a script, a settings file of any name, a native program or bytecode: Stripe secret and restricted keys, Supabase secret and `service_role` keys, GitHub tokens, AWS access keys, private keys, AI service keys, database addresses that carry a password, and the keys of 53 more services by the prefixes they are issued with (see "Key formats") | 🔴 Critical or 🟠 high | No, revoke the key and move it to a server |
| A secret value from the project's own `.env` that appears word for word in any shipped file | 🔴 Critical or 🟠 high | No, change the value and move it to a server |
| Source map files that contain your original source text | 🔴 Critical | Yes |
| Source maps embedded inside code files | 🔴 Critical | No, turn it off in the build settings |
| A program signed with an entitlement that opens it up while it runs: `get-task-allow` on macOS or iOS (high), `disable-library-validation` on macOS (medium) | 🟠 High or 🟡 medium | No, leave it out of release signing |
| An Android app built for development: `android:debuggable` (high), `android:testOnly`, or signed with the debug key Android's build tools make (medium) | 🟠 High or 🟡 medium | No, build and sign a release build |
| Source map files that list file names without the source text | 🟡 Medium | Yes |
| A program that kept its development names: the names of its functions and variables, its debug information, and the paths of the original files on the machine that built it. macOS and iOS (Mach-O), Linux and Android (ELF), Windows (PE), and WebAssembly modules | 🟡 Medium | No, strip the program before signing it (`wasm-opt --strip-debug` for a WebAssembly module) |
| A macOS program signed without the Hardened Runtime, or not signed at all | 🟡 Medium | No, turn it on when signing |
| A packaged Electron app with development fuses left on (`runAsNode`, `nodeOptions`, `nodeCliInspect`) | 🟡 Medium | No, turn them off with `@electron/fuses` |
| Source and test files packed into the app or output | 🟡 Medium | No, take them out of the packaging list |
| A `.DS_Store` file, which the macOS Finder writes with the names of the files in its folder; on a website anyone can fetch it | 🟡 Medium | No, take it out of what ships |
| Long text in client code that looks like an AI prompt | 🟡 Medium, a guess | No, keep prompts on a server |
| Code that is not minified | 🟡 Medium | No, turn on minification |
| Names that stay in a macOS or iOS program after stripping: Swift types, properties and enum cases, Objective-C classes and methods | 🔵 Note | In part: a build setting leaves out the names of Swift properties and cases, at a price. See "Native programs" |
| Paths of Rust source files that a program keeps as text after stripping: its own files, and those of its dependencies, which can name the home folder of the machine that built it | 🔵 Note | In part: `--remap-path-prefix` replaces the home folder. See "Native programs" |
| What a Go program keeps after stripping: the names of its functions, the paths of its source files, and build info that names its module and dependencies | 🔵 Note | In part: `-trimpath` takes out the folders of the machine that built it |
| .NET assemblies, whose code reads back as C# with every type and method name | 🔵 Note | No, keep logic that must stay private on a server |
| A Windows program whose debug file path names the home folder of the machine that built it | 🔵 Note | No, leave only the file name: `/PDBALTPATH:%_PDB%` for the MSVC linker, `PathMap` for .NET |
| An Android app whose own classes keep the names they were given, which R8 would shorten | 🟡 Medium | No, turn on R8 (`isMinifyEnabled`) in the release build |
| React Native code compiled to Hermes bytecode, which tools turn back into code close to JavaScript | 🔵 Note | No, keep logic that must stay private on a server |
| Notes and scripts written for developers (`.md`, `.py`, `.sh` and the like) | 🔵 Note | A list to review; on a website each one gets a public address |
| Server addresses named in the code, with any part shaped like a token shown as `…` | 🔵 Note | Cannot be hidden; a list to review |
| Electron `.asar` archives, which anyone can unpack | 🔵 Note | No |
| A packaged Electron app for macOS or Windows that runs its code even after someone changed it: the fuses that check `app.asar` against what was packaged (`embeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`) are off, as they are by default | 🔵 Note | No, turn them on with `@electron/fuses`; Electron Forge and Packager add the hash the check uses |

Keys that are meant for browsers, such as Stripe publishable keys, Supabase `anon` and publishable keys, PostHog project keys (`phc_`) and Mapbox public tokens (`pk.`), are not reported. Neither is a key with the word `example` in it, which is how documentation and self-tests write a stand-in, nor the password of a database on the same machine (`localhost`, `127.0.0.1`). For the 53 services below, neither is a key that ends in a run of one character, as the Slack webhook address in Slack's documentation ends in `XXXXXXXXXXXXXXXXXXXXXXXX`, or that counts up, as `0123456789abcdef`. Secrets are never printed in full, and values from `.env` are reported by variable name only. In the list of server addresses, and in what `measure` lists, a part of an address that is long and changes between letters and digits four times or more is shown as `…`: keys and tokens look so, as the end of a Discord webhook or a Telegram bot address does, and names and file names do not. Of the 1,793 addresses that the apps in `/Applications` on the test Mac name, 4 had such a part. A webhook found as a key is shown up to its secret, its last part.

### Key formats

Each is told by the prefix the service issues its keys with, as the service documents it where it does, and otherwise as the rules of [gitleaks](https://github.com/gitleaks/gitleaks) and the detectors of [trufflehog](https://github.com/trufflesecurity/trufflehog) record it. The patterns are Reaproof's own.

- Looked for everywhere, programs and bytecode included, because an app calls these services while it runs: xAI, Groq, OpenRouter, Perplexity, and OpenAI's service account, admin and older keys beside its project keys; Slack tokens and webhook addresses, Discord webhook addresses, SendGrid, Brevo; webhook signing secrets (`whsec_`, Stripe's and those that Svix sends for Clerk and Resend), Shopify, Square; Mapbox secret tokens.
- Looked for in text only, in code, scripts and settings files of any name: Replicate, Hugging Face, NVIDIA, Pinecone, LangSmith, Langfuse, Resend; GitLab, npm, PyPI, RubyGems, Docker Hub, Postman, Linear, Notion, Airtable, Atlassian, Contentful, Typeform; Supabase management tokens, DigitalOcean, PlanetScale, Heroku, Fly.io, Deno Deploy, Databricks, Doppler, HashiCorp Vault, Tailscale, Pulumi, Cloudflare Origin CA keys, 1Password service accounts, `age` secret keys, Alibaba Cloud key IDs, Azure storage and messaging keys; Sentry, Grafana, New Relic, Dynatrace, PostHog personal keys. Most are for publishing, deploying or running servers, and sit in settings files and scripts. In bytes, where strings run into each other, the names in a program spell their shorter prefixes: across the programs in `/Applications` on the test Mac, none of the 71 matches of these kinds was a key issued for the app (61 were names such as `tfp_8sanitize` or stand-ins, and 10 were one Alibaba key ID that unrelated programs all carry), and searching for the rest in bytes made the search half as long again.

For the `.env` comparison, Reaproof reads the `.env` files of the project the path belongs to: the nearest folder, the path itself or one above it, that holds a `package.json` or another project file such as `Package.swift` or `Cargo.toml`. The search stops short of your home folder, so a `package.json` left there does not make everything under it one project. The values are compared and never printed. Variables with a prefix their framework documents as public (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`, `NUXT_PUBLIC_`, `GATSBY_`, `VUE_APP_`, `STORYBOOK_`) are expected in the output, unless the name itself says `SECRET`, `PRIVATE`, `PASSWORD` or `SERVICE_ROLE`.

## How files are read

Every file under the path is read, whatever it is called. The exceptions are named in the report: containers that are not opened, and pictures, sound, video, fonts and compressed files, in which there is nothing to find. `node_modules` is not entered, and neither are Python's `site-packages` and `dist-packages` nor the `packages` folder beside Flutter's asset manifests, in an app or a web build, because dependencies are public code. Code of your own installed into one of them as a package is passed over with them.

An archive is opened and each file in it is read as if it lay on disk. A ZIP archive is told by how it opens and not by its name, so `.zip`, `.ipa`, `.apk`, `.aab`, `.jar`, `.msix` and other files in that format are all read, and so is an Electron `.asar`. A tar archive (`.tar`, `.tgz`, `.tar.gz`), as `npm pack` writes a package and many Linux programs ship, is opened too; one compressed with gzip is unpacked in memory, up to 512 MB, and what it unpacks to counts against what may be read out of an archive it sits in. An archive inside an archive is opened too, three deep, and one nested deeper is named in the report. A file that an ASAR's header gives no size or place a reader can go by, as one shipping app has to stop tools that unpack every file, is listed as unread, and the rest of the archive is read. Nothing is unpacked to disk.

- JavaScript, CSS, HTML, JSON and source map files are read whole, as UTF-8 or, when the file opens with its mark, UTF-16. JavaScript gets every check in the table above, and so does the bundle React Native writes an app's code to (`index.android.bundle` and `main.jsbundle`, or another name the build gives it that ends in `.bundle` or `.jsbundle`) when it is JavaScript: with no zero byte in it, as Hermes bytecode has in its header. In CSS and source map files a key is not looked for by its shape, only as a value from `.env`. A source map over 30 MB is searched a piece at a time, for whether it holds source text and for values from `.env`, and its files are not counted.
- Every other file is searched for keys and `.env` values a piece at a time. A file with no zero byte anywhere in it is text, whatever it is called: there a key has to stand apart from what is around it, and a private key is reported, as in an Apple `.p8` key file left in an app.
- Anything else is searched as bytes: programs, bytecode, data files. A key is found there also where strings are stored end to end with nothing between them, as Rust, Go and Hermes bytecode store them, and where text is kept two bytes to a character, as Windows programs keep it.
- A Tauri app keeps its screen code (HTML, JavaScript) compressed inside its program. The program is read and rated, but that code is not, and the report says so under the count of files read. Check it in the project folder, where `npx reaproof` reads the build output (`dist` and the like) before it is packed.
- Three things are not reported in bytes. A private key, because TLS libraries compile their self-test keys into programs in the same form. An AWS key ID that sits in a long run of base64, or holds fewer than ten different characters: encoded data spells one out by chance, as the WebAssembly inside Node.js does. And the keys of "Key formats" that are looked for in text only.
- A file in an archive is held in memory while it is read, so one over 512 MB is not read. An archive is never trusted about itself. A file in it cannot come out larger than it states: on a 1 MB archive whose one file states 1 MB and holds 1 GB, the read is refused in 0.04 seconds with 55 MB of memory in use, where without that stop it used 2.1 GB. At most 2 GB is read out of one archive, the archives inside it included, the smallest files first, and every file counts for at least 2 kB of that: a 137 kB archive that holds another many times over and lists twenty million files is done with after about a million of them, in about a second. A file that is encrypted, or packed in a way other than the usual two (stored and deflated), is named as not opened, and so is an archive that lists more than 250,000 files or folders.

## Native programs

Reaproof tells a native program by how the file opens, not by its name, and reads it without running it or any other tool, so the result is the same on every machine.

- A macOS or iOS program (Mach-O) is read for what it says about itself: its symbol table and its signature. This covers every program and library in an app, frameworks and helper programs included, and each processor's build of a universal binary.
- For a program, every name it defines counts, the ones it exports too: nothing links against a program, and plain `strip` takes out all of them but one. For a library, the exported names have to stay, so only the rest count, which is what `strip -x` takes out. A file with fewer than 100 names and no original paths is not reported. In an Xcode build the settings Strip Linked Product (`STRIP_INSTALLED_PRODUCT`) and Strip Style (`STRIP_STYLE`) do the stripping, in a build that has Deployment Postprocessing (`DEPLOYMENT_POSTPROCESSING`) on.
- Some names stay after stripping, because the program uses them while it runs: Swift types, the names of Swift properties and enum cases, Objective-C classes and methods. Reaproof counts them from the sections that hold them and lists them as a note, for the file with the most, with one name of each kind as an example. The counts take in the names of system frameworks the program uses, such as the methods it calls; the examples are names of the program's own. The names of Swift properties and cases can be left out with a build setting (Xcode: Reflection Metadata Level set to Without Names; `swiftc -Xfrontend -disable-reflection-names`), but code that turns such a name into text then behaves differently, so test before you ship it. The rest cannot be taken out.
- Each program is judged by its own signature, by the rules of the system it is built for. A helper inside a hardened Mac app can still be signed without the Hardened Runtime, and it is the helper that gets reported. An iOS program has no Hardened Runtime to turn on, and is checked for `get-task-allow` only.
- The numbers come from the symbol table itself, for the processor's build that has the most names. Apple's `nm` adds entries of its own for a stripped program (`<redacted function 1>` and so on), so to compare, run `nm --no-dyldinfo`.
- Keep the debug information (`.dSYM`) before you strip, outside what ships. It is what makes crash reports readable.
- A program built with Rust keeps the path of each source file in which it can stop on an error, as text that `strip` leaves alone. On any system, Reaproof lists them as a note: how many files are the program's own and how many are its dependencies', and whether a path names the home folder of the machine that built it. A program without Rust's standard library in it is not taken for a Rust one. `rustc --remap-path-prefix=<home folder>=~`, given in `RUSTFLAGS` or in `build.rustflags` of `.cargo/config.toml`, replaces that folder; the program's own file names cannot be left out with a stable Rust setting.
- A Linux or Android program (ELF) is read for its symbol table and debug information (DWARF), with the same rule as a Mac program: every name a program defines counts, and for a library only the names it does not export. The names of the original files and folders come from the debug information, unpacked where a compiler compressed it with zlib.
- A Windows program (PE) is read for its COFF symbol table, which MinGW and Go write and Microsoft's linker does not, and for the path of its debug file (the PDB). A path that names a home folder, such as `C:\Users\<name>\`, is noted: a `dotnet publish` from a home folder keeps one, and the `PathMap` property takes it out. A file name alone, as `rg.pdb`, is not noted. The `.pdb` files themselves are reported when they ship, told by how they open: a protein structure on a science site has the same extension.
- A WebAssembly module (`.wasm`) is read for its name section, which names its functions, and for DWARF debug information in sections named `.debug_*`, with the same rule: a hundred names or more, or any debug information. A free decompiler shows a module's functions by those names. On the 12 modules in `/Applications` and Homebrew on the test Mac, the counts match wabt's `wasm-objdump`, and one of them kept 282 names; so do they on a module built here with `clang -g`, which keeps 5 debug sections. A module built with Rust is also read for the paths of its source files, as a program is: 5 of the 12 kept them, 3 of those under the home folder of the machine that built them.
- A .NET assembly is read for how many types and methods its metadata defines, and noted: a free decompiler turns it back into C# that reads almost as written.
- A program built with Go keeps the names of its functions and the paths of its source files in its function table, and its module, dependencies and build settings in its build info, because it reads them while it runs. Reaproof notes how many there are, and whether the paths name a home folder; building with `-trimpath` makes them start at the module path. A file is taken for a Go program only when it holds Go's build info.
- Every program is also searched for keys, and for Electron's fuse list, which sits in Electron's own binary on every system, whatever the app calls it. On the 17 Electron apps in `/Applications` of the test Mac, what it reads of the two fuses that check `app.asar` matched `@electron/fuses read` on the 16 apps that tool found; the 17th renames Electron's framework, which the tool does not look for.

## Android apps

An `.apk` or an `.aab` is opened like any ZIP archive. When an app package (`.apk`) holds a manifest and DEX code at its top, or an app bundle (`.aab`) holds `BundleConfig.pb` and its base module's manifest, it is also read as an Android app, without running anything:

- The manifest, which an app package keeps in binary XML and an app bundle in protobuf, for the app's package name, for `android:debuggable` and `android:testOnly` on its `application`, and for the classes it names: the application, activities, services, receivers and providers. A debuggable app lets anyone who connects the device attach a debugger to it.
- The signature, for the debug key: the certificate Android's build tools make on each machine is issued to `CN=Android Debug,O=Android,C=US` (`CERTIFICATE_DESC` in AOSP's `KeystoreHelper.java`). It is looked for in the APK Signing Block, where apps signed since Android 7 keep their certificate, and in an older signature file under `META-INF`, which is how a bundle is signed.
- The DEX files, for the classes of the app's own code: how many keep the name they were given (a capital and lower case, as a person names a class) and how many R8 or ProGuard shortened. The app's own code is under the package that its manifest's classes share with its package name, to which a debug build may add a suffix such as `.debug`. Not counted are the classes the build writes for every app (`R`, `BuildConfig`), the ones the compiler makes for lambdas, and the classes the manifest names with the classes inside them: Android finds those by name, so they keep it in any build. An app is reported from 50 named classes up, when they are at least half of its own.
- Hermes bytecode, by the eight bytes it opens with, wherever it sits, for its version and how many functions and strings it holds.

On real app packages, measured on 2026-10-16, with the counts checked against `aapt` and `dexdump`: Termux 0.118.3's debug build from its GitHub release was reported debuggable, as `aapt` says it is, with 209 of its 211 own classes named; Fossify Gallery 1.14.0 kept all 228 of its own classes named, Aegis 3.4.3 352 of 359 and NewPipe 0.29.1 1,122 of 1,202; Joplin 3.7.10 holds Hermes bytecode of version 96 with 71,791 functions, as its header reads with `od`. Bundles made from the Termux and Fossify packages with `aapt2 convert` and `bundletool build-bundle` were read the same, and `bundletool dump manifest` gives the same package names and `android:debuggable`. None of the seven apps tried was signed with the debug key (Termux signs its debug builds with a key of its own), and none had its classes shortened by R8. The debug key check was tried on a package signed with `jarsigner` by a key that `keytool` made with Android's debug subject, and an app that R8 shortened only on test packages made here.

## What the fixes change, measured

Measured on 2026-10-14 with rea 6.4.0, on macOS on Apple silicon, on two small apps written for the purpose. The numbers say what a fix changes in what a tool reads. They are not a promise about your app. On 2026-10-16 rea 6.5.0, the release `measure` now runs, gave the same counts for the web app's builds; the macOS program was not measured again.

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

A Rust program, measured on 2026-10-15: rustc 1.98.1, three source files and one dependency taken from the Cargo registry folder, built with `strip = true`. One name was left in its symbol table, and the paths of its 3 source files and of 2 files of the dependency stayed as text, those 2 under the home folder of the machine that built it. Built again with `--remap-path-prefix=$HOME=~`, no path named the home folder, and the 3 file names stayed. Reaproof's note gave the same counts for both builds.

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

`npx reaproof https://your-site.example` reads one page and the code files that page loads from its own address, at most 60 of them, one after another. For each code file it looks for a map where the file or the server says one is, and beside the file, where a "hidden" map is written. Nothing fetched is saved, and a file over 30 MB is not downloaded: the report counts it as skipped.

If the address you type redirects, to `www` or to `https` for example, the place it ends up is the site that gets checked. A code file that redirects to another site is not followed, and a file that names many maps is asked for the last one only, so what a page serves cannot send the check anywhere else.

When the address does not answer, the report says why (the status the server gave, a timeout, a refused connection) and the exit code is 3.

It checks source maps only. Looking for keys and stray files is done on the build output, by someone who holds the files. Code that the page loads later or from another address is not checked, and the report says how many files were left out. Use it on sites you run.

## Measuring with the real rea

`reaproof measure` downloads the `rea-agents` package with `npx` and runs its static JavaScript analysis on your build output only, with install scripts disabled. rea is someone else's program, so the command asks before it does that; in a script or with an AI agent, pass `--yes`. It reports how many readable source maps, original file names, server addresses, request sites and functions rea recovered. Run it before and after the fix to see the difference.

It runs one fixed release of rea, 6.5.0, the one this version was tested against. A published release cannot change afterwards. Newer releases are adopted here after they have been tested.

## Not covered yet

- Disk images, installers and archives that are neither ZIP nor tar compressed with gzip (`.dmg`, `.pkg`, `.7z`, `.rar`, `.tar.xz`, `.tar.zst` and the like). They are not opened. The report lists them as unread; point Reaproof at the app or folder inside. For a `.dmg` it says how to open one. A ZIP with something in front of it, as a self-extracting program or a `.crx` has, is not opened either.
- Switches an Electron app's own code turns on, such as `app.commandLine.appendSwitch('remote-debugging-port')`. Whether such a call runs in the release depends on conditions the code checks while it runs: of the five calls in four of the apps in `/Applications` on the test Mac, two run only in development, two open a port the app itself uses, and one is called without a condition near it, which reading the code cannot tell apart.
- Signatures of Windows and Linux programs: whether a Windows program is signed (Authenticode), or which certificate signed one, is not checked.
- The screen code inside a Tauri app. The report names the program it sits in; point Reaproof at the build output in the project folder instead.
- Source paths that programs built with C or C++ keep as text outside their debug information. Those of Rust and Go are the ones listed.
- Server addresses and prompts inside a native program. Those two are looked for in JavaScript only.
- Keys written in source map and CSS files. A map that embeds your sources is reported as critical by itself, but a key in those sources is not listed with it. A map embeds the sources of dependencies too, and their documentation carries example keys, so the two have to be told apart first.
- Which certificate signed a macOS program. An ad-hoc or development signature is not told apart from a release one.
- The settings of an Android app's network security or backups, and the names of methods and fields in DEX code: only class names are counted. Nor is an app's code outside its own package: an app built from many modules may keep most of it elsewhere (Thunderbird 24.0 keeps 16 classes under its package name and over 3,000 under others), and only those 16 are counted.
- Dependencies in folders other than `node_modules`, `site-packages` and `dist-packages`. A Ruby gem folder or a copied-in library is read like your own files, so the notes, scripts and test keys of the libraries in it are reported as if they were yours.
- Public-variable prefixes other than the nine listed above.
- Very large files. A code or text file over 30 MB, any file over 512 MB inside an archive, and any other file over 1 GB are not read, and the report counts them as skipped. A source map over 30 MB is the exception: it is reported, without the count of its files.

## Development

```bash
npm test
```

No dependencies. Node.js 18.3 or later. The tests write their own Mach-O files and archives and run anywhere; each change is run on Linux, macOS and Windows with Node 18, 20, 22 and 24. Five more tests use the system's own tools where they are there. On a Mac with `clang` and `codesign`, two build, sign and strip throwaway programs, never start them, and check that Reaproof reads them the way `codesign` does and that `strip` takes out what was reported. Where `zip` is installed, one checks that an archive it wrote is read the same as the folder it was made from. Where `cargo` is installed, one builds a small Rust program, never starts it, and checks that the paths of its own two source files are what the note counts. Where `go` is installed, one builds a small Go program twice, as built and with `-trimpath -ldflags="-s -w"`, never starts them, and checks the note against what `go version -m` says, and that only the first keeps a symbol table.

The picture at the top is a run recorded in a real terminal with `docs/tools/capture.py` and drawn with `docs/tools/render-svg.mjs`. Each script says at its top how it is run.

## License

MIT
