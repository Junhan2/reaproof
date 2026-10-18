import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEnvFileName } from './checks/paths.mjs';
import { isCredentialAddress } from './checks/secrets.mjs';

// Each of these prefixes is documented by its framework as "sent to the browser": Next.js,
// Vite, Create React App, Astro and SvelteKit, Expo, Nuxt (runtime config), Gatsby, Vue CLI
// and Storybook.
const PUBLIC_PREFIX = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|VUE_APP_|STORYBOOK_)/;
// A name with PUBLISHABLE as a word of it is public too, as STRIPE_PUBLISHABLE_KEY, which a
// build hands to browsers under its own name; and so is a value in the form its vendor issues
// keys for browsers in, Stripe's and Supabase's publishable keys, whatever it is called. A name
// with PUBLIC in it is not: Railway puts the outside address of a database, password and all,
// into DATABASE_PUBLIC_URL (docs.railway.com, "PostgreSQL").
const PUBLISHABLE_NAME = /(?:^|_)PUBLISHABLE(?:_|$)/;
const PUBLISHABLE_VALUE = /^(?:pk_(?:live|test)_|sb_publishable_)/;
// A public prefix does not make a secret safe to publish.
const SECRET_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE/;
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// SvelteKit 3 tells a public variable by a declaration and not by a prefix: `NAME: { public:
// true }` passed to `defineEnvVars` in src/env.js or src/env.ts (svelte.dev/docs/kit,
// "Environment variables"). A declaration runs to the brace that closes it, the braces of a
// validator function in it included, as the documentation writes one.
const SVELTEKIT_ENV_FILES = ['src/env.js', 'src/env.ts'];
const DECLARATION_OPENING = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
const DECLARED_PUBLIC = /\bpublic\s*:\s*true\b/;
const MAX_DECLARATIONS_LENGTH = 1024 * 1024;
// A build on a CI runner or a hosting platform has its values in the environment, not in a
// file. Of the environment only variables named like a secret are compared, an address that
// carries a password whatever its name, and those named as public, which say what is
// published on purpose: the rest are the machine's own values, and a build writes some of
// them into its output on purpose, as a commit hash.
const SECRET_LIKE_NAME = new RegExp(`(?:^|_)(?:KEY|TOKEN|CREDENTIALS?|DATABASE_URL|CONNECTION_STRING|${SECRET_NAME.source})(?:_|$)`);

/**
 * @typedef {{ variable: string, value: string, envFile: string | null, severity: 'critical' | 'high', forms: Buffer[] }} EnvSecret
 *   `envFile` is null for a value read from the environment; `forms` are the bytes the value
 *   is kept as in a file that is not text
 */

/**
 * Reads the project's own dotenv files, and the environment the scan runs in, and keeps the
 * values that must not reach users. Checking for these exact values needs no guess about
 * what a key looks like.
 *
 * @param {string} projectRoot absolute path; anything without dotenv files yields nothing from files
 * @param {Record<string, string | undefined>} environment the variables of the environment
 * @returns {EnvSecret[]}
 */
export function readEnvSecrets(projectRoot, environment) {
  const entries = [];
  for (const envFile of listEnvFiles(projectRoot)) {
    for (const [variable, value] of parseEnvFile(join(projectRoot, envFile))) {
      entries.push({ variable, value, envFile });
    }
  }
  const declaredPublic = readDeclaredPublic(projectRoot);
  const isPublic = (variable) => PUBLIC_PREFIX.test(variable) || PUBLISHABLE_NAME.test(variable) || declaredPublic.has(variable);
  const isPublishedOnPurpose = ({ variable, value }) =>
    (isPublic(variable) || PUBLISHABLE_VALUE.test(value)) && !SECRET_NAME.test(variable);
  for (const [variable, value] of Object.entries(environment)) {
    if (!value || !(SECRET_LIKE_NAME.test(variable) || isPublic(variable) || isCredentialAddress(value))) continue;
    entries.push({ variable, value, envFile: null });
  }

  // A value the project also publishes on purpose under another name is not a secret.
  const publishedValues = new Set(entries.filter(isPublishedOnPurpose).map(({ value }) => value));
  // A variable is compared once for each value it holds: a CI runner can set one that a dotenv
  // file also sets, to another value. The file, read first, names the place for the same value.
  const secrets = new Map();
  for (const { variable, value, envFile } of entries) {
    const key = `${variable}\0${value}`;
    if (secrets.has(key) || publishedValues.has(value) || !looksSecret(value)) continue;
    const severity = isPublic(variable) ? 'high' : 'critical';
    secrets.set(key, { variable, value, envFile, severity, forms: bytesOf(value) });
  }
  return [...secrets.values()];
}

