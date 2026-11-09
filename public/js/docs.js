// Documents that prove they come from Hallway: every PDF, picture or Excel of a history is sealed in the database
// (seal_document: a code, who, when and a copy of what it contains, read by the database), and carries that code and
// a QR code that opens #/verify/CODE, where anyone sees what Hallway kept. If the paper says something else, it was
// changed.
//   * PDF: the phone's «Imprimir › Guardar como PDF» with Hallway's layout (header, title, details, the items and a
//     verification box; the code at the bottom of every page).
//   * Picture (PNG): the same, drawn.
//   * Excel: a «Verificación» sheet with the code, the link and the QR code.
import { sealDocument } from './backend.js';
import { CATEGORIES, dialog, fmtDateTime, fmtLongDate, fmtTime, html } from './lib.js';
import { t } from './i18n.js';
import { appIcon } from './branding.js';
import { state } from './store.js';

/** The page that checks a code (it works without an account). */
export function verifyLink(code) {
  return `${location.origin}${location.pathname}#/verify/${String(code).replace(/-/g, '')}`;
}

async function qr(text) {
  const { default: qrcode } = await import('../vendor/qrcode.js');
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q;
}

/** The QR code as SVG (dark on white, so any camera reads it). */
export async function qrSvg(text, alt = 'Código QR') {
  return (await qr(text)).createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt });
}

