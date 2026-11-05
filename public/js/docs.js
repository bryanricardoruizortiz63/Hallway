// Documents that prove they come from Hallway: every PDF, picture or Excel of a history is sealed in the database
// (seal_document: a code, who, when and a copy of what it contains, read by the database), and carries that code and
// a QR code that opens #/verify/CODE, where anyone sees what Hallway kept. If the paper says something else, it was
// changed.
//   * PDF: the phone's «Imprimir › Guardar como PDF» with Hallway's layout (header, title, details, the items and a
//     verification box; the code at the bottom of every page).
//   * Picture (PNG): the same, drawn.
//   * Excel: a «Verificación» sheet with the code, the link and the QR code.
import { sealDocument } from './backend.js';
import { CATEGORIES, fmtDateTime, fmtLongDate, fmtTime, html, raw } from './lib.js';
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

/**
 * Prints (or saves as PDF) a document in Hallway's layout. doc: { title, subtitle, blocks: [{ title, lines }] },
 * s: the seal. Only the document is printed; the screen stays as it was.
 */
export async function printHallwayDoc(doc, s) {
  const link = verifyLink(s.code);
  const school = doc.school || state.me?.school?.name || '';
  const qrCode = await qrSvg(link, t('Código QR para verificar el documento'));
  const box = document.createElement('div');
  box.id = 'hallway-doc';
  box.className = 'hw-doc';
  box.innerHTML = String(html`
    <header class="hw-doc-head">
      <img src="${appIcon()}" alt="" width="40" height="40">
      <div class="hw-doc-brand"><strong>Hallway</strong><span>${school}</span></div>
      <div class="hw-doc-id"><span>${t('Código de verificación')}</span><strong>${s.code}</strong></div>
    </header>
    <h1>${doc.title}</h1>
    ${doc.subtitle ? html`<p class="hw-doc-sub">${doc.subtitle}</p>` : ''}
    <p class="hw-doc-meta">${t('Generado por')} ${s.created_by_name} · ${fmtDateTime(s.created_at)} · ${s.items} ${t(s.items === 1 ? 'elemento' : 'elementos')}</p>
    <section class="hw-doc-items">
      ${doc.blocks.map((b) => html`<article class="hw-doc-item"><h2>${b.title}</h2>${b.lines.map((l) => html`<p>${l}</p>`)}</article>`)}
    </section>
    <section class="hw-doc-verify">
      <div class="hw-doc-qr">${raw(qrCode)}</div>
      <div>
        <h3>${t('Documento verificable')}</h3>
        <p>${t('Este documento salió de Hallway. Para comprobar que es auténtico y que no se cambió, escanea el código QR o entra a la dirección de abajo y compáralo con lo que Hallway guardó.')}</p>
        <p class="hw-doc-code">${s.code}</p>
        <p class="hw-doc-link">${link}</p>
      </div>
    </section>
    <footer class="hw-doc-foot">Hallway · ${school} · ${t('Código')} ${s.code}</footer>`);
  document.body.append(box);
  document.body.classList.add('print-doc');
  // Pictures (the icon, the QR) have to load before printing.
  await Promise.all([...box.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  const done = () => {
    document.body.classList.remove('print-doc');
    box.remove();
  };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
  // Some phones don't send «afterprint»: the box is hidden on screen anyway, and removed a moment later.
  setTimeout(() => { if (box.isConnected && !matchMedia('print').matches) done(); }, 60_000);
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
