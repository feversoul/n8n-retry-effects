// Builds workflows/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the repeated parts are written once (the lab
// has eight cases of the same shape). After changing it, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The stand-in service of the local stack. docker/prepare.mjs replaces it
// when SERVICE_URL is set.
const SERVICE = 'http://standin:8080';

const LEDGER = 'retry_ledger';
const LEDGER_COLUMNS = [
  ['key', 'string'], // one row per intended action; the same on every attempt
  ['status', 'string'], // sending | unknown | done (| lock, for the rows that guard a resend)
  ['attempts', 'number'], // how many times the call was sent
  ['claimed_by', 'string'], // execution that wrote the row
];

const IDS = {
  setup: 'retryFxSetup0001',
  guard: 'retryFxGuard0001',
  child: 'retryFxLabChild1',
  lab: 'retryFxLab000001',
};

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const tableRef = (name) => ({ __rl: true, mode: 'name', value: name });
const byKey = (expression) => ({
  matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: expression }] },
});
const mapped = (values) => ({
  mappingMode: 'defineBelow',
  value: values,
  matchingColumns: [],
  schema: LEDGER_COLUMNS.filter(([column]) => column in values).map(([column, type]) => ({
    id: column,
    displayName: column,
    required: false,
    defaultMatch: false,
    display: true,
    type,
    canBeUsedToMatch: true,
  })),
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const api = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return api.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    // a -> b -> c ...
    chain(...names) {
      for (let i = 1; i < names.length; i++) api.link(names[i - 1], names[i]);
    },
    // A webhook that answers when the run ends: 200 with the last node's
    // items, or 500 when the run failed.
    hook(nodeName, path, position) {
      return api.node(
        nodeName,
        'webhook',
        2,
        position,
        { httpMethod: 'POST', path: `retryfx/${path}`, responseMode: 'lastNode', options: {} },
        { webhookId: uuid(`${id}/webhook/${path}`) },
      );
    },
    code(nodeName, position, lines) {
      return api.node(nodeName, 'code', 2, position, { jsCode: lines.join('\n') });
    },
    // An IF node on one JavaScript condition. Output 0 is true, 1 is false.
    when(nodeName, position, expression) {
      return api.node(nodeName, 'if', 2.2, position, {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: uuid(`${id}/${nodeName}/condition`),
              leftValue: `={{ ${expression} }}`,
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: { looseTypeValidation: true },
      });
    },
    // Data Table row operation on the ledger.
    rows(nodeName, position, operation, parameters, extra = {}) {
      return api.node(nodeName, 'dataTable', 1.1, position, { resource: 'row', operation, dataTableId: tableRef(LEDGER), ...parameters }, extra);
    },
    // The call with the outside effect. The key travels as Idempotency-Key,
    // and the execution id as X-Execution-Id so the stand-in can show which
    // execution sent what.
    call(nodeName, position, key, extra = {}) {
      return api.node(
        nodeName,
        'httpRequest',
        4.2,
        position,
        {
          method: 'POST',
          url: `${SERVICE}/charge`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Idempotency-Key', value: `={{ ${key} }}` },
              { name: 'X-Execution-Id', value: '={{ $execution.id }}' },
            ],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `={{ JSON.stringify({ key: ${key} }) }}`,
          options: { timeout: 1500 },
        },
        extra,
      );
    },
    // A step before the call. The stand-in counts how often it ran.
    mark(nodeName, position, run) {
      return api.node(
        nodeName,
        'httpRequest',
        4.2,
        position,
        {
          method: 'POST',
          url: `${SERVICE}/mark`,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'X-Execution-Id', value: '={{ $execution.id }}' }] },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `={{ JSON.stringify({ run: ${run} }) }}`,
          options: {},
        },
        { executeOnce: true },
      );
    },
    subWorkflow(nodeName, position, workflowId, mode, extra = {}) {
      return api.node(
        nodeName,
        'executeWorkflow',
        1.2,
        position,
        {
          workflowId: { __rl: true, mode: 'id', value: workflowId },
          workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
          mode,
          options: {},
        },
        extra,
      );
    },
    called(nodeName, position) {
      return api.node(nodeName, 'executeWorkflowTrigger', 1.1, position, { inputSource: 'passthrough' });
    },
  };
  build(api);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// --- 0. Setup ----------------------------------------------------------------

