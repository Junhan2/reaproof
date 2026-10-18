// A result as a page in a browser, for someone who does not read a terminal report: the rating
// first and large, what to do next, then each kind of leak as a card. It is one file with no
// script and nothing to load, so it opens anywhere, offline too, and nothing a scanned file
// holds can run in it.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { projectKey, reaproofHome } from './fix.mjs';
import { toWindowsShellArgument } from './measure.mjs';
import { toPrintable } from './text.mjs';

// No script, no request, no form: the page is its text and its own style.
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// A list longer than this starts closed, so that the cards after it stay in reach.
const MAX_OPEN_ITEMS = 10;
// How long a browser is given to say it took the page.
const OPEN_TIMEOUT_MS = 10_000;

/** Text made safe for the page: nothing unseen stays, and nothing is read as markup. */
const text = (value) => toPrintable(String(value)).replace(/[&<>"']/g, (character) => ESCAPES[character]);

/**
 * @param {object} view what `report.sections` makes of a result
 * @param {{ version: string, madeAt: Date }} meta
 * @returns {string} the whole page
 */
export function renderPage(view, { version, madeAt }) {
  const { labels, risk, leaks, fixed, nextBuild, limits } = view;
  const counts = leaks ? Object.entries(leaks).map(([severity, count]) => ` data-${severity}="${count}"`).join('') : '';
  return `<!doctype html>
<html lang="${view.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${text(`Reaproof · ${labels.heading} · ${risk.name}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><div class="wrap"><p class="brand">Reaproof</p><p class="meta">${text(labels.heading)} · <time datetime="${madeAt.toISOString()}">${localTime(madeAt)}</time> · ${text(version)}</p></div></header>
<main class="wrap" data-risk="${risk.level}"${counts}>
${verdictSection(view)}
${nextSection(view)}
${listSection('fixed', labels.fixedTitle, fixed ? [...fixed.moved, ...fixed.undo] : [])}
${listSection('unread', labels.unreadTitle, view.unread)}
${cardsSection('leaks', labels.leaksTitle, view.leakRules, labels)}
${fixed ? '' : listSection('build', nextBuild?.title, nextBuild?.lines ?? [])}
${cardsSection('notes', labels.notesTitle, view.noteRules, labels)}
${listSection('limits', limits?.title, limits?.lines ?? [])}
</main>
<footer class="wrap foot">${view.deployedScope ? `<p>${text(view.deployedScope)}</p>` : ''}<p>${text(labels.footer)}</p></footer>
</body>
</html>
`;
}

/** `2026-10-18 17:40`, in the time zone of the machine the check ran on. */
function localTime(date) {
  const two = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const listItems = (lines) => lines.map((line) => `<li>${text(line)}</li>`).join('');

/** A part of the page under its own heading. `heading` is markup already made safe. */
function section(name, heading, body) {
  return `<section class="${name}" aria-labelledby="${name}-title">
<h2 id="${name}-title">${heading}</h2>
${body}
</section>`;
}

/**
 * The rating, large, on the scale of every level, with what it means and what was read. After a
 * fix, the rating before it too, struck out.
 */
function verdictSection({ labels, risk, levels, leakLine, read, readNotes, fixed }) {
  const scale = levels
    .map(({ level, name }) =>
      level === risk.level ? `<li class="is-current" aria-current="true">${text(name)}</li>` : `<li>${text(name)}</li>`,
    )
    .join('');
  const was = fixed
    ? `<p class="was">${text(labels.was)}: <s class="risk-${fixed.before.level}">${text(fixed.before.name)}</s></p>`
    : '';
  return `<section class="verdict risk-${risk.level}" aria-labelledby="verdict-level">
<p class="eyebrow">${text(labels.risk)}</p>
<h1 id="verdict-level">${text(risk.name)}</h1>
${was}
${scale ? `<ol class="scale" aria-label="${text(labels.levels)}">${scale}</ol>` : ''}
<p class="summary">${text(risk.summary)}</p>
${leakLine ? `<p class="leak-count">${text(labels.leaks)}: <strong>${text(leakLine)}</strong></p>` : ''}
<ul class="read">${listItems([read.target, read.scanned, ...readNotes])}</ul>
</section>`;
}

/**
 * What to do next, the easiest first: the fix that can be made for the reader, or, once it is
 * made, the build setting that keeps it from coming back.
 */
function nextSection({ labels, nextSteps, autoFix, fixed, nextBuild }) {
  let first = '';
  if (autoFix) first = `<p class="callout">${text(autoFix)}</p>`;
  else if (fixed) {
    first = `<div class="callout"><p><strong>${text(nextBuild.title)}</strong></p><ul class="plain">${listItems(nextBuild.lines)}</ul></div>`;
  }
  if (nextSteps.length === 0 && !first) return '';
  return section('next', text(labels.nextTitle), `${first}\n${nextSteps.length > 0 ? `<ol class="steps">${listItems(nextSteps)}</ol>` : ''}`);
}

function listSection(name, title, lines) {
  return lines.length > 0 ? section(name, text(title), `<ul class="plain">${listItems(lines)}</ul>`) : '';
}

function cardsSection(name, title, rules, labels) {
  if (rules.length === 0) return '';
  const heading = `${text(title)} <span class="count">${rules.length}</span>`;
  return section(name, heading, `<div class="cards">\n${rules.map((rule) => card(rule, labels)).join('\n')}\n</div>`);
}

/** One kind of finding: how bad, what it is and means, where it was found, and how to fix it. */
function card({ rule, severity, title, body, items, more, hints }, labels) {
  const total = items.length + more;
  const listed = items.map((item) => `<li><code>${text(item)}</code></li>`).join('');
  const rest = more > 0 ? `<li class="more">${text(labels.andMore(more))}</li>` : '';
  const list =
    total === 0
      ? ''
      : `<details${total <= MAX_OPEN_ITEMS ? ' open' : ''}><summary>${text(labels.list(total))}</summary><ul class="items">${listed}${rest}</ul></details>`;
  return `<article class="finding sev-${severity}" data-rule="${text(rule)}" data-items="${total}">
<p class="chip">${text(labels.severity[severity])}</p>
<h3>${text(title)}</h3>
${body.map((line) => `<p>${text(line)}</p>`).join('\n')}
${list}
${hints.length > 0 ? `<ul class="hints">${listItems(hints)}</ul>` : ''}
</article>`;
}

/** Where the page of a checked path is kept: outside the project, one for each path checked. */
export function pagePath(root) {
  return join(reaproofHome(), 'pages', `${projectKey(root).replace(/[^\p{L}\p{N}._-]+/gu, '_')}.html`);
}

/**
 * Keeps a page where `pagePath` says, never in the project or its output, where it could be
 * deployed. Only its owner can read it: it names the project's files.
 *
 * @returns {{ path: string } | { error: string }}
 */
export function savePage(root, page) {
  const path = pagePath(root);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, page, { mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error.code ?? String(error) };
  }
}

/**
 * Asks this machine to show a page in its default browser, where a person sits at its screen:
 * not in CI, not over SSH, and on Linux not without a display. False when it was not asked or
 * the asking failed.
 */
export function openInBrowser(path, environment = process.env, platform = process.platform) {
  const isCi = Boolean(environment.CI) && environment.CI !== 'false' && environment.CI !== '0';
  if (isCi || environment.SSH_CONNECTION || environment.SSH_TTY) return false;
  if (platform === 'darwin') return spawnSync('open', [path], { stdio: 'ignore', timeout: OPEN_TIMEOUT_MS }).status === 0;
  if (platform === 'win32') {
    let argument;
    try {
      argument = toWindowsShellArgument(path);
    } catch {
      return false;
    }
    // `start` takes its first quoted word for a window title, so an empty one goes first.
    const options = { stdio: 'ignore', timeout: OPEN_TIMEOUT_MS, windowsVerbatimArguments: true };
    return spawnSync('cmd', ['/d', '/s', '/c', `start "" ${argument}`], options).status === 0;
  }
  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) return false;
  if (!isOnPath('xdg-open', environment.PATH)) return false;
  // xdg-open can stay until the browser closes, so it is let go rather than waited for.
  spawn('xdg-open', [path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  return true;
}

function isOnPath(program, path = '') {
  return path.split(delimiter).some((folder) => {
    try {
      accessSync(join(folder, program), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Colors as tokens, a light set and a dark one, and the severities as Reaproof's terminal paints them.
const STYLE = `
:root {
  --bg: #ffffff; --fg: #171614; --muted: #5f5b53; --line: #e4e1da; --panel: #f6f5f1;
  --critical: #b3261e; --critical-tint: #fceeec; --high: #b9410e; --high-tint: #fdf0e8;
  --medium: #855d00; --medium-tint: #fbf3dc; --info: #44505f; --info-tint: #eef0f3;
  --baseline: #1e7639; --unrated: #6a3fb5;
  --sans: system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "D2Coding", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141412; --fg: #ecebe6; --muted: #a9a59c; --line: #33312c; --panel: #1d1c19;
    --critical: #ff8f80; --critical-tint: #3b1915; --high: #ffa466; --high-tint: #3b2213;
    --medium: #f0c95a; --medium-tint: #332a10; --info: #b9c3d0; --info-tint: #20242a;
    --baseline: #72d48f; --unrated: #c2a6ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 var(--sans); -webkit-text-size-adjust: 100%; }
.wrap { max-width: 880px; margin: 0 auto; padding-inline: 20px; }
h1, h2, h3 { margin: 0; line-height: 1.25; text-wrap: balance; }
h2 { font-size: 1.25rem; }
p, ul, ol { margin: 0; }
code { font: 0.8125rem/1.5 var(--mono); overflow-wrap: anywhere; }
.bar { border-bottom: 1px solid var(--fg); }
.bar .wrap { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; padding-block: 14px; }
.brand { font-weight: 700; letter-spacing: -0.01em; }
.meta { color: var(--muted); font: 0.8125rem/1.4 var(--mono); }
main { display: grid; gap: 32px; padding-block: 28px 12px; }
section { display: grid; gap: 14px; min-width: 0; }
.risk-very-high { --risk: var(--critical); }
.risk-high { --risk: var(--high); }
.risk-moderate { --risk: var(--medium); }
.risk-baseline { --risk: var(--baseline); }
.risk-unrated { --risk: var(--unrated); }
.verdict { padding: 24px; border: 1px solid var(--fg); }
.eyebrow { color: var(--muted); font: 0.8125rem/1 var(--mono); letter-spacing: 0.02em; }
.verdict h1 { color: var(--risk); font-size: clamp(2.5rem, 9vw, 4rem); letter-spacing: -0.02em; }
.scale { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 0; list-style: none; }
.scale li { padding: 8px 4px; border: 1px solid var(--line); color: var(--muted); font-size: 0.8125rem; text-align: center; overflow-wrap: anywhere; }
.scale .is-current { background: var(--risk); border-color: var(--risk); color: var(--bg); font-weight: 700; }
.summary { font-size: 1.0625rem; }
.read { display: grid; gap: 2px; padding: 0; list-style: none; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
.was { color: var(--muted); }
.was s { color: var(--risk); font-weight: 600; }
.callout { display: grid; gap: 8px; padding: 14px 16px; border: 1px solid var(--fg); background: var(--panel); }
.steps { display: grid; gap: 8px; padding-left: 1.4em; }
.plain { display: grid; gap: 6px; padding-left: 1.2em; overflow-wrap: anywhere; }
.fixed, .unread { padding: 18px 20px; border: 1px solid var(--line); background: var(--panel); }
.count { color: var(--muted); font: 0.875rem/1 var(--mono); }
.cards { display: grid; gap: 14px; }
.finding { display: grid; gap: 10px; min-width: 0; padding: 18px 20px; border: 1px solid var(--line); border-left: 4px solid var(--sev); }
.sev-critical { --sev: var(--critical); --tint: var(--critical-tint); }
.sev-high { --sev: var(--high); --tint: var(--high-tint); }
.sev-medium { --sev: var(--medium); --tint: var(--medium-tint); }
.sev-info { --sev: var(--info); --tint: var(--info-tint); }
.chip { justify-self: start; padding: 3px 8px; background: var(--tint); color: var(--sev); font: 600 0.75rem/1.3 var(--mono); letter-spacing: 0.04em; }
.finding h3 { font-size: 1.125rem; }
details { padding-top: 10px; border-top: 1px solid var(--line); }
summary { color: var(--muted); font-size: 0.875rem; cursor: pointer; }
.items { display: grid; gap: 6px; margin-top: 10px; padding: 0; list-style: none; }
.more { color: var(--muted); font-size: 0.875rem; }
.hints { display: grid; gap: 6px; padding: 10px 14px; background: var(--panel); font-size: 0.9375rem; list-style: none; }
.foot { display: grid; gap: 6px; margin-top: 20px; padding-block: 20px 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.8125rem; }
@media (max-width: 520px) {
  .wrap { padding-inline: 16px; }
  .verdict, .fixed, .unread { padding: 18px 16px; }
  .finding { padding: 16px; }
  .scale li { padding: 6px 2px; font-size: 0.75rem; }
}
`;
