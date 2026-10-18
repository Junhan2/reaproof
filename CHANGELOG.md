# Changelog

What changed in each release published to npm, newest first.

## Unreleased (not published yet)

- Opens the result as a page in your browser when you run it at a terminal, for whoever a terminal report says little to: the rating large on its scale, what to do next with the fix it can make first, then each kind of leak as a card with where it was found and how to fix it, in the words the terminal uses. After `fix`, the page opens again with the rating before the fix struck out, the build setting that keeps maps away, and how to undo it. On 45 test targets every page shows the rating, the leak counts and the items of each kind that the JSON holds.
- The page is one HTML file with no script and nothing to load, so text copied from a scanned file is shown as text and nothing in it runs. It is kept in `~/.reaproof/pages`, never in the project, and no browser is opened in CI, over SSH or on Linux without a display. `--no-open` keeps the browser closed.
- With `--json`, the result names its page in `page`, so an agent can show it to you. The text a pipe gets and the rest of the JSON are as they were.

## 0.8.0 (2026-10-18)

- Reads only what browsers load of a server-rendering build: the `client` or `public` half beside `server`, with SvelteKit's `prerendered` pages, as SvelteKit's Node adapter, React Router, Astro and Nuxt write a build, picked by name or pointed at. On 22 test apps built with Next.js 16.4.2, Vite 8.3.4, SvelteKit 3.1.0, Nuxt 4.6.2, Astro 7.4.0 and React Router 8.4.0, 0.7.0 rated 4 of the 8 apps built right with a leak, from keys, an AI prompt and code that stay on the server; now none of them. The report names such builds, and the JSON lists them in `serverBuilds`. An Electron or Tauri project is still read whole: an app installs all of its output, a server in it too.
- Reads out of the server code what the server puts into every page, as browser code: the scripts Astro puts into the pages it renders, and the public part of Nuxt's runtime config. 0.7.0 missed a server key in Nuxt's, and listed one in Astro's among 15 false alarms from the same build. The JSON lists them in `serverSent`; where a build does not hold them in the form Astro 7.4.0 and Nuxt 4.6.2 write them, the report says they were not read, and the JSON lists the build in `serverSentUnread`.
- Reads SvelteKit's own build in `.svelte-kit/output` when no other output is there, as SvelteKit's default adapter leaves it on a machine that is not where it deploys: 0.7.0 stopped with "no build output" after the build succeeded.
- Reports a Google API key in browser code that calls Gemini, as Google AI Studio's app template hands one over, and not the key of a Firebase app config beside it. 0.7.0 found such a key only when the same value sat in a `.env` file.
- Compares the environment it runs in with what ships, for variables named like a secret and for addresses that carry a password, as it does values from `.env`: a CI job or a hosting platform has the build's values there. A token of the app's own, in no vendor's format, handed to browser code was found by 0.7.0 only with a `.env` file; now also in a CI job that builds and then checks. Each value compared is one more search through what ships: the 177 MB Joplin 3.7.10 APK took 0.56 s with no such variable and 1.16 s with 20.
- Takes the variables SvelteKit 3 declares `public: true` in `src/env.js` or `src/env.ts` for ones published on purpose, as it takes those with a public prefix: 0.7.0 reported the values of three public keys declared so as critical leaks. So it takes a variable with `PUBLISHABLE` as a part of its name, as `STRIPE_PUBLISHABLE_KEY`, and a value in the form of a Stripe or Supabase publishable key, unless the name also says it is a secret. A name with `PUBLIC` in it is not taken so: Railway names the outside address of a database, password and all, `DATABASE_PUBLIC_URL`.
- Does not take minified code for code left unminified because a template literal in it keeps its line breaks, as SvelteKit's error page does in every build: 0.7.0 rated each SvelteKit app moderate for it.
- Says which setting keeps maps out of the next build for Nuxt and Astro too.
- On the four public bundles and the 23 saved test targets of 0.7.0, the findings are the same.

## 0.7.0 (2026-10-17)