const setup = workflow(IDS.setup, 'Retry Effects · 0 Setup', (w) => {
  w.note(
    'About',
    [
      '## Retry Effects · Setup',
      `Run this once: open it and press **Execute workflow**. It creates the data table \`${LEDGER}\` that **Guarded call** keeps its rows in. Running it again changes nothing.`,
      '',
      'The webhook does the same for scripted installs (`POST retryfx/setup`). You can delete it.',
    ],
    [-40, -240],
    560,
    180,
  );
  w.node('Run once', 'manualTrigger', 1, [0, 0], {});
  w.hook('Or call', 'setup', [0, 180]);
  w.node('Create ledger table', 'dataTable', 1.1, [240, 0], {
    resource: 'table',
    operation: 'create',
    tableName: LEDGER,
    columns: { column: LEDGER_COLUMNS.map(([name, type]) => ({ name, type })) },
    options: { createIfNotExists: true },
  });
  w.link('Run once', 'Create ledger table');
  w.link('Or call', 'Create ledger table');
});

// --- 1. Guarded call ----------------------------------------------------------

const guard = workflow(IDS.guard, 'Retry Effects · 1 Guarded call', (w) => {
  w.note(
    'About',
    [
      '## Retry Effects · Guarded call',
      'A sub-workflow that makes one outside call at most once per `key`, however often the execution is retried.',
      '',
      'Call it from an **Execute Sub-workflow** node set to **Run once for each item**. Each item needs a `key` that is the same on every attempt (order id + line, event id + recipient). Do not build it from `$execution.id`: a retry gets a new execution id.',
      '',
      '**Why a sub-workflow:** when a retry starts at a failed node, the nodes before it do not run again, so a check placed in front of the call is skipped. A failed Execute Sub-workflow node runs the whole sub-workflow again, check included.',
      '',
      'It answers with `outcome`: `sent`, `already_done`, `found_at_service`, `held`, or `busy` (another run took this key at the same moment).',
      '',
      'Replace **Call the service** with your own node and keep its **On Error** on *Continue (using error output)*. Replace **Look it up** too, or stay on `hold`. Settings are at the top of **Entry**.',
    ],
    [-40, -620],
    640,
    480,
  );
  w.note(
    'Unknown',
    [
      '### The ledger row',
      '- `sending`: a run is in the middle of the call. Another run that meets it answers `busy`. After `LEASE_SECONDS` it counts as a run that died, and is treated as `unknown`.',
      '- `done`: the service answered. Later runs answer `already_done` and do not call.',
      '- `unknown`: the call failed or timed out. Nobody knows if the service did the work.',
      '',
      '### What happens to `unknown`',
      '- `hold` (default): do not call. The item comes back with `outcome: held` for a person to check. To release it, set the row to `done`, or delete it to send again.',
      '- `lookup`: ask the service with **Look it up**. Found: mark done, no call. A clear "not there": call again. Any other answer: hold.',
      '',
      'Use `lookup` only when the service shows a write the moment it happens. A lookup that lags will say "not there" about something that is.',
    ],
    [900, -620],
    640,
    420,
    5,
  );
  w.called('When called', [0, 0]);
  w.code('Entry', [220, 0], [
    '// Settings.',
    "const ON_UNKNOWN = 'hold'; // 'hold' or 'lookup', see the note. An item can override it with on_unknown.",
    'const LEASE_SECONDS = 300; // a row still "sending" after this long counts as a run that died. Set it longer than your slowest call.',
    '',
    'const input = $input.first().json;',
    "const key = String(input.key ?? '').trim();",
    "if (!key) throw new Error('Guarded call needs a key on the item');",
    "const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');",
    '// token: this run. It tells my ledger rows from those of a run that started at the same moment.',
    'return [{ json: { key, payload: input.payload ?? {}, on_unknown: input.on_unknown ?? ON_UNKNOWN, lease_seconds: LEASE_SECONDS, token: `${$execution.id}-${hex()}${hex()}` } }];',
  ]);
  const entry = "$('Entry').first().json";
  const first = { returnAll: false, limit: 1, orderBy: true, orderByColumn: 'id', orderByDirection: 'ASC' };
  const outcome = (name, position, value) => w.code(name, position, [`return [{ json: { key: ${entry}.key, outcome: '${value}' } }];`]);
  const markDone = (name, position) => w.rows(name, position, 'update', { ...byKey(`={{ ${entry}.key }}`), columns: mapped({ status: 'done' }), options: {} });

  w.rows('Ledger row', [440, 0], 'get', { ...byKey('={{ $json.key }}'), ...first }, { alwaysOutputData: true });
  w.when('New key?', [660, 0], '$json.id === undefined');

  // New key: write the row before the call. If the run dies between the two,
  // the row says "maybe sent" instead of nothing. Two runs that start at the
  // same moment both insert; the one with the lowest row id goes on.
  w.rows('Claim', [900, -120], 'insert', {
    columns: mapped({ key: `={{ ${entry}.key }}`, status: 'sending', attempts: 1, claimed_by: `={{ ${entry}.token }}` }),
    options: {},
  });
  w.rows('First row', [1120, -120], 'get', { ...byKey(`={{ ${entry}.key }}`), ...first }, { alwaysOutputData: true });
  w.when('Mine?', [1340, -120], "$json.id === $('Claim').first().json.id");
  w.rows('Remove my row', [1560, -280], 'deleteRows', {
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: "={{ $('Claim').first().json.id }}" }] },
    options: {},
  }, { alwaysOutputData: true });
  // On Error is "Continue (using error output)": a failed call is written down
  // as unknown first, then the run fails so the execution can be retried.
  w.call('Call the service', [2440, -120], `${entry}.key`, { onError: 'continueErrorOutput' });
  w.rows('Mark unknown', [2660, 40], 'update', { ...byKey(`={{ ${entry}.key }}`), columns: mapped({ status: 'unknown' }), options: {} }, { alwaysOutputData: true });
  w.node('Fail the run', 'stopAndError', 1, [2880, 40], {
    errorMessage: `={{ 'The call for ' + ${entry}.key + ' failed: ' + JSON.stringify($('Call the service').first().json.error ?? 'no details') }}`,
  });
  markDone('Mark done', [2660, -120]);
  outcome('Sent', [2880, -120], 'sent');

  // Known key.
  w.when('Done already?', [900, 240], "$json.status === 'done'");
  outcome('Already done', [1120, 160], 'already_done');
  // "sending" and young: another run is in the middle of the call right now.
  w.when('In flight?', [1120, 360], `$json.status === 'sending' && Date.now() - new Date($json.updatedAt).getTime() < ${entry}.lease_seconds * 1000`);
  w.when('Look it up?', [1340, 460], `${entry}.on_unknown === 'lookup'`);
  w.node(
    'Look it up',
    'httpRequest',
    4.2,
    [1560, 400],
    {
      url: `${SERVICE}/lookup`,
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'key', value: `={{ ${entry}.key }}` }] },
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 5000 },
    },
    { onError: 'continueRegularOutput' },
  );
  // Only a real true counts as found, only a real false as "not there".
  w.when('Found there?', [1780, 400], '$json.statusCode === 200 && $json.body?.found === true');
  markDone('Mark done (found)', [2000, 320]);
  outcome('Found at service', [2220, 320], 'found_at_service');
  w.when('Clearly not there?', [2000, 500], '$json.statusCode === 200 && $json.body?.found === false');
  // Sending again needs a second claim, or two retries started together would
  // both send. One lock row per attempt number; the lowest row id wins.
  const lock = `${entry}.key + '#attempt' + (($('Ledger row').first().json.attempts ?? 1) + 1)`;
  w.rows('Claim the resend', [2220, 500], 'insert', {
    columns: mapped({ key: `={{ ${lock} }}`, status: 'lock', attempts: 0, claimed_by: `={{ ${entry}.token }}` }),
    options: {},
  });
  w.rows('First resend row', [2440, 500], 'get', { ...byKey(`={{ ${lock} }}`), ...first }, { alwaysOutputData: true });
  w.when('Resend mine?', [2660, 500], "$json.id === $('Claim the resend').first().json.id");
  w.rows('Count attempt', [2880, 420], 'update', {
    ...byKey(`={{ ${entry}.key }}`),
    columns: mapped({ status: 'sending', attempts: "={{ ($('Ledger row').first().json.attempts ?? 1) + 1 }}", claimed_by: `={{ ${entry}.token }}` }),
    options: {},
  });
  outcome('Held', [1780, 700], 'held');
  outcome('Busy', [2880, 640], 'busy');

  w.chain('When called', 'Entry', 'Ledger row', 'New key?');
  w.link('New key?', 'Claim', 0);
  w.chain('Claim', 'First row', 'Mine?');
  w.link('Mine?', 'Call the service', 0);
  w.link('Mine?', 'Remove my row', 1);
  w.link('Remove my row', 'Busy');
  w.chain('Call the service', 'Mark done', 'Sent');
  w.link('Call the service', 'Mark unknown', 1);
  w.link('Mark unknown', 'Fail the run');
  w.link('New key?', 'Done already?', 1);
  w.link('Done already?', 'Already done', 0);
  w.link('Done already?', 'In flight?', 1);
  w.link('In flight?', 'Busy', 0);
  w.link('In flight?', 'Look it up?', 1);
  w.link('Look it up?', 'Look it up', 0);
  w.link('Look it up?', 'Held', 1);
  w.link('Look it up', 'Found there?');
  w.link('Found there?', 'Mark done (found)', 0);
  w.link('Mark done (found)', 'Found at service');
  w.link('Found there?', 'Clearly not there?', 1);
  w.link('Clearly not there?', 'Claim the resend', 0);
  w.chain('Claim the resend', 'First resend row', 'Resend mine?');
  w.link('Resend mine?', 'Count attempt', 0);
  w.link('Count attempt', 'Call the service');
  w.link('Resend mine?', 'Busy', 1);
  w.link('Clearly not there?', 'Held', 1);
});

