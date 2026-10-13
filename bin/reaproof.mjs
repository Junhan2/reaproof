#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { main } from '../src/cli.mjs';

// Questions are asked only when a person is at both ends of the terminal.
const isAttended = Boolean(process.stdin.isTTY && process.stdout.isTTY);

process.exitCode = await main(process.argv.slice(2), {
  print: (text) => console.log(text),
  printError: (text) => console.error(text),
  ask: isAttended ? askYesOrNo : null,
  runBuild: ([program, ...args], directory) =>
    spawnSync(program, args, { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0,
});

async function askYesOrNo(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await readline.question(question)).trim());
  } catch {
    // Ctrl+D or an input that closed mid-question is a "no", not a crash.
    console.log('');
    return false;
  } finally {
    readline.close();
  }
}
