// End-to-end tests: the real workflows on a real n8n (test/stack.sh or
// npm run test:e2e). Each test tells the stand-in service which call to fail,
// starts a run over the webhook, retries the failed execution the way a
// person or a script would, and then counts what the stand-in received.
//
// Part 1 measures n8n without a guard. Part 2 repeats the cases through the
// Guarded call sub-workflow.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.N8N_URL ?? 'http://localhost:55683';
const SERVICE = process.env.STANDIN_URL ?? 'http://localhost:58085';
const MODE = process.env.MODE ?? 'regular mode, SQLite';
const LAB = 'retryFxLab000001';
const RUN = Date.now().toString(36);
const OWNER = { email: 'owner@example.com', firstName: 'Lab', lastName: 'Owner', password: 'Lab-owner-1234' };

let apiKey = '';
let cookie = '';
let counter = 0;
const report = [];
const note = (name, first, afterRetry, writes) => report.push({ name, first, afterRetry, writes });

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(500);
  }
}

// --- the stand-in -------------------------------------------------------------

const service = {
  control: (run, rule) => fetch(`${SERVICE}/control`, { method: 'POST', body: JSON.stringify({ run, ...rule }) }),
  log: async (run) => json(await fetch(`${SERVICE}/log?run=${encodeURIComponent(run)}`)),
};
// "1,2,3" = the items the service received, in order.
const sequence = (log, from = 0) => log.requests.slice(from).map((request) => request.item).join(',');
// How often each item was written: { 1: 2, 2: 2, ... }
const writes = (log) => {
  const count = {};
  for (const write of log.writes) count[write.item] = (count[write.item] ?? 0) + 1;
  return count;
};
const each = (items, times) => Object.fromEntries(Array.from({ length: items }, (_, index) => [index + 1, times]));
const show = (count) => Object.entries(count).map(([item, times]) => `${item}:${times}x`).join(' ');

// --- n8n ------------------------------------------------------------------------

