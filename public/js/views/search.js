// Búsquedas (each one a permission in «Roles y permisos», off until the Admin turns it on):
//   #/search/absences     «Buscar ausencias»: the staff's absences by name, dates and group, with the type and the reason; the
//                         chosen ones are saved as a PDF (print) or an image (PNG) to send them.
//   #/search/my-absences  «Buscar mis ausencias»: one's own, by dates; saved the same way.
//   #/search/turns        «Buscar turnos»: today's and earlier days' turns.
import { searchAbsences, searchMyAbsences, searchTurns, servicesOverview } from '../backend.js';
import { $, can, addDays, busy, fmtDateTime, fmtLongDate, html, schoolCalendar, toast, todayStr } from '../lib.js';
import { absenceBlock, docImage, printHallwayDoc, seal, turnBlock } from '../docs.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { empty } from './common.js';
import { SEVERITY, closedText } from './turns.js';

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
      ${own ? '' : html`<p class="hint">Busca por el grupo de la persona o por los grupos que se cubrieron. Incluye el tipo y la causa, para enviarlas a Recursos Humanos.</p>`}
    </form>
    <div class="list-head no-print" data-bar hidden>
      <label class="check-all"><input type="checkbox" data-all> <span data-count></span></label>
      <span class="quick">
        <button type="button" class="btn btn-secondary btn-sm" data-pdf>${icon('download', 16)} PDF</button>
        <button type="button" class="btn btn-secondary btn-sm" data-png>${icon('camera', 16)} Foto</button>
      </span>
    </div>
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
            <strong>${absenceBlock(a, own).title}</strong>
            ${absenceBlock(a, own).lines.map((l) => html`<span class="item-sub">${l}</span>`)}
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

  // PDF (the phone's «Imprimir › Guardar como PDF») and picture, in Hallway's layout. The chosen ones are sealed
  // first: the database keeps a copy, and the document carries its code and QR code to verify it.
  const sealed = async (format) => {
    if (!picked.size) throw new Error('Selecciona al menos una ausencia.');
    const s = await seal({ kind: 'absences', format, title: title(), details: filtersText(), ids: [...picked] });
    return [s, { title: title(), subtitle: filtersText(), blocks: chosen().map((a) => absenceBlock(a, own)) }];
  };
  $('[data-pdf]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const [s, doc] = await sealed('pdf');
    await printHallwayDoc(doc, s);
  }));
  $('[data-png]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const [s, doc] = await sealed('image');
    saveBlob(await docImage(doc, s), `${own ? 'mis-ausencias' : 'ausencias'}-${todayStr()}.png`);
    toast('Imagen guardada', 'ok');
  }));

  busy(form.querySelector('[type=submit]'), search);
}

export const absenceSearchView = (ctx) => absenceSearch(ctx, false);
export const myAbsenceSearchView = (ctx) => absenceSearch(ctx, true);

/** Gives the file to the phone: «Compartir» when it can (to send it), otherwise a download. */
function saveBlob(blob, name) {
  const file = new window.File([blob], name, { type: blob.type });
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // After sealing, some phones no longer let the page open «Compartir»: then it downloads.
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch((err) => { if (err?.name !== 'AbortError') download(); });
    return;
  }
  download();
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
    <div class="list-head" data-turn-bar hidden>
      <p class="muted" data-count></p>
      <button type="button" class="btn btn-secondary btn-sm" data-turns-pdf>${icon('download', 16)} PDF</button>
    </div>
    <div data-rows></div>
  </div>`);
  const form = $('[data-filters]', el);
  let rows = [];
  let filters = '';
  const search = async () => {
    const v = Object.fromEntries(new FormData(form));
    if (v.to > today) v.to = today;
    if (v.from && v.to && v.to < v.from) throw new Error('La fecha final debe ser después de la inicial.');
    rows = await searchTurns(v);
    filters = [
      v.from || v.to ? `${v.from ? fmtLongDate(v.from) : '…'} – ${v.to ? fmtLongDate(v.to) : '…'}` : null,
      v.name ? `${t('Buscar')}: ${v.name}` : null,
      v.service ? services.find((x) => String(x.id) === v.service)?.name : null,
      v.group ? `${t('Grupo')}: ${v.group}` : null,
    ].filter(Boolean).join(' · ');
    $('[data-turn-bar]', el).hidden = !rows.length;
    $('[data-count]', el).textContent = `${rows.length} ${t(rows.length === 1 ? 'turno' : 'turnos')}${rows.length >= 500 ? ` · ${t('Se muestran los 500 más recientes')}` : ''}`;
    $('[data-rows]', el).innerHTML = String(rows.length
      ? html`<div class="list search-results">${rows.map((r) => html`<a class="item" href="#/turns/${r.id}">
          <span class="item-icon">${icon(r.service_mode === 'support' ? 'wrench' : 'pulse')}</span>
          <span class="item-main">
            <strong>${r.student_name ? `${r.student_name}${r.group_name ? ` (${r.group_name})` : ''}` : r.room || r.service_name}</strong>
            <span class="item-sub">${[r.service_name, r.reason, SEVERITY[r.severity]?.label].filter(Boolean).join(' · ')}</span>
            <span class="item-sub">${fmtDateTime(r.created_at)} · ${t('Pidió')}: ${r.created_by_name || '—'}${r.handled_by_name ? ` · ${t('Atendió')}: ${r.handled_by_name}` : ''}</span>
            <span class="item-tags"><span class="tag">${['done', 'cancelled'].includes(r.status) ? closedText(r) : OPEN[r.status] || r.status}</span></span>
          </span>
          ${icon('chevron', 18)}
        </a>`)}</div>`
      : empty('search', 'Sin resultados', 'Prueba con otras fechas u otro nombre.'));
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), search);
  });
  // PDF in Hallway's layout of what was found (sealed: the database keeps a copy, with its code and QR code).
  $('[data-turns-pdf]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!rows.length) throw new Error('No hay turnos para guardar.');
    const title = t('Turnos');
    const s = await seal({ kind: 'turns', format: 'pdf', title, details: filters, ids: rows.map((r) => r.id) });
    await printHallwayDoc({ title, subtitle: filters, blocks: rows.map(turnBlock) }, s);
  }));
  busy(form.querySelector('[type=submit]'), search);
}