// --- 8. Lab child -------------------------------------------------------------

// The unguarded sub-workflow of the lab: a step that completes, then the call.
const child = workflow(IDS.child, 'Retry Effects · 8 Lab child (no guard)', (w) => {
  w.note(
    'About',
    ['## Retry Effects · Lab child', 'Called by the `sub` case of the lab. **Before** completes, then **Send** makes one call per item. Nothing guards it.'],
    [-40, -200],
    560,
    140,
  );
  w.called('When called', [0, 0]);
  w.mark('Before', [220, 0], "$json.key.slice(0, $json.key.lastIndexOf(':'))");
  w.code('Items again', [440, 0], ["return $('When called').all();"]);
  w.call('Send', [660, 0], '$json.key');
  w.chain('When called', 'Before', 'Items again', 'Send');
});

// --- 9. Lab -------------------------------------------------------------------

const CASES = [
  ['plain', 'One HTTP Request node gets all items.'],
  ['retry-on-fail', 'Same, with Retry On Fail on the node (3 tries).'],
  ['loop', 'Loop Over Items, batch size 1, the call inside the loop.'],
  ['sub', 'The call sits in a sub-workflow, behind a step that completes.'],
  ['check-first', 'A ledger check and claim in front of the call, in the same workflow.'],
  ['guarded', 'Each item goes through Guarded call.'],
  ['guarded-retry-on-fail', 'Same, with Retry On Fail on the Execute Sub-workflow node.'],
];