const api = async (method, path, body, headers = {}) => {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'x-n8n-api-key': apiKey, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response) };
};
// What the editor calls when you press "Retry execution".
const rest = async (method, path, body) => {
  const response = await fetch(`${BASE}/rest${path}`, {
    method,
    headers: { cookie, 'browser-id': 'lab', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response), headers: response.headers };
};

// Starts one run of a lab case. The webhook answers when the run has ended.
async function start(name, { items = 1, fail, kind, times = 1, onUnknown, honorKey, run = `${RUN}-${name}-${++counter}` } = {}) {
  if (kind) await service.control(run, { item: fail ?? 1, kind, times });
  if (honorKey) await service.control(run, { honorKey: true });
  const response = await fetch(`${BASE}/webhook/retryfx/lab/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run, items, on_unknown: onUnknown }),
  });
  await response.text();
  return { run, status: response.status };
}

let lastFailed = 0;
// The newest failed execution of the lab workflow.
async function failedExecution() {
  const execution = await until(async () => {
    const list = await api('GET', `/executions?workflowId=${LAB}&status=error&limit=1`);
    const newest = list.body.data?.[0];
    return newest && Number(newest.id) > lastFailed ? newest : null;
  });
  lastFailed = Number(execution.id);
  return execution;
}

// Skips the failed executions a test left behind.
async function newestFailed() {
  const newest = (await api('GET', `/executions?workflowId=${LAB}&status=error&limit=1`)).body.data?.[0];
  lastFailed = Math.max(lastFailed, Number(newest?.id ?? 0));
}

async function finished(id) {
  return until(async () => {
    const execution = (await api('GET', `/executions/${id}`)).body;
    return execution.stoppedAt ? execution : null;
  }, 60_000);
}

// POST /executions/{id}/retry of the public API.
async function retryByApi(id, loadWorkflow) {
  const response = await api('POST', `/executions/${id}/retry`, loadWorkflow === undefined ? {} : { loadWorkflow });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
  return finished(response.body.id);
}
// The editor's button: "Retry with original workflow" sends loadWorkflow
// false, "Retry with currently saved workflow" sends true.
async function retryByEditor(id, loadWorkflow) {
  const response = await rest('POST', `/executions/${id}/retry`, { loadWorkflow });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
  return finished(response.body.data.id);
}

// While n8n starts, every path answers 200 with a "starting up" page.
const answered = async (response) => response.status === 200 && !(await response.text()).startsWith('n8n is starting up');

before(async () => {
  // bootstrap.sh has finished when the setup webhook answers.
  await until(async () => answered(await fetch(`${BASE}/webhook/retryfx/setup`, { method: 'POST' })), 240_000);

  // Owner and API key through n8n's own endpoints, the ones the first-run
  // screen and Settings > n8n API use.
  let response = await rest('POST', '/owner/setup', OWNER);
  if (response.status !== 200) response = await rest('POST', '/login', { emailOrLdapLoginId: OWNER.email, password: OWNER.password });
  assert.equal(response.status, 200, 'owner setup or login');
  cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const scopes = ['execution:read', 'execution:list', 'execution:retry', 'workflow:read', 'workflow:list', 'workflow:update', 'workflow:activate', 'dataTable:list', 'dataTableRow:delete'];
  const key = await rest('POST', '/api-keys', { label: `lab-${RUN}`, expiresAt: null, scopes });
  assert.equal(key.status, 200, JSON.stringify(key.body).slice(0, 300));
  apiKey = key.body.data.rawApiKey;

  await newestFailed();
});

after(() => {
  const width = Math.max(...report.map((line) => line.name.length));
  console.log(`\nWhat the service received (n8n 2.47.7, ${MODE}). Items in the order they arrived; "|" is where the retry starts.\n`);
  for (const line of report) {
    console.log(`  ${line.name.padEnd(width)}  ${`${line.first} | ${line.afterRetry}`.padEnd(34)}  writes ${line.writes}`);
  }
  console.log('');
});

// Runs a case until it fails, retries it with `retry`, returns the counts.
async function failThenRetry(name, options, retry = (id) => retryByApi(id, false)) {
  const { run, status } = await start(name, options);
  assert.equal(status, 500, 'the first run fails');
  const failed = await failedExecution();
  const first = await service.log(run);
  const retried = await retry(failed.id);
  const log = await service.log(run);
  return { run, failed, retried, first, log, firstSequence: sequence(first), retrySequence: sequence(log, first.requests.length) };
}

// --- Part 1: n8n without a guard -------------------------------------------------

test('one call, the service does the work and answers 500: the retry does it a second time', async () => {
  const result = await failThenRetry('plain', { kind: 'error-after-write' });
  assert.equal(result.retried.status, 'success');
  assert.equal(result.retried.mode, 'retry');
  assert.equal(String(result.retried.retryOf), String(result.failed.id));
  assert.notEqual(String(result.retried.id), String(result.failed.id), 'a retry is a new execution with a new id');
  assert.deepEqual(writes(result.log), { 1: 2 });
  note('one call, 500 after the write', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('one call, the service does the work and answers after the timeout: the retry does it a second time', async () => {
  const result = await failThenRetry('plain', { kind: 'slow-after-write' });
  assert.equal(result.retried.status, 'success');
  assert.deepEqual(writes(result.log), { 1: 2 });
  note('one call, timeout after the write', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('one call, the service refuses with 503 and writes nothing: the retry is the only write', async () => {
  const result = await failThenRetry('plain', { kind: 'error-before-write' });
  assert.deepEqual(writes(result.log), { 1: 1 });
  note('one call, 503 before any write', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('5 items, item 3 fails: items 4 and 5 were sent too, and the retry sends all 5 again', async () => {
  const result = await failThenRetry('plain', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(result.firstSequence.split(',').sort().join(','), '1,2,3,4,5', 'the first run sent every item, also the ones after the failed one');
  assert.equal(result.retrySequence.split(',').sort().join(','), '1,2,3,4,5', 'the retry sent every item again');
  assert.deepEqual(writes(result.log), each(5, 2));
  assert.equal(result.log.marks.length, 1, 'the node before the failed one ran once');
  assert.equal(new Set(result.log.requests.map((request) => request.execution)).size, 2, 'two executions made the calls');
  note('5 items, item 3 fails (API retry)', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('the public API with loadWorkflow true and both editor buttons restart at the same node', async () => {
  const ways = [
    ['API, loadWorkflow true', (id) => retryByApi(id, true)],
    ['API, no body', (id) => retryByApi(id, undefined)],
    ['editor, original workflow', (id) => retryByEditor(id, false)],
    ['editor, currently saved workflow', (id) => retryByEditor(id, true)],
  ];
  for (const [label, retry] of ways) {
    const result = await failThenRetry('plain', { items: 5, fail: 3, kind: 'error-after-write' }, retry);
    assert.equal(result.retrySequence.split(',').sort().join(','), '1,2,3,4,5', label);
    assert.deepEqual(writes(result.log), each(5, 2), label);
    assert.equal(result.log.marks.length, 1, `${label}: the node before the failed one did not run again`);
    note(`5 items, item 3 fails (${label})`, result.firstSequence, result.retrySequence, show(writes(result.log)));
  }
});

test('an execution that was already retried with success can be retried again, and sends again', async () => {
  const result = await failThenRetry('plain', { items: 5, fail: 3, kind: 'error-after-write' });
  const again = await retryByApi(result.failed.id, false);
  assert.equal(again.status, 'success');
  const log = await service.log(result.run);
  assert.deepEqual(writes(log), each(5, 3));
  note('5 items, the same execution retried twice', result.firstSequence, sequence(log, result.first.requests.length), show(writes(log)));
});

test('the public API retry with an Idempotency-Key header: three identical requests start one retry', async () => {
  const { run, status } = await start('plain', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(status, 500);
  const failed = await failedExecution();
  const header = { 'idempotency-key': `retry-of-${failed.id}-${RUN}` };
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await api('POST', `/executions/${failed.id}/retry`, { loadWorkflow: false }, header));
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200]);
  assert.equal(new Set(answers.map((answer) => answer.body.id)).size, 1, 'all three answers name the same retry execution');
  // The same key with a different request is refused.
  assert.equal((await api('POST', `/executions/${failed.id}/retry`, { loadWorkflow: true }, header)).status, 422);
  const log = await service.log(run);
  assert.deepEqual(writes(log), each(5, 2), 'one retry, not three');
  note('5 items, API retry sent 3x with one Idempotency-Key', sequence(log).split(',').slice(0, 5).join(','), sequence(log).split(',').slice(5).join(','), show(writes(log)));
});

test('loadWorkflow after the workflow was edited: false runs the node as it was, true runs the edited node, both from the failed node', async () => {
  const original = (await api('GET', `/workflows/${LAB}`)).body;
  const body = (nodes) => ({ name: original.name, nodes, connections: original.connections, settings: original.settings });
  const { run, status } = await start('plain', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(status, 500);
  const failed = await failedExecution();
  try {
    // The edit: the call now carries ?v=2, which the stand-in writes down.
    const edited = original.nodes.map((node) => (node.name === 'plain · Send' ? { ...node, parameters: { ...node.parameters, url: `${node.parameters.url}?v=2` } } : node));
    assert.equal((await api('PUT', `/workflows/${LAB}`, body(edited))).status, 200);
    await retryByApi(failed.id, false);
    await retryByApi(failed.id, true);
    await retryByEditor(failed.id, false);
    await retryByEditor(failed.id, true);
  } finally {
    assert.equal((await api('PUT', `/workflows/${LAB}`, body(original.nodes))).status, 200);
  }
  const log = await service.log(run);
  const versions = [1, 2, 3, 4].map((retry) => [...new Set(log.requests.slice(retry * 5, retry * 5 + 5).map((request) => request.version || 'old'))].join('+'));
  assert.deepEqual(versions, ['old', '2', 'old', '2']);
  assert.equal(log.requests.length, 25, 'every retry sent all 5 items');
  assert.equal(log.marks.length, 1, 'no retry ran the node before the failed one');
  note('5 items, workflow edited, then 4 retries', '1,2,3,4,5', 'false: old node, true: edited node', show(writes(log)));
});

test('Retry On Fail on the node: all 5 are sent again inside one execution, which ends green', async () => {
  const { run, status } = await start('retry-on-fail', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(status, 200, 'the run ends as a success');
  const log = await service.log(run);
  assert.deepEqual(writes(log), each(5, 2));
  assert.equal(new Set(log.requests.map((request) => request.execution)).size, 1, 'one execution made all the calls');
  note('5 items, item 3 fails, Retry On Fail', sequence(log).split(',').slice(0, 5).join(','), `(same execution) ${sequence(log).split(',').slice(5).join(',')}`, show(writes(log)));
});

test('Loop Over Items with batch size 1: the retry sends item 3 again and goes on, items 1 and 2 are not repeated', async () => {
  const result = await failThenRetry('loop', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(result.firstSequence, '1,2,3');
  assert.equal(result.retrySequence, '3,4,5');
  assert.deepEqual(writes(result.log), { 1: 1, 2: 1, 3: 2, 4: 1, 5: 1 });
  note('5 items in a loop of 1, item 3 fails', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('a failed Execute Sub-workflow node: the whole sub-workflow runs again, its completed step included', async () => {
  const result = await failThenRetry('sub', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.equal(result.first.marks.length, 1);
  assert.equal(result.log.marks.length, 2, 'the step before the call inside the sub-workflow ran a second time');
  assert.deepEqual(writes(result.log), each(5, 2));
  note('5 items in a sub-workflow, item 3 fails', result.firstSequence, result.retrySequence, `${show(writes(result.log))}, step before the call ${result.log.marks.length}x`);
});

test('a ledger check in front of the call, same workflow: the retry skips the check and sends again', async () => {
  const result = await failThenRetry('check-first', { items: 5, fail: 3, kind: 'error-after-write' });
  assert.deepEqual(writes(result.log), each(5, 2));
  note('5 items, check node before the call', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('a service that honours the Idempotency-Key: the retry sends 5 requests, nothing is written twice', async () => {
  const result = await failThenRetry('plain', { items: 5, fail: 3, kind: 'error-after-write', honorKey: true });
  assert.equal(result.log.requests.length, 10);
  assert.deepEqual(writes(result.log), each(5, 1));
  note('5 items, the service honours the key', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

// --- Part 2: the same cases through Guarded call ---------------------------------
// The stand-in does not honour the key here: the ledger alone has to hold.

test('guard, lookup: item 3 was written before the 500, the retry finds it and sends only 4 and 5', async () => {
  const result = await failThenRetry('guarded', { items: 5, fail: 3, kind: 'error-after-write', onUnknown: 'lookup' });
  assert.equal(result.firstSequence, '1,2,3');
  assert.equal(result.retried.status, 'success');
  assert.equal(result.retrySequence, '4,5');
  assert.deepEqual(writes(result.log), each(5, 1));
  note('guard (lookup): item 3 fails after the write', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('guard, lookup: item 3 was refused with 503, the retry sends 3, 4 and 5', async () => {
  const result = await failThenRetry('guarded', { items: 5, fail: 3, kind: 'error-before-write', onUnknown: 'lookup' });
  assert.equal(result.retried.status, 'success');
  assert.equal(result.retrySequence, '3,4,5');
  assert.deepEqual(writes(result.log), each(5, 1));
  note('guard (lookup): item 3 refused, nothing written', result.firstSequence, result.retrySequence, show(writes(result.log)));
});

test('guard, lookup: one call that timed out after the write is not sent again', async () => {
  const result = await failThenRetry('guarded', { kind: 'slow-after-write', onUnknown: 'lookup' });
  assert.equal(result.retried.status, 'success');
  assert.equal(result.log.requests.length, 1);
  assert.deepEqual(writes(result.log), { 1: 1 });
  note('guard (lookup): one call, timeout after the write', result.firstSequence, result.retrySequence || '(nothing)', show(writes(result.log)));
});

test('guard, hold: item 3 stays held, 4 and 5 go out, the run ends red, more retries send nothing', async () => {
  const result = await failThenRetry('guarded', { items: 5, fail: 3, kind: 'error-after-write', onUnknown: 'hold' });
  assert.equal(result.retried.status, 'error', 'the retry ends as an error so the held item is seen');
  assert.equal(result.retrySequence, '4,5');
  assert.deepEqual(writes(result.log), each(5, 1));
  // Retry the original twice more: the guard runs again for all 5 items.
  for (const retry of [retryByApi, retryByEditor]) assert.equal((await retry(result.failed.id, true)).status, 'error');
  const log = await service.log(result.run);
  assert.equal(log.requests.length, 5, 'no further request reached the service');
  assert.deepEqual(writes(log), each(5, 1));
  await newestFailed();
  note('guard (hold): item 3 fails after the write, 3 retries', result.firstSequence, sequence(log, 3), show(writes(log)));
});

test('guard, hold: a refused item is held too, until a person releases it; then a retry sends it once', async () => {
  const result = await failThenRetry('guarded', { items: 5, fail: 3, kind: 'error-before-write', onUnknown: 'hold' });
  assert.equal(result.retried.status, 'error');
  assert.equal(result.retrySequence, '4,5');
  assert.deepEqual(writes(result.log), { 1: 1, 2: 1, 4: 1, 5: 1 }, 'item 3 was never written and waits for a person');
  note('guard (hold): item 3 refused, nothing written', result.firstSequence, result.retrySequence, `${show(writes(result.log))} (3 held)`);

  // A person checks the service, sees that item 3 is not there, and releases
  // it by deleting its ledger row. Retrying the first failed execution sends it.
  const table = (await api('GET', '/data-tables')).body.data.find((entry) => entry.name === 'retry_ledger');
  const filter = JSON.stringify({ type: 'and', filters: [{ columnName: 'key', condition: 'eq', value: `${result.run}:3` }] });
  assert.equal((await api('DELETE', `/data-tables/${table.id}/rows/delete?filter=${encodeURIComponent(filter)}`)).status, 200);
  const released = await retryByApi(result.failed.id, false);
  assert.equal(released.status, 'success');
  const log = await service.log(result.run);
  assert.equal(sequence(log, 5), '3');
  assert.deepEqual(writes(log), each(5, 1));
  await newestFailed();
  note('guard (hold): item 3 released by hand, retried', '1,2,3 | 4,5', '3', show(writes(log)));
});

test('guard: the same execution retried three times, by API and editor, still writes each item once', async () => {
  const result = await failThenRetry('guarded', { items: 5, fail: 3, kind: 'error-after-write', onUnknown: 'lookup' });
  await retryByApi(result.failed.id, true);
  await retryByEditor(result.failed.id, false);
  await retryByEditor(result.failed.id, true);
  const log = await service.log(result.run);
  assert.equal(log.requests.length, 5);
  assert.deepEqual(writes(log), each(5, 1));
  note('guard (lookup): the same execution retried 4 times', result.firstSequence, sequence(log, 3), show(writes(log)));
});

test('guard with Retry On Fail on the Execute Sub-workflow node: one green execution, each item written once', async () => {
  const { run, status } = await start('guarded-retry-on-fail', { items: 5, fail: 3, kind: 'error-after-write', onUnknown: 'lookup' });
  assert.equal(status, 200);
  const log = await service.log(run);
  assert.equal(sequence(log), '1,2,3,4,5');
  assert.deepEqual(writes(log), each(5, 1));
  note('guard (lookup) + Retry On Fail', '1,2,3', `(same execution) ${sequence(log, 3)}`, show(writes(log)));
});

test('guard: two retries of the same execution started at the same instant still write each item once', async () => {
  const rounds = 10;
  let requests = 0;
  for (let round = 0; round < rounds; round++) {
    // Item 3 is refused, so the lookup says "not there" and both retries want to send it.
    const { run, status } = await start('guarded', { items: 5, fail: 3, kind: 'error-before-write', onUnknown: 'lookup' });
    assert.equal(status, 500);
    const failed = await failedExecution();
    await Promise.all([retryByApi(failed.id, false), retryByEditor(failed.id, false)]);
    const log = await service.log(run);
    assert.deepEqual(writes(log), each(5, 1), `round ${round + 1}`);
    requests += log.requests.length;
    await newestFailed();
  }
  assert.equal(requests, rounds * 6, 'per round: 3 requests in the first run, then 3, 4 and 5 once');
  note(`guard (lookup): 2 retries at the same instant, ${rounds} rounds`, '1,2,3', '3,4,5 once', '1:1x 2:1x 3:1x 4:1x 5:1x every round');
});

test('guard: a second run that arrives while the first is still waiting for the service gets "busy" and sends nothing', async () => {
  const run = `${RUN}-inflight`;
  await service.control(run, { item: 1, kind: 'slow-after-write', times: 1 });
  const slow = start('guarded', { run, onUnknown: 'lookup' }); // times out after 1.5 s
  await sleep(500);
  const second = await start('guarded', { run, onUnknown: 'lookup' });
  assert.equal(second.status, 500, 'the second run ends red');
  assert.equal((await service.log(run)).requests.length, 1, 'and made no call');
  assert.equal((await slow).status, 500, 'the first run times out');
  // Now the row is "unknown", and a retry asks the service instead of sending.
  // Two runs failed. The first one (lower id) is the one that made the call.
  const [newer, failed] = (await api('GET', `/executions?workflowId=${LAB}&status=error&limit=2`)).body.data;
  lastFailed = Number(newer.id);
  const retried = await retryByApi(failed.id, false);
  assert.equal(retried.status, 'success');
  const log = await service.log(run);
  assert.equal(log.requests.length, 1);
  assert.deepEqual(writes(log), { 1: 1 });
  note('guard (lookup): second run during the call, then a retry', '1', '(nothing)', show(writes(log)));
});

test('guard: the same 5 keys started by two runs at the same instant are written once', async () => {
  const rounds = 10;
  for (let round = 0; round < rounds; round++) {
    const run = `${RUN}-twins-${round}`;
    await Promise.all([start('guarded', { items: 5, run }), start('guarded', { items: 5, run })]);
    assert.deepEqual(writes(await service.log(run)), each(5, 1), `round ${round + 1}`);
  }
  await newestFailed();
  note(`guard: 2 runs with the same keys at the same instant, ${rounds} rounds`, '1,2,3,4,5', '(no retry)', '1:1x 2:1x 3:1x 4:1x 5:1x every round');
});
