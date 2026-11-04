// The translator shared by the app and the server (the notify function copies these files, see
// scripts/sync-i18n.mjs): Spanish text in, English out. No browser or Deno APIs here.
//
// In order: the exact text in the dictionary; a pattern; an emoji at the start or end around a known text;
// each sentence on its own; each «a · b» or «a › b» part on its own. Dates and times written by the server
// («lun 3 nov», «2:00 p. m.») are put in English in what comes out.

const WEEKDAYS = { dom: 'Sun', lun: 'Mon', mar: 'Tue', 'mié': 'Wed', jue: 'Thu', vie: 'Fri', 'sáb': 'Sat' };
const MONTHS = {
  ene: 'Jan', feb: 'Feb', mar: 'Mar', abr: 'Apr', may: 'May', jun: 'Jun',
  jul: 'Jul', ago: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dic: 'Dec',
};
const DATE_RE = /\b(dom|lun|mar|mié|jue|vie|sáb) (\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/g;
const TIME_RE = /(\d{1,2}:\d{2}) ([ap])\. m\./g;

/** «lun 3 nov» → «Mon, Nov 3»; «2:00 p. m.» → «2:00 PM». */
export function enDates(s) {
  return s
    .replace(DATE_RE, (_m, w, d, mo) => `${WEEKDAYS[w]}, ${MONTHS[mo]} ${d}`)
    .replace(TIME_RE, (_m, t, ap) => `${t} ${ap === 'a' ? 'AM' : 'PM'}`);
}

const EMOJI_START = /^((?:\p{Extended_Pictographic}️?)+)\s+(.+)$/u;
const EMOJI_END = /^(.+?)\s+((?:\p{Extended_Pictographic}️?)+)$/u;
// Between sentences: «… a la oficina. Si lo ves…», not inside «2:00 p. m.».
const SENTENCES = /(?<=[.!?»])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«])/u;

/**
 * dict: { Spanish: English }; patterns: [regular expression over the one-line text, English with $1… or a
 * function of the (already translated) parts]. Returns translate(text): the English, or undefined when nothing
 * in it is known.
 */
export function makeTranslator(dict, patterns) {
  function translate(norm) {
    if (!norm) return undefined;
    let out = dict[norm];
    if (out === undefined) {
      for (const [re, to] of patterns) {
        if (re.test(norm)) {
          // The parts it takes (names, places, other sentences) are translated too.
          const parts = (m) => m.slice(1, m.findIndex((x) => typeof x === 'number')).map((v) => any(v));
          out = norm.replace(re, typeof to === 'function'
            ? (...m) => to(...parts(m))
            : (...m) => {
                const p = parts(m);
                return to.replace(/\$(\d)/g, (_x, i) => p[Number(i) - 1] ?? '');
              });
          break;
        }
      }
    }
    if (out === undefined) {
      const m = norm.match(EMOJI_START) || norm.match(EMOJI_END);
      if (m) {
        const start = EMOJI_START.test(norm);
        const inner = translate(start ? m[2] : m[1]);
        if (inner !== undefined) out = start ? `${m[1]} ${inner}` : `${inner} ${m[2]}`;
      }
    }
    if (out === undefined) {
      const sentences = norm.split(SENTENCES);
      if (sentences.length > 1) out = joinIfAny(sentences, ' ');
    }
    // «… · avisó Ana Torres.»: without its period.
    if (out === undefined && /[^.]\.$/.test(norm)) {
      const inner = translate(norm.slice(0, -1));
      if (inner !== undefined) out = /[.!?]$/.test(inner) ? inner : `${inner}.`;
    }
    if (out === undefined) {
      for (const sep of [' · ', ' › ']) {
        if (norm.includes(sep)) {
          out = joinIfAny(norm.split(sep), sep);
          if (out !== undefined) break;
        }
      }
    }
    if (out === undefined) {
      const dated = enDates(norm);
      return dated === norm ? undefined : dated;
    }
    return enDates(out);
  }
  /** The parts translated, or undefined when none of them changed. */
  function joinIfAny(parts, sep) {
    const done = parts.map((p) => translate(p));
    return done.some((x) => x !== undefined) ? done.map((x, i) => x ?? parts[i]).join(sep) : undefined;
  }
  /** Always a text: translated if known, as it was if not. */
  const any = (v) => (v === undefined ? v : translate(v) ?? v);
  return translate;
}
