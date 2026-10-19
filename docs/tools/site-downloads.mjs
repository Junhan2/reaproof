// Writes the npm download count into the site before it is published: the total since the first
// release, as npm counts it. The page in the repository keeps that line hidden; this fills in the
// copy that is uploaded and shows it. When npm does not answer, the copy is left as it is, the
// line stays hidden, and the site is published all the same.
//   node docs/tools/site-downloads.mjs <site folder>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = 'reaproof';
const FIRST_RELEASE = '2026-10-13';
const TIMEOUT_MS = 15_000;

const [siteDir] = process.argv.slice(2);
const pagePath = join(siteDir, 'index.html');
const today = new Date().toISOString().slice(0, 10);

try {
  const response = await fetch(`https://api.npmjs.org/downloads/point/${FIRST_RELEASE}:${today}/${PACKAGE}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const { downloads } = await response.json();
  if (!response.ok || !Number.isInteger(downloads)) throw new Error(`npm answered ${response.status}`);
  writeFileSync(pagePath, withDownloads(readFileSync(pagePath, 'utf8'), downloads));
  console.log(`npm downloads since ${FIRST_RELEASE}: ${downloads}`);
} catch (error) {
  console.log(`::warning::The npm download count was not added: ${error.message}`);
}

/** The page with the count in place and its line shown; every part must be found once. */
function withDownloads(page, downloads) {
  const shown = downloads.toLocaleString('en-US');
  const swaps = [
    ['<div class="wrap" data-downloads hidden>', '<div class="wrap" data-downloads>'],
    ['<span data-count aria-hidden="true"></span>', `<span data-count="${downloads}" aria-hidden="true">${shown}</span>`],
    ['<span class="sr-only" data-count-text></span>', `<span class="sr-only">${shown}</span>`],
  ];
  return swaps.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`the page has no single ${from}`);
    return text.replace(from, to);
  }, page);
}
