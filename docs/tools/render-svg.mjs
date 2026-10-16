// Draws a recorded terminal session as an SVG: the text exactly as the terminal showed it,
// wrapped at the terminal's width, with the colors its escape codes asked for.
//
// usage: node render-svg.mjs IN.ansi OUT.svg COLUMNS TITLE [KEEP]
// KEEP picks lines of the plain text by number, 1-based, as "1-14,⋯,33-36"; a "⋯" there
// draws one dim line that says lines were left out. Without KEEP every line is drawn.
// Every character is taken to fill one column, so a recording with wide characters, such as
// a report in Korean, is not wrapped where the terminal wrapped it.
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath, columnsArg, title, keepArg] = process.argv.slice(2);
const COLUMNS = Number(columnsArg);
const FONT_SIZE = 13;
const LINE_HEIGHT = 19;
// Each line is set to exactly this much per character (textLength), whichever monospace font
// the viewer has, so wrapped rows line up as they did in the terminal.
const CHAR_WIDTH = 8;
const PAD_X = 20;
const PAD_TOP = 48;
const PAD_BOTTOM = 18;
const COLORS = {
  background: '#0f1419',
  frame: '#2a3038',
  text: '#e6edf3',
  dim: '#7d8590',
  31: '#ff7b72',
  32: '#3fb950',
  33: '#e3b341',
  35: '#d2a8ff',
  36: '#56d4dd',
};
const PLAIN = { bold: false, dim: false, color: null };

// The session as lines of styled runs. Only color codes are kept; cursor moves, as readline
// sends around a question, are dropped, which leaves what the terminal showed.
function parse(raw) {
  const lines = [[]];
  let style = PLAIN;
  // A carriage return starts no new line, so it is dropped; only a line feed does.
  const text = raw.replace(/\r/g, '');
  const pattern = /\x1b\[([0-9;]*)([A-Za-z])|([^\x1b]+)/g;
  for (const [, params, command, plain] of text.matchAll(pattern)) {
    if (plain !== undefined) {
      plain.split('\n').forEach((piece, index) => {
        if (index > 0) lines.push([]);
        if (piece) lines.at(-1).push({ text: piece, ...style });
      });
    } else if (command === 'm') {
      for (const code of (params || '0').split(';').map(Number)) {
        if (code === 0) style = PLAIN;
        else if (code === 1) style = { ...style, bold: true };
        else if (code === 2) style = { ...style, dim: true };
        else if (code === 22) style = { ...style, bold: false, dim: false };
        else if (code === 39) style = { ...style, color: null };
        else if (COLORS[code]) style = { ...style, color: code };
      }
    }
  }
  if (lines.at(-1).length === 0) lines.pop();
  return lines;
}

/** One line as the terminal shows it: cut into rows of COLUMNS characters. */
function wrap(runs) {
  const rows = [[]];
  let used = 0;
  for (const run of runs) {
    let rest = run.text;
    while (rest.length > 0) {
      const room = COLUMNS - used;
      if (room === 0) {
        rows.push([]);
        used = 0;
        continue;
      }
      rows.at(-1).push({ ...run, text: rest.slice(0, room) });
      used += Math.min(room, rest.length);
      rest = rest.slice(room);
    }
  }
  return rows;
}

function pick(lines) {
  if (!keepArg) return lines;
  return keepArg.split(',').flatMap((part) => {
    if (part === '⋯') return [[{ ...PLAIN, text: '⋯', dim: true }]];
    const [from, to = from] = part.split('-').map(Number);
    return lines.slice(from - 1, to);
  });
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tspan(run) {
  const fill = run.color ? COLORS[run.color] : run.dim ? COLORS.dim : COLORS.text;
  const weight = run.bold ? ' font-weight="700"' : '';
  const opacity = run.dim && run.color ? ' fill-opacity="0.7"' : '';
  return `<tspan fill="${fill}"${weight}${opacity}>${escape(run.text)}</tspan>`;
}

const rows = pick(parse(readFileSync(inPath, 'utf8'))).flatMap(wrap);
const width = PAD_X * 2 + COLUMNS * CHAR_WIDTH;
const height = PAD_TOP + rows.length * LINE_HEIGHT + PAD_BOTTOM;
const body = rows
  .map((row, index) => {
    // An empty row draws nothing but still takes its place.
    if (row.length === 0) return '';
    const y = PAD_TOP + (index + 1) * LINE_HEIGHT - 5;
    const characters = row.reduce((sum, run) => sum + [...run.text].length, 0);
    const fit = `textLength="${(characters * CHAR_WIDTH).toFixed(1)}" lengthAdjust="spacingAndGlyphs"`;
    return `<text x="${PAD_X}" y="${y}" ${fit} xml:space="preserve">${row.map(tspan).join('')}</text>`;
  })
  .filter(Boolean)
  .join('\n  ');

writeFileSync(
  outPath,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${COLORS.background}" stroke="${COLORS.frame}"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="22" text-anchor="middle" fill="${COLORS.dim}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', sans-serif" font-size="12">${escape(title)}</text>
  <g font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">
  ${body}
  </g>
</svg>
`,
);
console.log(`rows ${rows.length}, ${width}x${height}`);
