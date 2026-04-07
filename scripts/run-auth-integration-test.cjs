#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');

function createMaskedOutputStream() {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!output.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });

  output.muted = false;
  return output;
}

async function promptForCredentials() {
  const output = createMaskedOutputStream();
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    const username = (await rl.question('MangaUpdates username: ')).trim();

    process.stdout.write('MangaUpdates password: ');
    output.muted = true;
    const password = (await rl.question('')).trim();
    output.muted = false;
    process.stdout.write('\n');

    return { username, password };
  } finally {
    rl.close();
  }
}

async function run() {
  if (process.env.CI === 'true') {
    console.error('Interactive auth integration test cannot run in CI.');
    process.exit(1);
  }

  let username = typeof process.env.MU_TEST_USERNAME === 'string'
    ? process.env.MU_TEST_USERNAME.trim()
    : '';
  let password = typeof process.env.MU_TEST_PASSWORD === 'string'
    ? process.env.MU_TEST_PASSWORD.trim()
    : '';

  if (!username || !password) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('No interactive terminal detected. Set MU_TEST_USERNAME and MU_TEST_PASSWORD and retry.');
      process.exit(1);
    }

    const prompted = await promptForCredentials();
    username = prompted.username;
    password = prompted.password;
  }

  if (!username || !password) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  process.stdout.write('[auth-test-runner] Launching manual auth integration test...\n');
  process.stdout.write('[auth-test-runner] Token logs are enabled by default.\n');
  process.stdout.write('[auth-test-runner] Set MU_TEST_SHOW_FULL_TOKEN=1 to print the full token.\n\n');

  const child = spawn(
    process.execPath,
    ['--test', '--test-concurrency=1', 'tests/integration/runtime-wrapper-auth-integration.manual.cjs'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ENABLE_REAL_AUTH_TEST: '1',
        MU_TEST_USERNAME: username,
        MU_TEST_PASSWORD: password,
      },
    },
  );

  child.on('exit', (code) => {
    process.exit(typeof code === 'number' ? code : 1);
  });

  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
