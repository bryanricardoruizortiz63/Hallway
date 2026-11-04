// Branded HTML emails in the app's colors. The school's editable plain text is turned into a layout:
//   1. / 2. lines            → numbered steps
//   a line with only a URL   → a button
//   indented "Label: value"  → a highlighted box (username, password…)
//   • / - lines              → bullet lists
// Everything is escaped; table layout and inline styles so it looks the same in Gmail, Outlook and phones.

const C = {
  primary: '#1e4fd8',
  primaryDark: '#1a43b8',
  soft: '#e7eeff',
  text: '#0f172a',
  muted: '#586174',
  border: '#e0e6f0',
  bg: '#f3f5fa',
  panel: '#f6f8fd',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

/** Where the app icon is inside the email (inline attachment), see email.ts. */
export const LOGO_CID = 'leap-logo';

export type BrandedEmail = {
  /** Big heading inside the email. */
  title: string;
  /** Small line under the heading (e.g. who sent a message). */
  intro?: string;
  /** Plain-text body, already filled in. */
  text: string;
  schoolName: string;
  /** Hidden preview text that inboxes show next to the subject. */
  preheader?: string;
  /** Values shown in a code style wherever they appear (username, password). */
  highlights?: string[];
  /** Label for buttons made from lines that only contain a link. */
  buttonLabel?: string;
  /** Extra button at the end. */
  cta?: { url: string; label: string };
  /** Small print under the card. */
  note?: string;
  /** `cid:leap-logo` when the icon is attached, or a normal URL. */
  logoSrc: string;
  /** The language of the layout's own words (the text itself comes already written). Spanish by default. */
  lang?: 'es' | 'en';
};

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const URL_RE = /(https:\/\/[^\s<>"']+)/g;
const URL_ONLY = /^\s*(https:\/\/[^\s<>"']+)\s*$/;
const STEP = /^\s*(\d{1,2})[.)]\s+(.*)$/;
const BULLET = /^\s*[•\-*]\s+(.*)$/;
const INDENTED_KV = /^\s{2,}([^:]{1,40}):\s+(.+)$/;
const isKeyValue = (line: string) => INDENTED_KV.test(line) && !BULLET.test(line);
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One line of text: escaped, links clickable, highlighted values in a code style. */
function inline(text: string, highlights: string[]): string {
  return text
    .split(URL_RE)
    .map((part, i) => {
      if (i % 2 === 1) {
        const url = escapeHtml(part);
        return `<a href="${url}" style="color:${C.primary};text-decoration:underline;word-break:break-all">${url}</a>`;
      }
      // Placeholders first so one highlight can't match inside the markup of another.
      const found: string[] = [];
      let out = part;
      for (const h of highlights) {
        if (!h || h.length < 2) continue;
        out = out.replace(new RegExp(`(^|[\\s:(«"])${regexEscape(h)}(?=$|[\\s.,;:)»"])`, 'g'), (_m, pre: string) => {
          found.push(h);
          return `${pre}\u0000${found.length - 1}\u0000`;
        });
      }
      return escapeHtml(out).replace(/\u0000(\d+)\u0000/g, (_m, n: string) =>
        `<span style="font-family:${MONO};font-weight:700;color:${C.primaryDark};background:${C.soft};padding:2px 7px;border-radius:6px">${escapeHtml(found[Number(n)])}</span>`
      );
    })
    .join('');
}

function button(url: string, label: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 6px"><tr>
<td bgcolor="${C.primary}" style="border-radius:10px;background:${C.primary}">
<a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font:600 15px/1.2 ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)} &rarr;</a>
</td></tr></table>`;
}

function keyValueBox(rows: [string, string][], highlights: string[]): string {
  const cells = rows
    .map(([k, v], i) => {
      const isSecret = highlights.includes(v.trim());
      const value = isSecret
        ? `<span style="font:700 18px/1.3 ${MONO};color:${C.text};letter-spacing:.02em">${escapeHtml(v.trim())}</span>`
        : `<span style="font:600 15px/1.4 ${FONT};color:${C.text}">${inline(v.trim(), highlights)}</span>`;
      return `<tr><td style="padding:${i ? '10px' : '0'} 0 0">
<div style="font:600 11px/1.4 ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.06em">${escapeHtml(k.trim())}</div>
<div style="margin-top:2px">${value}</div></td></tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 4px;background:${C.panel};border:1px solid ${C.border};border-left:4px solid ${C.primary};border-radius:10px">
<tr><td style="padding:14px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr></table>`;
}

function bullets(items: string[], highlights: string[]): string {
  return `<ul style="margin:8px 0 4px;padding-left:20px;font:15px/1.6 ${FONT};color:${C.text}">${items
    .map((t) => `<li style="margin:2px 0">${inline(t, highlights)}</li>`)
    .join('')}</ul>`;
}

/** Lines that belong together (a step's details, or a paragraph) → HTML. */
function group(lines: string[], highlights: string[], buttonLabel: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (URL_ONLY.test(line)) {
      out.push(button(line.match(URL_ONLY)![1], buttonLabel));
      i++;
    } else if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) items.push(lines[i++].match(BULLET)![1]);
      out.push(bullets(items, highlights));
    } else if (isKeyValue(line)) {
      const rows: [string, string][] = [];
      while (i < lines.length && isKeyValue(lines[i])) {
        const m = lines[i].match(INDENTED_KV)!;
        rows.push([m[1], m[2]]);
        i++;
      }
      out.push(keyValueBox(rows, highlights));
    } else {
      const text: string[] = [];
      while (i < lines.length && !URL_ONLY.test(lines[i]) && !isKeyValue(lines[i]) && !BULLET.test(lines[i])) {
        text.push(inline(lines[i++].trim(), highlights));
      }
      out.push(`<div style="font:15px/1.6 ${FONT};color:${C.text}">${text.join('<br>')}</div>`);
    }
  }
  return out.join('');
}

