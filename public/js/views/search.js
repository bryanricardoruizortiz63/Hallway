// Búsquedas (each one a permission in «Roles y permisos», off until the Admin turns it on):
//   #/search/absences     «Buscar ausencias»: the staff's absences by name, dates and group (never the reason); the
//                         chosen ones are saved as a PDF (print) or an image (PNG) to send them.
//   #/search/my-absences  «Buscar mis ausencias»: one's own, by dates; saved the same way.
//   #/search/turns        «Buscar turnos»: today's and earlier days' turns.
import { searchAbsences, searchMyAbsences, searchTurns, servicesOverview } from '../backend.js';
import { $, CATEGORIES, can, addDays, busy, fmtDateTime, fmtLongDate, fmtTime, html, schoolCalendar, toast, todayStr } from '../lib.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { empty } from './common.js';
import { SEVERITY, outcomeLabel } from './turns.js';

const STATUS = { pending: 'Pendiente', received: 'Recibida', cancelled: 'Cancelada' };

const range = (a) => (a.start_date === a.end_date ? fmtLongDate(a.start_date) : `${fmtLongDate(a.start_date)} → ${fmtLongDate(a.end_date)}`);
const hours = (a) => (a.partial ? (a.end_time ? `${fmtTime(a.start_time)} – ${fmtTime(a.end_time)}` : `${t('Desde')} ${fmtTime(a.start_time)}`) : t('Día completo'));
const coverText = (a) =>
  a.covers?.length ? `${t('Cubre')}: ${a.covers.join(', ')}` : a.no_cover ? t('Nadie cubre') : t('Sin cobertura asignada');

/** The lines of one absence, the same on screen, in the PDF and in the image. */
function absenceLines(a, own) {
  return [
    `${range(a)} · ${hours(a)}`,
    own
      ? [a.category ? t(CATEGORIES[a.category]) : null, t(STATUS[a.status] || a.status)].filter(Boolean).join(' · ')
      : [a.employee_position, a.groups?.length ? `${t('Grupos')}: ${a.groups.join(', ')}` : null, t(STATUS[a.status] || a.status)].filter(Boolean).join(' · '),
    [coverText(a), a.cover_groups?.length ? `(${a.cover_groups.join(', ')})` : null].filter(Boolean).join(' '),
  ].filter(Boolean);
}

const groupOptions = (selected = '') => {
  const { groups } = schoolCalendar(state.me.school);
  return html`<option value="">${'Todos'}</option>${groups.map((g) => html`<option value="${g}" ${g === selected ? 'selected' : ''}>${g}</option>`)}`;
};

/** Monday… of this school year: the default «Desde» (the last 30 days). */
const defaultFrom = () => addDays(todayStr(), -30);

