// npm run test:e2e          n8n in regular mode on SQLite (its default)
// npm run test:e2e:queue    n8n in queue mode: main + one worker, Redis, PostgreSQL
// Starts the test stack, runs test/e2e.test.mjs against it and removes the
// stack again. Set KEEP_STACK=1 to leave it running, for example to open the
// n8n editor on http://localhost:55683 and look at the executions
// (owner@example.com / Lab-owner-1234, created by the tests).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const queue = process.argv[2] === 'queue';
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', ...(queue ? ['-f', 'test/docker-compose.queue.yml'] : []), '-p', 'retryfx-test'];
const run = (command, args, env = {}) => spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

run('docker', [...compose, 'down', '-v']);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/e2e.test.mjs'], { MODE: queue ? 'queue mode with one worker, PostgreSQL' : 'regular mode, SQLite' });
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'n8n', ...(queue ? ['worker'] : [])]);
if (!process.env.KEEP_STACK) run('docker', [...compose, 'down', '-v']);
process.exit(status);