/** The QR code as rows of dark (true) and light modules. */
export async function qrMatrix(text) {
  const q = await qr(text);
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

/** Seals the document in the database: { code, created_at, items, hash, created_by_name }. */
export const seal = (o) => sealDocument(o);

// ---- What each kind of item says (the same in the PDF, the picture and the verification page) ------------------

const STATUS = { pending: 'Pendiente', received: 'Recibida', cancelled: 'Cancelada' };
const SEVERITY = ['', 'Baja', 'Media', 'Alta', 'Urgente'];
const OUTCOME = {
  returned: 'Regresó al salón', picked_up: 'Lo recogieron', referred: 'Referido', attended: 'Atendido',
  unconfirmed: 'Regreso sin confirmar',
};

const range = (a) => (a.start_date === a.end_date ? fmtLongDate(a.start_date) : `${fmtLongDate(a.start_date)} → ${fmtLongDate(a.end_date)}`);
const hours = (a) => (a.partial ? (a.end_time ? `${fmtTime(a.start_time)} – ${fmtTime(a.end_time)}` : `${t('Desde')} ${fmtTime(a.start_time)}`) : t('Día completo'));

/** One absence: { title, lines }. own: one's own (no name as the title). */
export function absenceBlock(a, own = false) {
  return {
    title: own ? range(a) : a.employee_name,
    lines: [
      own ? null : `${range(a)} · ${hours(a)}`,
      own ? hours(a) : null,
      [own ? null : a.employee_position, !own && a.groups?.length ? `${t('Grupos')}: ${a.groups.join(', ')}` : null, t(STATUS[a.status] || a.status)]
        .filter(Boolean).join(' · '),
      a.category ? `${t('Tipo')}: ${t(CATEGORIES[a.category] || a.category)}` : null,
      a.reason ? `${t('Causa')}: ${a.reason}` : null,
      a.covers?.length ? `${t('Cubre')}: ${a.covers.join(', ')}${a.cover_groups?.length ? ` (${a.cover_groups.join(', ')})` : ''}`
        : a.no_cover ? t('Nadie cubre') : t('Sin cobertura asignada'),
    ].filter(Boolean),
  };
}

/** How a turn ended, with who closed it. */
function turnEnd(r) {
  if (r.status === 'cancelled') {
    return r.outcome === 'expired'
      ? t('Cerrado por el sistema: terminó el horario escolar')
      : `${t('Cancelado')}${r.closed_by_name && r.closed_by_name !== 'Sistema' ? ` · ${r.closed_by_name}` : ''}`;
  }
  if (r.status === 'done') return `${t(OUTCOME[r.outcome] || 'Terminado')}${r.closed_by_name ? ` · ${t('cerró')} ${r.closed_by_name}` : ''}`;
  return t('En curso');
}

/** One turn: { title, lines }. */
export function turnBlock(r) {
  return {
    title: r.student_name ? `${r.student_name}${r.group_name ? ` (${r.group_name})` : ''}` : r.reason || r.service_name,
    lines: [
      [r.service_name, r.student_name ? r.reason : null, SEVERITY[r.severity] ? t(SEVERITY[r.severity]) : null, r.room ? `${t('Salón')} ${r.room}` : null]
        .filter(Boolean).join(' · '),
      `${fmtDateTime(r.created_at)} · ${t('Pidió')}: ${r.created_by_name || '—'}${r.handled_by_name ? ` · ${t('Atendió')}: ${r.handled_by_name}` : ''}`,
      turnEnd(r),
    ],
  };
}

/** One line of the staff history: { title, lines }. */
export function historyBlock(r) {
  return {
    title: `${fmtDateTime(r.at)} · ${r.actor_name}`,
    lines: [r.action, r.details, r.record].filter(Boolean),
  };
}

// ---- PDF ------------------------------------------------------------------------------------------------------

// Letter pages at 150 dpi.
const PAGE_W = 1275;
const PAGE_H = 1650;
const MARGIN = 80;

const fontOf = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

function wrapText(ctx, text, size, weight, width) {
  ctx.font = fontOf(size, weight);
  const out = [];
  let line = '';
  for (const w of String(text).split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** The document in Hallway's layout, as Letter pages (canvases): header, items, verification box, page footers. */
async function docPages(doc, s) {
  const school = doc.school || state.me?.school?.name || '';
  const link = verifyLink(s.code);
  const [icon, matrix] = await Promise.all([loadImage(appIcon()), qrMatrix(link)]);
  const W = PAGE_W - MARGIN * 2;
  const BOTTOM = PAGE_H - MARGIN - 30;
  const pages = [];
  let ctx;
  let y;
  const newPage = () => {
    const c = document.createElement('canvas');
    c.width = PAGE_W;
    c.height = PAGE_H;
    ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    pages.push(c);
    y = MARGIN;
  };
  const text = (str, x, yy, size, weight, color, align = 'left') => {
    ctx.font = fontOf(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(str, x, yy);
    ctx.textAlign = 'left';
  };
  newPage();

  // Header: Hallway's blue, the icon, the school and the code.
  const HEAD = 120;
  const grad = ctx.createLinearGradient(MARGIN, y, MARGIN + W, y + HEAD);
  grad.addColorStop(0, '#1e4fd8');
  grad.addColorStop(1, '#1a43b8');
  ctx.fillStyle = grad;
  roundRect(ctx, MARGIN, y, W, HEAD, 18);
  ctx.fill();
  if (icon) {
    ctx.save();
    roundRect(ctx, MARGIN + 24, y + 26, 68, 68, 14);
    ctx.clip();
    ctx.drawImage(icon, MARGIN + 24, y + 26, 68, 68);
    ctx.restore();
  }
  text('Hallway', MARGIN + 112, y + 58, 32, 700, '#ffffff');
  text(school, MARGIN + 112, y + 92, 22, 500, '#d6e0ff');
  text(t('Código de verificación'), MARGIN + W - 24, y + 52, 18, 500, '#d6e0ff', 'right');
  text(s.code, MARGIN + W - 24, y + 88, 28, 700, '#ffffff', 'right');
  y += HEAD + 46;

  // Title, details and who made it.
  for (const l of wrapText(ctx, doc.title, 40, 700, W)) {
    text(l, MARGIN, y, 40, 700, '#0f172a');
    y += 50;
  }
  const meta = [
    ...(doc.subtitle ? wrapText(ctx, doc.subtitle, 22, 400, W) : []),
    ...wrapText(ctx, `${t('Generado por')} ${s.created_by_name} · ${fmtDateTime(s.created_at)} · ${s.items} ${t(s.items === 1 ? 'elemento' : 'elementos')}`, 22, 400, W),
  ];
  for (const l of meta) {
    text(l, MARGIN, y, 22, 400, '#475569');
    y += 32;
  }
  y += 16;

  // The items, each in its box (a box moves to the next page when it doesn't fit).
  for (const b of doc.blocks) {
    const lines = [
      ...wrapText(ctx, b.title, 26, 700, W - 48).map((l) => [l, 26, 700, '#0f172a', 36]),
      ...b.lines.flatMap((x) => wrapText(ctx, x, 21, 400, W - 48).map((l) => [l, 21, 400, '#334155', 30])),
    ];
    const h = lines.reduce((n, l) => n + l[4], 0) + 28;
    if (y + h > BOTTOM && y > MARGIN + 10) newPage();
    if (h <= BOTTOM - MARGIN) {
      ctx.fillStyle = '#f1f5f9';
      roundRect(ctx, MARGIN, y, W, h, 14);
      ctx.fill();
      ctx.fillStyle = '#1e4fd8';
      ctx.fillRect(MARGIN, y + 8, 5, h - 16);
    }
    let ly = y + 14;
    for (const [l, size, weight, color, gap] of lines) {
      if (ly + gap > BOTTOM) {
        newPage();
        ly = y;
      }
      ly += gap;
      text(l, MARGIN + 28, ly - 9, size, weight, color);
    }
    y = Math.max(y + h, ly + 14) + 12;
  }

  // The verification box: the QR code, the code and the link.
  const QR = 230;
  const info = wrapText(ctx, t('Este documento salió de Hallway. Para comprobar que es auténtico y que no se cambió, escanea el código QR o entra a la dirección de abajo y compáralo con lo que Hallway guardó.'), 20, 400, W - QR - 80);
  const linkLines = wrapText(ctx, link, 18, 400, W - QR - 80);
  const VB = Math.max(QR + 40, 130 + info.length * 28 + linkLines.length * 26);
  if (y + VB + 10 > BOTTOM) newPage();
  y += 10;
  ctx.strokeStyle = '#1e4fd8';
  ctx.lineWidth = 3;
  roundRect(ctx, MARGIN, y, W, VB, 16);
  ctx.stroke();
  const cell = Math.floor(QR / (matrix.length + 4));
  const qx = MARGIN + 20 + 2 * cell;
  const qy = y + 20 + 2 * cell;
  ctx.fillStyle = '#000000';
  matrix.forEach((row, r) => row.forEach((dark, c) => { if (dark) ctx.fillRect(qx + c * cell, qy + r * cell, cell, cell); }));
  const tx = MARGIN + QR + 50;
  text(t('Documento verificable'), tx, y + 48, 26, 700, '#0f172a');
  text(s.code, tx, y + 92, 30, 700, '#1e4fd8');
  let iy = y + 128;
  for (const l of info) {
    text(l, tx, iy, 20, 400, '#334155');
    iy += 28;
  }
  for (const l of linkLines) {
    text(l, tx, iy, 18, 400, '#1e4fd8');
    iy += 26;
  }

  // Every page: who and the code, and the page number.
  pages.forEach((c, i) => {
    ctx = c.getContext('2d');
    ctx.fillStyle = '#e0e6f0';
    ctx.fillRect(MARGIN, PAGE_H - MARGIN + 6, W, 2);
    text(`Hallway · ${school} · ${t('Código')} ${s.code}`, MARGIN, PAGE_H - MARGIN + 36, 18, 400, '#64748b');
    text(`${t('Página')} ${i + 1} ${t('de')} ${pages.length}`, MARGIN + W, PAGE_H - MARGIN + 36, 18, 400, '#64748b', 'right');
  });
  return pages;
}

/** A PDF file made of the pages (each one a JPEG picture of a Letter page). */
async function pdfOf(pages, title) {
  const jpegs = await Promise.all(pages.map((c) => new Promise((resolve, reject) => c.toBlob(
    (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('No se pudo crear el PDF.'))), 'image/jpeg', 0.9))));
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (x) => {
    const bytes = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id, write) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    write();
    push('\nendobj\n');
  };
  const n = pages.length;
  // 1 catalog, 2 pages, 3 info; each page: page, contents and picture.
  const ids = (i) => [4 + i * 3, 5 + i * 3, 6 + i * 3];
  const pdfText = (str) => `(${String(str).replace(/[^\x20-\x7e]/g, '').replace(/([()\\])/g, '\\$1')})`;
  push('%PDF-1.4\n%âãÏÓ\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${ids(i)[0]} 0 R`).join(' ')}] /Count ${n} >>`));
  object(3, () => push(`<< /Title ${pdfText(title)} /Producer (Hallway) >>`));
  jpegs.forEach((jpg, i) => {
    const [page, contents, image] = ids(i);
    object(page, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`));
    const draw = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
    object(contents, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    object(image, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${PAGE_W} /Height ${PAGE_H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
  });
  const count = 3 + n * 3;
  const xref = length;
  push(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** The document as a PDF file in Hallway's layout (no printing needed: it works the same on phones and computers). */
export async function docPdf(doc, s) {
  return pdfOf(await docPages(doc, s), doc.title);
}

/**
 * «Tu documento está listo»: buttons to share it (WhatsApp, email, Archivos, Imprimir…) or download it. The tap on the
 * button is what lets the phone open «Compartir»; doing it after waiting for the server doesn't always work.
 */
export async function offerFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const file = new window.File([blob], name, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const pending = dialog({
    title: t('Tu documento está listo'),
    message: canShare
      ? t('Compártelo (correo, WhatsApp, Archivos, Imprimir…) o descárgalo.')
      : t('Descárgalo para guardarlo, enviarlo o imprimirlo.'),
    body: html`<div class="stack">
      ${canShare ? html`<button type="button" class="btn btn-primary btn-block" data-share>${t('Compartir o guardar')}</button>` : ''}
      <a class="btn ${canShare ? 'btn-secondary' : 'btn-primary'} btn-block" href="${url}" download="${name}" target="_blank" rel="noopener" data-download>${t('Descargar')}</a>
    </div>`,
    confirmText: t('Listo'),
    cancelText: '',
  });
  const box = document.querySelector('dialog.dialog:last-of-type');
  box?.querySelector('[data-share]')?.addEventListener('click', () => {
    navigator.share({ files: [file], title: name }).catch(() => {});
  });
  await pending;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The PDF of a document already sealed, offered to share or download. */
export async function savePdf(doc, s, name) {
  await offerFile(await docPdf(doc, s), name);
}

// ---- Picture --------------------------------------------------------------------------------------------------

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The same document as a PNG: Hallway's header, the items and the verification box with the QR code. */
export async function docImage(doc, s) {
  const W = 1080;
  const PAD = 56;
  const link = verifyLink(s.code);
  const school = doc.school || state.me?.school?.name || '';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const wrap = (text, size, weight, width = W - PAD * 2 - 48) => {
    ctx.font = font(size, weight);
    const out = [];
    let line = '';
    for (const w of String(text).split(' ')) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > width && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const HEAD = 120;
  const head = [
    ...wrap(doc.title, 40, 700).map((text) => ({ text, size: 40, weight: 700, color: '#0f172a', gap: 50 })),
    ...(doc.subtitle ? wrap(doc.subtitle, 24).map((text) => ({ text, size: 24, weight: 400, color: '#475569', gap: 34 })) : []),
    ...wrap(`${t('Generado por')} ${s.created_by_name} · ${fmtDateTime(s.created_at)}`, 22).map((text) => ({ text, size: 22, weight: 400, color: '#64748b', gap: 32 })),
  ];
  let y = HEAD + 30;
  for (const h of head) y += h.gap;
  y += 24;
  const blocks = doc.blocks.map((b) => {
    const lines = [
      ...wrap(b.title, 30, 700).map((text) => ({ text, size: 30, weight: 700, color: '#0f172a', gap: 40 })),
      ...b.lines.flatMap((l) => wrap(l, 24).map((text) => ({ text, size: 24, weight: 400, color: '#334155', gap: 34 }))),
    ];
    const h = lines.reduce((n, l) => n + l.gap, 0) + 32;
    const out = { y, h, lines };
    y += h + 16;
    return out;
  });
  const QR = 220;
  const verifyText = wrap(t('Escanea el código QR o entra a la dirección para comprobar que este documento salió de Hallway y no se cambió.'), 22, 400, W - PAD * 2 - QR - 72);
  const VERIFY = Math.max(QR + 40, 140 + verifyText.length * 30);
  const verifyY = y + 8;
  const H = verifyY + VERIFY + PAD;
  canvas.width = W;
  canvas.height = H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Header: Hallway's blue with the icon, the school and the code.
  const grad = ctx.createLinearGradient(0, 0, W, HEAD);
  grad.addColorStop(0, '#1e4fd8');
  grad.addColorStop(1, '#1a43b8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, HEAD);
  const icon = await loadImage(appIcon());
  if (icon) {
    ctx.save();
    roundRect(ctx, PAD, 28, 64, 64, 14);
    ctx.clip();
    ctx.drawImage(icon, PAD, 28, 64, 64);
    ctx.restore();
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = font(30, 700);
  ctx.fillText('Hallway', PAD + 84, 58);
  ctx.fillStyle = '#d6e0ff';
  ctx.font = font(22, 500);
  ctx.fillText(school, PAD + 84, 90);
  ctx.textAlign = 'right';
  ctx.font = font(18, 500);
  ctx.fillText(t('Código de verificación'), W - PAD, 54);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(26, 700);
  ctx.fillText(s.code, W - PAD, 88);
  ctx.textAlign = 'left';
  let hy = HEAD + 30;
  for (const h of head) {
    hy += h.gap;
    ctx.font = font(h.size, h.weight);
    ctx.fillStyle = h.color;
    ctx.fillText(h.text, PAD, hy - 10);
  }
  for (const b of blocks) {
    ctx.fillStyle = '#f1f5f9';
    roundRect(ctx, PAD, b.y, W - PAD * 2, b.h, 18);
    ctx.fill();
    let ly = b.y + 16;
    for (const l of b.lines) {
      ly += l.gap;
      ctx.font = font(l.size, l.weight);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, PAD + 24, ly - 10);
    }
  }
  // Verification box: the QR code, the code and the link.
  ctx.strokeStyle = '#1e4fd8';
  ctx.lineWidth = 3;
  roundRect(ctx, PAD, verifyY, W - PAD * 2, VERIFY, 18);
  ctx.stroke();
  const matrix = await qrMatrix(link);
  const cell = Math.floor(QR / (matrix.length + 4));
  const qx = PAD + 20 + 2 * cell;
  const qy = verifyY + 20 + 2 * cell;
  ctx.fillStyle = '#000000';
  matrix.forEach((row, r) => row.forEach((dark, c) => { if (dark) ctx.fillRect(qx + c * cell, qy + r * cell, cell, cell); }));
  const tx = PAD + QR + 48;
  ctx.fillStyle = '#0f172a';
  ctx.font = font(26, 700);
  ctx.fillText(t('Documento verificable'), tx, verifyY + 52);
  ctx.font = font(30, 700);
  ctx.fillStyle = '#1e4fd8';
  ctx.fillText(s.code, tx, verifyY + 96);
  ctx.font = font(22);
  ctx.fillStyle = '#475569';
  verifyText.forEach((l, i) => ctx.fillText(l, tx, verifyY + 136 + i * 30));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen.'))), 'image/png'));
}

// ---- Excel ----------------------------------------------------------------------------------------------------

/** The «Verificación» sheet for an Excel (xlsx.js): the code, the link and the QR code. */
export async function verifySheet(s, title) {
  const link = verifyLink(s.code);
  return {
    name: t('Verificación'),
    verify: {
      lines: [
        `Hallway · ${t('Documento verificable')}`,
        title,
        `${t('Código de verificación')}: ${s.code}`,
        `${t('Generado por')} ${s.created_by_name} · ${fmtDateTime(s.created_at)} · ${s.items} ${t(s.items === 1 ? 'elemento' : 'elementos')}`,
        `${t('Verifica en')}: ${link}`,
        t('Escanea el código QR o entra a la dirección para comprobar que este documento salió de Hallway y no se cambió.'),
      ],
      matrix: await qrMatrix(link),
    },
  };
}