/** «Buscar ausencias» and «Buscar mis ausencias». */
function absenceSearch({ el }, own) {
  let rows = [];
  const picked = new Set();

  el.innerHTML = String(html`<div class="stack search-page">
    <form class="card stack no-print" data-filters>
      ${own
        ? ''
        : html`<label class="field"><span>Nombre</span>
            <input type="search" name="name" placeholder="Ej. Ana Torres" autocomplete="off"></label>`}
      <div class="grid2">
        <label class="field"><span>Desde</span><input type="date" name="from" value="${defaultFrom()}"></label>
        <label class="field"><span>Hasta</span><input type="date" name="to" value="${addDays(todayStr(), 30)}"></label>
      </div>
      ${own ? '' : html`<label class="field"><span>Grado o grupo</span><select name="group">${groupOptions()}</select></label>`}
      <button class="btn btn-primary btn-block" type="submit">${icon('search', 18)} Buscar</button>
      ${own ? '' : html`<p class="hint">Busca por el grupo de la persona o por los grupos que se cubrieron. No se muestra la causa de la ausencia.</p>`}
    </form>
    <div class="list-head no-print" data-bar hidden>
      <label class="check-all"><input type="checkbox" data-all> <span data-count></span></label>
      <span class="quick">
        <button type="button" class="btn btn-secondary btn-sm" data-pdf>${icon('download', 16)} PDF</button>
        <button type="button" class="btn btn-secondary btn-sm" data-png>${icon('camera', 16)} Foto</button>
      </span>
    </div>
    <section class="print-only" data-print-head></section>
    <div data-rows></div>
  </div>`);

  const form = $('[data-filters]', el);
  const box = $('[data-rows]', el);
  const bar = $('[data-bar]', el);

  const filtersText = () => {
    const v = Object.fromEntries(new FormData(form));
    return [
      v.name ? `${t('Nombre')}: ${v.name}` : null,
      v.from || v.to ? `${v.from ? fmtLongDate(v.from) : '…'} – ${v.to ? fmtLongDate(v.to) : '…'}` : null,
      v.group ? `${t('Grupo')}: ${v.group}` : null,
    ].filter(Boolean).join(' · ');
  };
  const chosen = () => rows.filter((a) => picked.has(a.id));
  const title = () => (own ? `${t('Mis ausencias')} · ${state.me.user.full_name}` : t('Ausencias del personal'));

  const count = () => {
    $('[data-count]', el).textContent = picked.size
      ? `${picked.size} ${t(picked.size === 1 ? 'seleccionada' : 'seleccionadas')} ${t('de')} ${rows.length}`
      : `${rows.length} ${t(rows.length === 1 ? 'ausencia' : 'ausencias')} · ${t('Selecciona las que quieras guardar')}`;
    $('[data-all]', el).checked = rows.length > 0 && picked.size === rows.length;
    for (const b of el.querySelectorAll('[data-pdf], [data-png]')) b.disabled = !picked.size;
  };

  const draw = () => {
    bar.hidden = !rows.length;
    box.innerHTML = String(rows.length
      ? html`<div class="list search-results">${rows.map((a) => html`<label class="item search-row ${picked.has(a.id) ? 'is-picked' : ''}" data-row="${a.id}">
          <input type="checkbox" class="no-print" data-pick="${a.id}" ${picked.has(a.id) ? 'checked' : ''}>
          <span class="item-main">
            <strong>${own ? range(a) : a.employee_name}</strong>
            ${(own ? absenceLines(a, own).slice(1) : absenceLines(a, own)).map((l) => html`<span class="item-sub">${l}</span>`)}
          </span>
          ${own || can(state.me.user, 'absences') ? html`<a class="icon-btn no-print" href="#/absence/${a.id}" aria-label="Abrir">${icon('chevron', 18)}</a>` : ''}
        </label>`)}</div>`
      : empty('search', 'Sin resultados', 'Prueba con otras fechas u otro nombre.'));
    for (const input of box.querySelectorAll('[data-pick]')) {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.pick);
        if (input.checked) picked.add(id);
        else picked.delete(id);
        input.closest('[data-row]').classList.toggle('is-picked', input.checked);
        count();
      });
    }
    if (rows.length) count();
  };

  const search = async () => {
    const v = Object.fromEntries(new FormData(form));
    if (v.from && v.to && v.to < v.from) throw new Error('La fecha final debe ser después de la inicial.');
    rows = own ? await searchMyAbsences(v) : await searchAbsences(v);
    picked.clear();
    draw();
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), search);
  });
  $('[data-all]', el).addEventListener('change', (e) => {
    picked.clear();
    if (e.target.checked) for (const a of rows) picked.add(a.id);
    draw();
  });

  // PDF: the phone's «Imprimir» → «Guardar como PDF», with only the chosen ones.
  $('[data-pdf]', el).addEventListener('click', () => {
    if (!picked.size) return toast('Selecciona al menos una ausencia.', 'error');
    $('[data-print-head]', el).innerHTML = String(html`<h2>${title()}</h2>
      <p class="hint">${filtersText()}</p>
      <p class="hint">${state.me.school.name} · ${t('Hallway')} · ${fmtDateTime(new Date().toISOString())}</p>`);
    for (const row of box.querySelectorAll('[data-row]')) row.classList.toggle('no-print', !picked.has(Number(row.dataset.row)));
    const restore = () => {
      for (const row of box.querySelectorAll('[data-row]')) row.classList.remove('no-print');
    };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
  });

  // Image: a PNG drawn here, to send it by message or email.
  $('[data-png]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!picked.size) throw new Error('Selecciona al menos una ausencia.');
    const blob = await listImage(title(), filtersText(), chosen().map((a) => ({
      title: own ? range(a) : a.employee_name,
      lines: own ? absenceLines(a, own).slice(1) : absenceLines(a, own),
    })));
    saveBlob(blob, `${own ? 'mis-ausencias' : 'ausencias'}-${todayStr()}.png`);
    toast('Imagen guardada', 'ok');
  }));

  busy(form.querySelector('[type=submit]'), search);
}

export const absenceSearchView = (ctx) => absenceSearch(ctx, false);
export const myAbsenceSearchView = (ctx) => absenceSearch(ctx, true);

