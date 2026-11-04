// The server translates notices and emails with the same dictionary as the app: this copies it from public/js into
// supabase/functions/_shared/i18n (Supabase only deploys what is inside supabase/functions).
//   node scripts/sync-i18n.mjs            copies
//   node scripts/sync-i18n.mjs --check    only checks that the copies are up to date (CI)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'public', 'js');
const TO = join(ROOT, 'supabase', 'functions', '_shared', 'i18n');
// Only what the notices need: the translator and the notices' own texts.
const FILES = ['i18n-core.js', 'i18n-notices.js'];
const HEAD = '// Copied from public/js by scripts/sync-i18n.mjs: change it there and run the script.\n';
const check = process.argv.includes('--check');

let stale = [];
mkdirSync(TO, { recursive: true });
for (const f of FILES) {
  const want = HEAD + readFileSync(join(FROM, f), 'utf8');
  const target = join(TO, f);
  const have = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (have === want) continue;
  if (check) stale.push(f);
  else writeFileSync(target, want);
}
if (stale.length) {
  console.error(`Desactualizado en supabase/functions/_shared/i18n: ${stale.join(', ')}. Corre: node scripts/sync-i18n.mjs`);
  process.exit(1);
}
console.log(check ? 'Diccionario del servidor al día' : 'Diccionario copiado al servidor');
