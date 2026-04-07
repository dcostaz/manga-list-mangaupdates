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

async function promptForInput(questionText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    return (await rl.question(questionText)).trim();
  } finally {
    rl.close();
  }
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
    console.error('Interactive search integration test cannot run in CI.');
    process.exit(1);
  }

  let username = typeof process.env.MU_TEST_USERNAME === 'string'
    ? process.env.MU_TEST_USERNAME.trim()
    : '';
  let password = typeof process.env.MU_TEST_PASSWORD === 'string'
    ? process.env.MU_TEST_PASSWORD.trim()
    : '';
  let query = typeof process.env.MU_TEST_SEARCH_QUERY === 'string'
    ? process.env.MU_TEST_SEARCH_QUERY.trim()
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

  if (!query) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const promptedQuery = await promptForInput('Search query (default: One Piece): ');
      query = promptedQuery || 'One Piece';
    } else {
      query = 'One Piece';
    }
  }

  if (!username || !password || !query) {
    console.error('Username, password, and search query are required.');
    process.exit(1);
  }

  process.stdout.write('[search-test-runner] Launching manual search integration test...\n');
  process.stdout.write(`[search-test-runner] Query: ${query}\n`);
  process.stdout.write('[search-test-runner] Set MU_TEST_SHOW_FULL_SEARCH_PAYLOAD=1 for full payload logging.\n\n');

  const child = spawn(
    process.execPath,
    ['--test', '--test-concurrency=1', 'tests/integration/runtime-wrapper-search-integration.manual.cjs'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ENABLE_REAL_SEARCH_TEST: '1',
        MU_TEST_USERNAME: username,
        MU_TEST_PASSWORD: password,
        MU_TEST_SEARCH_QUERY: query,
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
