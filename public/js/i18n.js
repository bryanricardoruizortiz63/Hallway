// The app's language: Spanish (as the screens are written) or English. Screens keep their Spanish text; in English,
// every text that reaches the page (screens, dialogs, toasts, errors from the server) is swapped for its translation
// as it appears, so a screen that isn't translated yet simply stays in Spanish. The choice is saved on the person's
// profile (it follows them to any device) and on this device (for the sign-in screen).
import { EN, EN_PATTERNS } from './i18n-en.js';

const KEY = 'lah:lang';
export const LANGUAGES = [
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
];

function saved() {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'es' || value === 'en') return value;
  } catch {
    /* private mode */
  }
  return (navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

let lang = saved();
let observer = null;
// Chosen on the sign-in screen: the account takes it when it signs in.
let picked = null;

export const getLang = () => lang;
/** For dates and numbers. */
export const locale = () => (lang === 'en' ? 'en-US' : 'es');

/** One text in the current language (Spanish text in, Spanish or English out). */
export function t(text) {
  if (lang !== 'en' || !text) return text;
  const key = String(text);
  const trimmed = key.trim();
  if (!trimmed) return key;
  // Templates wrap long texts over several lines: the dictionary has them on one.
  const norm = trimmed.replace(/[ \t\n\r]+/g, ' ');
  let out = EN[norm];
  if (out === undefined) {
    for (const [re, to] of EN_PATTERNS) {
      if (re.test(norm)) {
        out = norm.replace(re, typeof to === 'function' ? (...m) => to(...m.slice(1, -2).map((v) => t(v))) : to);
        break;
      }
    }
  }
  if (out === undefined) return key;
  // Keep the spaces around it (they separate it from icons and other words).
  return key.slice(0, key.indexOf(trimmed)) + out + key.slice(key.indexOf(trimmed) + trimmed.length);
}

const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
// TEXT, ELEMENT, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT.
const TEXT = 3;
const ELEMENT = 1;
const SHOW = 1 | 4;
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE']);
// What was put on the page in Spanish: put back when switching to Spanish.
const original = new WeakMap();

function skipped(el) {
  return !el || SKIP.has(el.tagName) || el.closest('[translate="no"], [contenteditable]');
}

function translateText(node) {
  if (skipped(node.parentElement)) return;
  const source = original.get(node) ?? node.nodeValue;
  const next = lang === 'en' ? t(source) : source;
  if (next !== source) original.set(node, source);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttrs(el) {
  // A field's hint (placeholder) is translated; what's typed in it never is.
  if (el.closest('[translate="no"], [contenteditable]')) return;
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const store = `i18n${name}`;
    const source = el[store] ?? el.getAttribute(name);
    const next = lang === 'en' ? t(source) : source;
    if (next !== source) el[store] = source;
    if (el.getAttribute(name) !== next) el.setAttribute(name, next);
  }
}

function translateTree(root) {
  if (root.nodeType === TEXT) return translateText(root);
  if (root.nodeType !== ELEMENT) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, SHOW);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === TEXT) translateText(n);
    else translateAttrs(n);
  }
}

let titleSource = null;
function translateTitle() {
  if (lang !== 'en') return;
  const next = t(document.title);
  if (next !== document.title) {
    titleSource = document.title;
    document.title = next;
  }
}

function watch() {
  observer?.disconnect();
  if (lang !== 'en') return;
  observer = new MutationObserver((records) => {
    observer.disconnect();
    for (const r of records) {
      if (r.type === 'characterData') {
        // Our own change, or new text set on the node.
        if (r.target.nodeValue !== t(original.get(r.target) ?? '')) original.delete(r.target);
        translateText(r.target);
      } else if (r.type === 'attributes') {
        const store = `i18n${r.attributeName}`;
        if (r.target.getAttribute(r.attributeName) !== t(r.target[store] ?? '')) delete r.target[store];
        translateAttrs(r.target);
      } else {
        for (const n of r.addedNodes) translateTree(n);
      }
    }
    translateTitle();
    start();
  });
  start();
}

function start() {
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
}

/** At startup, before anything is drawn. */
export function initLanguage() {
  document.documentElement.lang = lang;
  if (lang === 'en') {
    translateTree(document.body);
    translateTitle();
  }
  watch();
}

/** The language picked before signing in (once), or null. */
export function takePicked() {
  const p = picked;
  picked = null;
  return p;
}

/** Switches the language of this device (the page redraws itself in place). */
export function setLang(next, { beforeSignIn = false } = {}) {
  if (beforeSignIn) picked = next;
  if (next !== 'es' && next !== 'en') return;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode */
  }
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = lang;
  translateTree(document.body);
  if (lang === 'en') translateTitle();
  else if (titleSource && document.title === t(titleSource)) document.title = titleSource;
  watch();
  window.dispatchEvent(new Event('lah:language'));
}