/**
 * The bytes a value is kept as where it is not text: one to a character, for a value whose
 * characters fit in one, and two to a character, low byte first, as Windows programs, .NET
 * and Hermes keep text.
 */
function bytesOf(value) {
  const oneEach = /^[\0-\xff]*$/.test(value) ? [Buffer.from(value, 'latin1')] : [];
  return [...oneEach, Buffer.from(value, 'utf16le')];
}

/** The names a SvelteKit 3 project declares public. A declaration this reading cannot follow counts as none. */
function readDeclaredPublic(projectRoot) {
  const names = new Set();
  for (const file of SVELTEKIT_ENV_FILES) {
    let text;
    try {
      text = readFileSync(join(projectRoot, file), 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_DECLARATIONS_LENGTH || !text.includes('defineEnvVars')) continue;
    for (const match of text.matchAll(DECLARATION_OPENING)) {
      const opening = match.index + match[0].length - 1;
      if (DECLARED_PUBLIC.test(text.slice(opening, closingBrace(text, opening)))) names.add(match[1]);
    }
  }
  return names;
}

/** Where the brace that opens at `opening` is closed, or the end of the text. A brace in quotes is text. */
function closingBrace(text, opening) {
  let depth = 0;
  let quote = null;
  for (let at = opening; at < text.length; at += 1) {
    const character = text[at];
    if (quote) {
      if (character === '\\') at += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return at;
  }
  return text.length;
}

/**
 * Reports each secret value that appears word for word in one shipped file. Every file is
 * judged by itself: a value that sits in two files is still there when one of them is removed.
 *
 * @param {EnvSecret[]} envSecrets
 */
export function checkEnvValues(path, text, envSecrets) {
  return envSecrets.filter(({ value }) => text.includes(value)).map((secret) => toFinding(path, secret));
}

/**
 * The same over bytes that are not text, where a value sits as one of its `forms`: two bytes
 * to a character may start on either byte, and a search of the bytes finds both.
 *
 * @param {EnvSecret[]} envSecrets
 */
export function checkEnvValuesInBytes(path, bytes, envSecrets) {
  return envSecrets.filter(({ forms }) => forms.some((form) => bytes.includes(form))).map((secret) => toFinding(path, secret));
}

function toFinding(path, { variable, envFile, severity }) {
  return { rule: 'env-value', severity, path, detail: { variable, envFile } };
}

function listEnvFiles(projectRoot) {
  try {
    return readdirSync(projectRoot).filter(isEnvFileName).sort();
  } catch {
    // Not a directory, or not readable: there is nothing to compare against.
    return [];
  }
}

function parseEnvFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const pairs = [];
  for (const line of content.split(/\r?\n/)) {
    const assignment = line.trim().match(ASSIGNMENT);
    if (!assignment) continue;
    const value = unquote(assignment[2].trim());
    if (value) pairs.push([assignment[1], value]);
  }
  return pairs;
}

function unquote(rawValue) {
  const quote = rawValue[0];
  if ((quote === '"' || quote === "'") && rawValue.endsWith(quote) && rawValue.length > 1) {
    return rawValue.slice(1, -1);
  }
  // Unquoted values end at an inline comment. It is found by where it starts and not by a
  // pattern over the rest, which a long run of spaces would make slow to try.
  const comment = rawValue.search(/\s#/);
  return comment === -1 ? rawValue : rawValue.slice(0, comment).trimEnd();
}

/**
 * Long and random-looking, or an address that carries a password. Plain addresses, words
 * and version strings are left alone, because they legitimately show up in shipped files.
 */
function looksSecret(value) {
  if (isCredentialAddress(value)) return true;
  if (/\s/.test(value) || /^https?:\/\//.test(value)) return false;
  const hasLetterAndDigit = /[A-Za-z]/.test(value) && /\d/.test(value);
  const hasBothCases = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return hasLetterAndDigit && (value.length >= 32 || (value.length >= 20 && hasBothCases));
}