function step(num: string, head: string, details: string[], highlights: string[], buttonLabel: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr>
<td width="40" valign="top" style="width:40px;padding-top:1px">
<div style="width:28px;height:28px;border-radius:14px;background:${C.soft};color:${C.primary};font:700 14px/28px ${FONT};text-align:center">${escapeHtml(num)}</div></td>
<td valign="top" style="font:15px/1.6 ${FONT};color:${C.text};padding-top:3px">
<div style="font-weight:600">${inline(head, highlights)}</div>${details.length ? group(details, highlights, buttonLabel) : ''}</td></tr></table>`;
}

/** The body text → blocks of HTML. */
export function renderBody(text: string, highlights: string[] = [], buttonLabel = 'Abrir Hallway'): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const blank = (l: string) => !l.trim();
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const s = lines[i].match(STEP);
    if (s) {
      i++;
      const details: string[] = [];
      while (i < lines.length && !blank(lines[i]) && !STEP.test(lines[i])) details.push(lines[i++]);
      out.push(step(s[1], s[2], details, highlights, buttonLabel));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !STEP.test(lines[i])) para.push(lines[i++]);
    out.push(`<div style="margin:0 0 16px">${group(para, highlights, buttonLabel)}</div>`);
  }
  return out.join('\n');
}

export function brandedHtml(e: BrandedEmail): string {
  const preheader = escapeHtml((e.preheader || '').slice(0, 140));
  const en = e.lang === 'en';
  const body = renderBody(e.text, e.highlights || [], e.buttonLabel || (en ? 'Open Hallway' : 'Abrir Hallway'));
  return `<!doctype html>
<html lang="${en ? 'en' : 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(e.title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">

<tr><td bgcolor="${C.primary}" style="background:${C.primary};background-image:linear-gradient(135deg,${C.primary},${C.primaryDark});border-radius:16px 16px 0 0;padding:22px 24px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:14px"><img src="${escapeHtml(e.logoSrc)}" width="48" height="48" alt="Hallway" style="display:block;width:48px;height:48px;border-radius:12px;border:2px solid rgba(255,255,255,.35)"></td>
<td valign="middle"><div style="font:700 19px/1.2 ${FONT};color:#ffffff">Hallway</div>
<div style="font:500 13px/1.4 ${FONT};color:#d6e0ff;margin-top:2px">${escapeHtml(e.schoolName)}</div></td>
</tr></table></td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 24px 12px;border-left:1px solid ${C.border};border-right:1px solid ${C.border}">
<h1 style="margin:0 0 ${e.intro ? '4px' : '18px'};font:700 22px/1.3 ${FONT};color:${C.text}">${escapeHtml(e.title)}</h1>
${e.intro ? `<div style="margin:0 0 20px;font:14px/1.5 ${FONT};color:${C.muted}">${escapeHtml(e.intro)}</div>` : ''}
${body}
${e.cta ? `<div style="margin:6px 0 10px">${button(e.cta.url, e.cta.label)}</div>` : ''}
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${C.border};border-top:0;border-radius:0 0 16px 16px;padding:0 24px 22px">
<div style="border-top:1px solid ${C.border};padding-top:14px;font:12px/1.5 ${FONT};color:${C.muted}">
${en ? 'Sent by' : 'Enviado por'} <b style="color:${C.text}">${escapeHtml(e.schoolName)}</b> ${en ? 'with' : 'con'} Hallway.</div></td></tr>

${e.note ? `<tr><td align="center" style="padding:14px 24px 0;font:12px/1.5 ${FONT};color:${C.muted}">${escapeHtml(e.note)}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}
