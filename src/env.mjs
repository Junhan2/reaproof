import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEnvFileName } from './checks/paths.mjs';
import { isCredentialAddress } from './checks/secrets.mjs';

// Each of these prefixes is documented by its framework as "sent to the browser":
// Next.js, Vite, Create React App, Astro and Expo.
const PUBLIC_PREFIX = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)/;
// A public prefix does not make a secret safe to publish.
const SECRET_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE/;
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * @typedef {{ variable: string, value: string, envFile: string, severity: 'critical' | 'high' }} EnvSecret
 */

/**
 * Reads the project's own dotenv files and keeps the values that must not reach users.
 * Checking for these exact values needs no guess about what a key looks like.
 *
 * @param {string} projectRoot absolute path; anything without dotenv files yields nothing
 * @returns {EnvSecret[]}
 */
export function readEnvSecrets(projectRoot) {
  const entries = [];
  for (const envFile of listEnvFiles(projectRoot)) {
    for (const [variable, value] of parseEnvFile(join(projectRoot, envFile))) {
      entries.push({ variable, value, envFile });
    }
  }

  // A value the project also publishes on purpose under another name is not a secret.
  const publishedValues = new Set(
    entries.filter(({ variable }) => isPublishedOnPurpose(variable)).map(({ value }) => value),
  );
  const secrets = new Map();
  for (const { variable, value, envFile } of entries) {
    if (isPublishedOnPurpose(variable) || publishedValues.has(value) || !looksSecret(value)) continue;
    const severity = PUBLIC_PREFIX.test(variable) ? 'high' : 'critical';
    secrets.set(variable, { variable, value, envFile, severity });
  }
  return [...secrets.values()];
}

/**
 * Reports each secret value that appears word for word in one shipped file. Every file is
 * judged by itself: a value that sits in two files is still there when one of them is removed.
 *
 * @param {EnvSecret[]} envSecrets
 */
export function checkEnvValues(path, text, envSecrets) {
  return envSecrets
    .filter(({ value }) => text.includes(value))
    .map(({ variable, envFile, severity }) => ({ rule: 'env-value', severity, path, detail: { variable, envFile } }));
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
  // Unquoted values end at an inline comment.
  return rawValue.replace(/\s+#.*$/, '');
}

function isPublishedOnPurpose(variable) {
  return PUBLIC_PREFIX.test(variable) && !SECRET_NAME.test(variable);
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