/** Gives the file to the phone: «Compartir» when it can (to send it), otherwise a download. */
function saveBlob(blob, name) {
  const file = new window.File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A white PNG with a title, the filters and one block per item (title + lines), wrapped to the width. */
async function listImage(title, subtitle, items) {
  const W = 1080;
  const PAD = 56;
  const scale = 1;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const wrap = (text, size, weight) => {
    ctx.font = font(size, weight);
    const words = String(text).split(' ');
    const out = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > W - PAD * 2 - 24 && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  // Layout first (to know the height), then paint.
  const blocks = [];
  let y = PAD;
  const head = [
    ...wrap(title, 40, 700).map((text) => ({ text, size: 40, weight: 700, color: '#0f172a', gap: 50 })),
    ...wrap(subtitle, 24, 400).map((text) => ({ text, size: 24, weight: 400, color: '#475569', gap: 34 })),
    ...wrap(`${state.me.school.name} · ${fmtDateTime(new Date().toISOString())}`, 22, 400).map((text) => ({ text, size: 22, weight: 400, color: '#64748b', gap: 32 })),
  ];
  for (const h of head) y += h.gap;
  y += 24;
  for (const it of items) {
    const lines = [
      ...wrap(it.title, 30, 700).map((text) => ({ text, size: 30, weight: 700, color: '#0f172a', gap: 40 })),
      ...it.lines.flatMap((l) => wrap(l, 24, 400).map((text) => ({ text, size: 24, weight: 400, color: '#334155', gap: 34 }))),
    ];
    const h = lines.reduce((n, l) => n + l.gap, 0) + 32;
    blocks.push({ y, h, lines });
    y += h + 16;
  }
  const H = y + PAD;
  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  let hy = PAD;
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
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen.'))), 'image/png'));
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

// ---- Turnos ----------------------------------------------------------------------------------

const OPEN = { waiting: 'En fila', called: 'Llamado', sent: 'En camino', arrived: 'En la oficina', on_the_way: 'Van en camino', returning: 'Regresando al salón' };

/** #/search/turns: today's and earlier days' turns, by dates, name (student, who asked or reason), service and group. */
export async function turnSearchView({ el }) {
  const services = await servicesOverview().catch(() => []);
  const today = todayStr();
  el.innerHTML = String(html`<div class="stack">
    <form class="card stack" data-filters>
      <div class="grid2">
        <label class="field"><span>Desde</span><input type="date" name="from" value="${today}" max="${today}"></label>
        <label class="field"><span>Hasta</span><input type="date" name="to" value="${today}" max="${today}"></label>
      </div>
      <label class="field"><span>Estudiante, quién lo pidió o motivo</span>
        <input type="search" name="name" placeholder="Ej. Rivera" autocomplete="off"></label>
      <div class="grid2">
        <label class="field"><span>Servicio</span>
          <select name="service"><option value="">${'Todos'}</option>${services.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
        <label class="field"><span>Grupo</span><select name="group">${groupOptions()}</select></label>
      </div>
      <button class="btn btn-primary btn-block" type="submit">${icon('search', 18)} Buscar</button>
      <p class="hint">Los turnos de hoy y de días anteriores (hasta el 30 de junio, cuando se borra el año escolar).</p>
    </form>
    <p class="muted" data-count></p>
    <div data-rows></div>
  </div>`);
  const form = $('[data-filters]', el);
  const search = async () => {
    const v = Object.fromEntries(new FormData(form));
    if (v.to > today) v.to = today;
    if (v.from && v.to && v.to < v.from) throw new Error('La fecha final debe ser después de la inicial.');
    const rows = await searchTurns(v);
    $('[data-count]', el).textContent = `${rows.length} ${t(rows.length === 1 ? 'turno' : 'turnos')}${rows.length >= 500 ? ` · ${t('Se muestran los 500 más recientes')}` : ''}`;
    $('[data-rows]', el).innerHTML = String(rows.length
      ? html`<div class="list search-results">${rows.map((r) => html`<a class="item" href="#/turns/${r.id}">
          <span class="item-icon">${icon(r.service_mode === 'support' ? 'wrench' : 'pulse')}</span>
          <span class="item-main">
            <strong>${r.student_name ? `${r.student_name}${r.group_name ? ` (${r.group_name})` : ''}` : r.room || r.service_name}</strong>
            <span class="item-sub">${[r.service_name, r.reason, SEVERITY[r.severity]?.label].filter(Boolean).join(' · ')}</span>
            <span class="item-sub">${fmtDateTime(r.created_at)} · ${t('Pidió')}: ${r.created_by_name || '—'}${r.handled_by_name ? ` · ${t('Atendió')}: ${r.handled_by_name}` : ''}</span>
            <span class="item-tags"><span class="tag">${['done', 'cancelled'].includes(r.status) ? (r.status === 'cancelled' && !r.outcome ? 'Cancelado' : outcomeLabel(r)) : OPEN[r.status] || r.status}</span></span>
          </span>
          ${icon('chevron', 18)}
        </a>`)}</div>`
      : empty('search', 'Sin resultados', 'Prueba con otras fechas u otro nombre.'));
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), search);
  });
  busy(form.querySelector('[type=submit]'), search);
}
