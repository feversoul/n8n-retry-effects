// Stand-in for the service your workflow calls. It counts what it actually
// received, so the tests can compare that with what n8n shows.
//
//   POST /charge    the call. The key comes from the Idempotency-Key header
//                   and has the form "<run>:<item>". Every request is logged;
//                   a "write" is the side effect (the charge, the email).
//   POST /mark      a step that ran before the call (counts per run)
//   GET  /lookup    ?key=...  -> { found }  "do you already have this one?"
//   POST /control   { run, item, kind, times, honorKey }  how to misbehave
//   GET  /log       ?run=...  -> { requests, writes, marks }
//
// kind:  error-after-write   does the write, then answers 500
//        error-before-write  answers 503, writes nothing
//        slow-after-write    does the write, answers 200 after SLOW_MS
// honorKey: true makes a repeated key a no-op, the way a service with real
//        idempotency keys behaves. Off by default: most services have none.

import { createServer } from 'node:http';

const SLOW_MS = Number(process.env.SLOW_MS || 4000);
const runs = new Map();
const run = (name) => {
  if (!runs.has(name)) runs.set(name, { requests: [], writes: [], marks: [], rule: null, honorKey: false });
  return runs.get(name);
};
const split = (key) => {
  const at = key.lastIndexOf(':');
  return at < 0 ? { name: key, item: 0 } : { name: key.slice(0, at), item: Number(key.slice(at + 1)) };
};

const read = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://standin');
  const body = request.method === 'POST' ? await read(request) : {};
  const execution = String(request.headers['x-execution-id'] ?? '');

  if (url.pathname === '/charge' && request.method === 'POST') {
    const key = String(request.headers['idempotency-key'] ?? body.key ?? '');
    const { name, item } = split(key);
    const state = run(name);
    const rule = state.rule && state.rule.item === item && state.rule.times > 0 ? state.rule : null;
    if (rule) rule.times -= 1;
    const kind = rule ? rule.kind : 'ok';
    const replay = state.honorKey && state.writes.some((write) => write.key === key);
    const wrote = kind !== 'error-before-write' && !replay;
    // ?v=... lets a test tell two versions of the calling node apart.
    state.requests.push({ key, item, execution, kind, wrote, version: url.searchParams.get('v') ?? '' });
    if (wrote) state.writes.push({ key, item, execution });
    if (kind === 'error-after-write') return send(response, 500, { error: 'written, then failed' });
    if (kind === 'error-before-write') return send(response, 503, { error: 'not written' });
    if (kind === 'slow-after-write') return setTimeout(() => send(response, 200, { ok: true, key, slow: true }), SLOW_MS);
    return send(response, 200, { ok: true, key, replay });
  }

  if (url.pathname === '/mark' && request.method === 'POST') {
    run(String(body.run ?? '')).marks.push({ execution });
    return send(response, 200, { ok: true });
  }

  if (url.pathname === '/lookup') {
    const key = url.searchParams.get('key') ?? '';
    return send(response, 200, { found: run(split(key).name).writes.some((write) => write.key === key) });
  }

  if (url.pathname === '/control' && request.method === 'POST') {
    const state = run(String(body.run ?? ''));
    if (body.kind) state.rule = { item: Number(body.item ?? 1), kind: String(body.kind), times: Number(body.times ?? 1) };
    if (body.honorKey !== undefined) state.honorKey = Boolean(body.honorKey);
    return send(response, 200, { ok: true });
  }

  if (url.pathname === '/log') {
    const state = run(url.searchParams.get('run') ?? '');
    return send(response, 200, { requests: state.requests, writes: state.writes, marks: state.marks });
  }

  if (url.pathname === '/health') return send(response, 200, { ok: true });
  return send(response, 404, { error: 'not found' });
}).listen(8080, () => console.log('stand-in service on :8080'));