const lab = workflow(IDS.lab, 'Retry Effects · 9 Lab', (w) => {
  w.note(
    'About',
    [
      '## Retry Effects · Lab',
      'For measuring, not for production. Each row is one way to make the same call for N items. `POST retryfx/lab/<case>` with `{ "run": "...", "items": 5 }`; the stand-in service is told beforehand which item to fail and how. The tests retry the failed execution and count what the stand-in received.',
      '',
      ...CASES.map(([name, text]) => `- \`${name}\`: ${text}`),
    ],
    [-40, -360],
    760,
    300,
  );
  const row = 220;
  CASES.forEach(([name], index) => {
    const y = index * row;
    const n = (label) => `${name} · ${label}`;
    const hook = w.hook(n('Webhook'), `lab/${name}`, [0, y]);
    const items = (position) =>
      w.code(n('Items'), position, [
        `const body = $('${hook}').first().json.body ?? {};`,
        '// The key is the same on every attempt: it comes from the data, not from the execution.',
        'return Array.from({ length: Number(body.items ?? 1) }, (_, index) => ({',
        "  json: { key: `${body.run}:${index + 1}`, on_unknown: body.on_unknown ?? 'hold' },",
        '}));',
      ]);

    if (name === 'plain' || name === 'retry-on-fail') {
      w.mark(n('Before'), [220, y], '$json.body.run');
      items([440, y]);
      w.call(n('Send'), [660, y], '$json.key', name === 'retry-on-fail' ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 200 } : {});
      w.chain(hook, n('Before'), n('Items'), n('Send'));
    }
    if (name === 'loop') {
      w.mark(n('Before'), [220, y], '$json.body.run');
      items([440, y]);
      w.node(n('Loop'), 'splitInBatches', 3, [660, y], { batchSize: 1, options: {} });
      w.call(n('Send'), [880, y + 60], '$json.key');
      w.chain(hook, n('Before'), n('Items'), n('Loop'));
      w.link(n('Loop'), n('Send'), 1);
      w.link(n('Send'), n('Loop'));
    }
    if (name === 'sub') {
      items([220, y]);
      w.subWorkflow(n('Child'), [440, y], IDS.child, 'once');
      w.chain(hook, n('Items'), n('Child'));
    }
    if (name === 'check-first') {
      w.mark(n('Before'), [220, y], '$json.body.run');
      items([440, y]);
      w.rows(n('Ledger rows'), [660, y], 'get', { ...byKey('={{ $json.key }}'), returnAll: true }, { alwaysOutputData: true });
      w.code(n('Not seen'), [880, y], [
        'const seen = new Set($input.all().map((item) => item.json.key));',
        `return $('${n('Items')}').all().filter((item) => !seen.has(item.json.key));`,
      ]);
      w.rows(n('Claim'), [1100, y], 'insert', {
        columns: mapped({ key: '={{ $json.key }}', status: 'sending', attempts: 1, claimed_by: '={{ $execution.id }}' }),
        options: {},
      });
      w.call(n('Send'), [1320, y], '$json.key');
      w.chain(hook, n('Before'), n('Items'), n('Ledger rows'), n('Not seen'), n('Claim'), n('Send'));
    }
    if (name === 'guarded' || name === 'guarded-retry-on-fail') {
      items([220, y]);
      w.subWorkflow(n('Guarded call'), [440, y], IDS.guard, 'each', name === 'guarded-retry-on-fail' ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 200 } : {});
      // Held items do not stop the others. The run still ends red, so nobody
      // reads it as finished.
      w.when(n('Held?'), [660, y], "$json.outcome === 'held' || $json.outcome === 'busy'");
      w.node(n('Needs review'), 'stopAndError', 1, [880, y - 60], { errorMessage: 'Some items are held: the first attempt may have reached the service. Check them, then set their ledger rows to done or delete them.' });
      w.node(n('Finished'), 'noOp', 1, [880, y + 80], {});
      w.chain(hook, n('Items'), n('Guarded call'), n('Held?'));
      w.link(n('Held?'), n('Needs review'), 0);
      w.link(n('Held?'), n('Finished'), 1);
    }
  });
});

mkdirSync(join(root, 'workflows'), { recursive: true });
const files = {
  '0-setup.json': setup,
  '1-guarded-call.json': guard,
  '8-lab-child.json': child,
  '9-lab.json': lab,
};
for (const [file, content] of Object.entries(files)) {
  writeFileSync(join(root, 'workflows', file), `${JSON.stringify(content, null, 2)}\n`);
  console.log(`workflows/${file}  ${content.nodes.length} nodes`);
}
