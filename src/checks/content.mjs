// Checks on what a code file says, beyond maps and keys.

// Hand-written code averages a few dozen characters a line; minified output runs to thousands.
// A file of a few lines says too little either way.
const MIN_HANDWRITTEN_LINES = 10;
const MAX_HANDWRITTEN_LINE_LENGTH = 200;
// What minifying takes away is the names and the layout of code. A file that only lays out
// data has neither to lose, however many lines it runs to: the page list Next.js writes
// into a build is one such, and no setting of the project's would minify it.
const CODE_WORD = /\b(?:function|return|const|let|var|class|if|for|while|import|export)\b|=>/g;
const MIN_CODE_WORDS = 5;

const ABSOLUTE_ADDRESS = /https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9_\-./%:@~+]{0,200})?/g;
const RELATIVE_API_PATH = /["'`](\/(?:api|graphql|rest|rpc)\b[A-Za-z0-9_\-./:[\]{}$]{0,120})/g;
const API_HOST = /^api[.-]|[.-]api[.-]/i;
const API_PATH = /(?:^|\/)(?:api|graphql|rest|rpc|v\d{1,2})(?:\/|$)/i;
const MAX_ADDRESSES_PER_FILE = 50;

// A prompt assigns a role and then gives orders. Library warnings ("You are using an outdated
// version...") do the first half only, so both halves are required.
const PROMPT_OPENING = /You are (?:an?|the) |Your task is |당신은 |너는 /g;
const PROMPT_DIRECTIVE = /\b(?:always|never|must|do not|don't|should)\b|반드시|절대|하지 마|해야/i;
const QUOTES = ['"', "'", '`'];
const MIN_PROMPT_LENGTH = 160;
const MAX_PROMPT_LENGTH = 6000;
const MIN_PROMPT_SPACES = 20;
const PROMPT_PREVIEW_LENGTH = 60;

/** Code that kept its names and line breaks reads as written. */
export function checkUnminifiedCode(path, text) {
  const lineCount = countLines(text);
  const averageLineLength = Math.round(text.length / lineCount);
  if (lineCount < MIN_HANDWRITTEN_LINES || averageLineLength >= MAX_HANDWRITTEN_LINE_LENGTH) return [];
  if (!holdsCode(text)) return [];
  return [{ rule: 'unminified-code', severity: 'medium', path, detail: { averageLineLength } }];
}

function holdsCode(text) {
  let count = 0;
  for (const _ of text.matchAll(CODE_WORD)) {
    count += 1;
    if (count === MIN_CODE_WORDS) return true;
  }
  return false;
}

/**
 * Lists the server addresses a code file names. They cannot be hidden, so this is a note
 * for the owner to review, not a leak.
 */
export function checkEndpoints(path, text) {
  const addresses = new Set();
  for (const [address] of text.matchAll(ABSOLUTE_ADDRESS)) {
    if (looksLikeApi(address)) addresses.add(address);
  }
  for (const [, apiPath] of text.matchAll(RELATIVE_API_PATH)) addresses.add(apiPath);
  if (addresses.size === 0) return [];
  const listed = [...addresses].slice(0, MAX_ADDRESSES_PER_FILE);
  return [{ rule: 'endpoint', severity: 'info', path, detail: { addresses: listed } }];
}

/**
 * Finds long instruction-like strings, the shape of a prompt written into client code.
 * It is a guess from wording, so it is reported as a candidate.
 */
export function checkPromptCandidates(path, text) {
  const findings = [];
  const reportedStarts = new Set();
  for (const { index } of text.matchAll(PROMPT_OPENING)) {
    const literal = enclosingStringLiteral(text, index);
    if (!literal || reportedStarts.has(literal.start) || !PROMPT_DIRECTIVE.test(literal.text)) continue;
    reportedStarts.add(literal.start);
    const preview = literal.text.slice(0, PROMPT_PREVIEW_LENGTH).replace(/\s+/g, ' ');
    findings.push({ rule: 'prompt-candidate', severity: 'medium', path, detail: { preview, length: literal.text.length } });
  }
  return findings;
}

function countLines(text) {
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1;
  return lines;
}

function looksLikeApi(address) {
  try {
    const { hostname, pathname } = new URL(address);
    return API_HOST.test(hostname) || API_PATH.test(pathname);
  } catch {
    return false;
  }
}

/**
 * The longest prose-like string literal around a position. Each quote style is tried,
 * because an apostrophe inside the prose would otherwise end the literal early.
 */
function enclosingStringLiteral(text, position) {
  let best = null;
  for (const quote of QUOTES) {
    const start = previousUnescaped(text, quote, position);
    if (start === -1) continue;
    const end = nextUnescaped(text, quote, position);
    if (end === -1) continue;
    const literal = text.slice(start + 1, end);
    const isProse = literal.length >= MIN_PROMPT_LENGTH && literal.split(' ').length > MIN_PROMPT_SPACES;
    if (isProse && (!best || literal.length > best.text.length)) best = { start, text: literal };
  }
  return best;
}

// Both searches stay inside a window of MAX_PROMPT_LENGTH characters and use the built-in
// search, so a window without the quote costs one short search, not a step per character.
function previousUnescaped(text, quote, position) {
  const earliest = Math.max(0, position - MAX_PROMPT_LENGTH);
  const before = text.slice(earliest, position);
  for (let index = before.lastIndexOf(quote); index !== -1; index = before.lastIndexOf(quote, index - 1)) {
    if (text[earliest + index - 1] !== '\\') return earliest + index;
    // `lastIndexOf` treats a start below zero as zero and would find this same quote again.
    if (index === 0) break;
  }
  return -1;
}

function nextUnescaped(text, quote, position) {
  const after = text.slice(position, position + MAX_PROMPT_LENGTH);
  for (let index = after.indexOf(quote); index !== -1; index = after.indexOf(quote, index + 1)) {
    if (text[position + index - 1] !== '\\') return position + index;
  }
  return -1;
}