- Reads Linux and Android programs (ELF) and Windows programs (PE) for the names and debug information a release should not keep, as it read Mac programs: the symbol table, and DWARF debug information with the original file names. A default `go build` on Linux kept 2,519 names that 0.6.0 did not report.
- Notes a Windows program whose debug file path names a home folder of the machine that built it, and says how to leave only the file name. A `dotnet publish` from a home folder keeps such a path; with the `PathMap` property it did not.
- Reports `.pdb` debug files and the `mapping.txt` that R8 writes for an Android app when they ship. `dotnet publish` puts the `.pdb` beside the app by default; 0.6.0 rated such an output baseline.
- Notes what a Go program keeps after stripping: the names of its functions, the paths of its source files, and the module and dependencies its build info names. The counts match Go's own debug packages on the test programs and on fzf 0.74.5.
- Notes .NET assemblies, whose code reads back as C#, with how many types and methods they define. The counts match .NET's own metadata reader on five .NET runtime assemblies, the largest with 41,416 methods.
- Reports the server keys of 53 more services by the prefixes they are issued with: AI services (xAI, Groq, OpenRouter, Perplexity, Hugging Face and others), messages and mail (Slack, Discord and Slack webhooks, SendGrid, Brevo, Resend), payments (webhook signing secrets, Shopify, Square), code and package registries (GitLab, npm, PyPI, RubyGems, Docker Hub), and hosting, databases and monitoring (Supabase management tokens, DigitalOcean, Fly.io, Vault, Sentry, Grafana and others), and OpenAI's service account, admin and older keys. Those an app calls while it runs are looked for in programs too; the rest in text only. On the four public bundles and the 16 test apps, no new finding; on Homebrew the scan took no more than 6% longer.
- Shows the parts of a server address that look like a key or a token as `…`, in the list of server addresses and in `measure`: 0.6.0 listed a Discord webhook address whole, its token included.
- Reads Android app packages and app bundles: a debuggable or test-only build, one signed with the Android debug key, and an app whose own classes keep their names, as R8 would not leave them. Termux 0.118.3's debug build from GitHub was rated baseline before; it is high now, and debuggable, as `aapt` says. A bundle (`.aab`) made from it reads the same; 0.6.0 searched one for keys only.
- Notes Hermes bytecode, with how many functions and strings it holds, and reads React Native's bundle as JavaScript when it is, under another name ending in `.bundle` or `.jsbundle` too: before, `index.android.bundle` and `main.jsbundle` were only searched for keys.
- Notes a packaged Electron app for macOS or Windows that runs its code even after someone changed it: the two fuses that check `app.asar` against what was packaged are off, as they are by default. On the 17 Electron apps in `/Applications` of the test Mac it reads them as `@electron/fuses read` does.
- Reads the rest of an ASAR archive when one file in its header has no usable size or place, and lists that file as unread. A shipping app has such a file, with a negative size, and 0.6.0 left its whole archive unread.
- Opens tar archives, compressed with gzip or not (`.tar`, `.tgz`, `.tar.gz`), as `npm pack` writes a package and many Linux programs ship, and reads what is in them as if it lay on disk. 0.6.0 listed them as not opened. On fzf 0.74.5, ripgrep 15.2.0 and a package `npm pack` wrote, the findings are the same as for the folders they unpack into.
- Reads WebAssembly modules for the names of their functions and their DWARF debug information, as it reads native programs, and, as for a program, for the paths of Rust's sources. The counts match wabt's `wasm-objdump` on 12 modules found on the test Mac: one kept 282 names, and 5 kept source paths, 3 of them under the home folder of the machine that built them.
- Passes over the `packages` folder that sits beside Flutter's asset manifests, in an app and in a web build: it holds the files of the packages the app uses. A plugin's script there had rated LocalSend 1.18.2 moderate.
- Prints the result as SARIF 2.1.0 with `--sarif`, for GitHub code scanning and other review tools, with the fields GitHub requires and a fingerprint that stays the same from one run to the next. The output passes the SARIF 2.1.0 schema of OASIS, and the README shows a workflow that uploads it.
- Leaves out what `.reaproofignore` in the project folder lists, in patterns as `.gitignore` writes them, inside archives too, and names what it left out in the report and in the JSON (`ignored`). Given 20 paths and 11 pattern lines, it leaves out the same 17 paths as `git check-ignore`.
- Names a folder it has no permission to open as not read, and reads the rest. 0.6.0 stopped with an error of its own (exit code 4) at the first such folder.
- Leaves a map that `fix` cannot move where it is, names it, and moves the others. 0.6.0 stopped with an error of its own at the first such map.
- Searches a code or text file over 30 MB for keys and `.env` values, and names it as searched for those alone. 0.6.0 skipped it.
- Reads a deployed map between 30 MB and 256 MB a piece at a time for whether it holds source text, as it reads one on disk. 0.6.0 counted it as skipped.

## 0.6.0 (2026-10-16)

- Says when the screen code (HTML, JavaScript) of a Tauri app, which Tauri packs compressed into the program, was not read, and that it is checked in the project folder. Before, such an app could come out baseline with no word that its screen went unread. The JSON lists those programs in `unreadScreenCode`, and says it in `explain.unread`.
- Lists, as a note, the paths of Rust source files that a program keeps as text after stripping: how many are the program's own and how many its dependencies', and whether one names the home folder of the machine that built it, with how `--remap-path-prefix` replaces that folder. Only a program that holds Rust's standard library counts, so other programs with text that ends in `.rs` are not noted.
- Shows an example class name as its code spells it: a Swift class declared inside a function by its own name. A name that cannot be spelled so is left out instead of shown mangled.
- For a first run: says before it starts that it only reads, shows every rating level with the result's own in brackets, ends every report with what to do next, and colors the rating and the kind of each finding at a terminal (`NO_COLOR` turns color off).
- Reports a source map over 30 MB in a build output or an archive, which was only counted as skipped: it is searched a piece at a time for whether it holds source text and for values from `.env`, and its files are not counted. `fix` takes it out like any other map. On a deployed site a map that large is still counted as skipped.
- Reports a `.DS_Store` in what ships (medium): the Finder writes the names of the files in its folder into it, and on a website anyone can fetch it.
- Lists the kinds of finding worst first, as the README says. They were listed in a fixed order of kinds, which put a high finding such as a database file above a critical one.
- Does not enter Python's `site-packages` and `dist-packages`, as it does not enter `node_modules`, so the test keys and notes of libraries are not reported as yours.
- Takes the public prefixes of Nuxt (`NUXT_PUBLIC_`), Gatsby (`GATSBY_`), Vue CLI (`VUE_APP_`) and Storybook (`STORYBOOK_`) as public in the `.env` comparison.
- Names an option it does not know, or one used the wrong way, in plain words instead of Node's message.
- An error inside Reaproof itself ends with exit code 4, a message that says where to report it and, under it, where in the code it happened (`stack` in the JSON with `--json`). It ended with 1, which a release check took for a leak found, and a stack trace alone.
- A `.env` line with a long run of spaces no longer slows the check: reading one with 160,000 spaces took 13.4 seconds and now takes under a millisecond.
- `measure` runs rea 6.5.0, which gave the same counts as 6.4.0 on the test app's builds.
- Agent skill: what to do when `unreadScreenCode` lists a program, and what the `source-paths` note asks of the user.
- The README opens with a real run, what each rating means and how a run goes. The two scripts that recorded and drew that run are kept in `docs/tools`.

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
