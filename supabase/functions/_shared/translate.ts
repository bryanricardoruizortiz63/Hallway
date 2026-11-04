// Notices in the language each person chose (profiles.language). The server writes them in Spanish; for English it
// uses the app's own translator and the notices' texts (copied into ./i18n by scripts/sync-i18n.mjs).
// @deno-types="./i18n/notices.d.ts"
import { NOTICES, NOTICE_PATTERNS } from './i18n/i18n-notices.js';
// @deno-types="./i18n/core.d.ts"
import { makeTranslator } from './i18n/i18n-core.js';
import type { Lang } from './lang.ts';

export { type Lang, langOf } from './lang.ts';

const translate = makeTranslator(NOTICES, NOTICE_PATTERNS);

/** The text in that language (Spanish stays as it is; a text the dictionary doesn't know stays in Spanish). */
export function inLang(text: string | null | undefined, lang: Lang): string {
  if (!text) return text ?? '';
  if (lang !== 'en') return text;
  // Line by line: a body may have several lines.
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const out = translate(trimmed.replace(/[ \t\r]+/g, ' '));
      return out === undefined ? line : line.replace(trimmed, out);
    })
    .join('\n');
}
