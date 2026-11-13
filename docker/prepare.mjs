// Used by bootstrap.sh inside the n8n container: copies the workflows for the
// n8n CLI and points them at SERVICE_URL when that is set.
//   node prepare.mjs <workflows dir> <output dir>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const service = (process.env.SERVICE_URL || '').replace(/\/+$/, '');

mkdirSync(out, { recursive: true });
for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  let text = readFileSync(join(source, file), 'utf8');
  if (service) text = text.replaceAll('http://standin:8080', service);
  writeFileSync(join(out, file), text);
}
