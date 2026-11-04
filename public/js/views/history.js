// Historial del personal (permission «history»): what each person did in the app, the day and the time (Puerto Rico,
// 12 hours) and the details, newest first, grouped by day. It can be printed and downloaded in Excel. The turns'
// records (the student and the turn) only reach the Admin and Director(a). It lasts one school year: on July 1 the
// year that ended is deleted, so it is downloaded before as a backup.
import { activityHistory, activityHistoryAll, exportPersonHistoryXlsx, exportSchoolHistoryXlsx, historyPeople } from '../backend.js';
import { $, busy, historyFull, html, roleLabel } from '../lib.js';
import { state } from '../store.js';
import { locale } from '../i18n.js';
import { icon } from '../icons.js';
import { avatar, empty } from './common.js';

const TZ = 'America/Puerto_Rico';
const PERIODS = [
  ['30', 'Últimos 30 días'],
  ['90', 'Últimos 3 meses'],
  ['year', 'Este año escolar'],
];

/** When the history of this school year starts: July 1 (after June 30 the year that ended is deleted). */
function yearStart() {
  const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
  // July 1, 00:00 in Puerto Rico (UTC-4, no daylight saving).
  return new Date(Date.UTC(m >= 7 ? y : y - 1, 6, 1, 4)).toISOString();
}

const KEEP_HINT = 'Hallway guarda cada año escolar (1 de agosto al 30 de junio). El 1 de julio se borran las ausencias, los turnos, los avisos y este historial del año que terminó, para no llenar la base de datos; las cuentas del personal se quedan. Descarga antes el respaldo (backup): aquí el historial, y en Más › Datos y reportes las ausencias y los turnos. Admin y Dirección reciben un aviso 1 mes, 2 semanas, 1 semana y 1 día antes.';

const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const dayTitle = (iso) => {
  const s = new Date(iso).toLocaleDateString(locale(), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** «1:05 PM» in Puerto Rico's time, whatever the phone's zone. */
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });

/** #/history: everyone, to open one's history. */
export async function historyPeopleView({ el }) {
  const people = await historyPeople();
  const render = (q = '') => {
    const needle = q.trim().toLowerCase();
    const list = people.filter((p) => !needle || `${p.full_name} ${p.job || ''}`.toLowerCase().includes(needle));
    $('[data-people]', el).innerHTML = String(list.length
      ? html`<div class="list">${list.map((p) => html`<a class="item ${p.active ? '' : 'is-muted'}" href="#/history/${p.id}">
          ${avatar(p.full_name)}
          <span class="item-main"><strong>${p.full_name}</strong>
            <span class="item-sub">${[p.job, roleLabel(p.role), p.active ? null : 'Inactivo'].filter(Boolean).join(' · ')}</span>
            <span class="item-sub">${p.actions ? `${p.actions} ${p.actions === 1 ? 'acción' : 'acciones'} · última: ${dayTitle(p.last_at)}, ${timeOf(p.last_at)}` : 'Sin actividad registrada'}</span>
          </span>
          ${icon('chevron', 18)}
        </a>`)}</div>`
      : empty('search', 'Sin resultados', 'Prueba con otra búsqueda.'));
  };
  const full = historyFull(state.me.user);
  el.innerHTML = String(html`<div class="stack">
    <p class="hint">Lo que cada persona hizo en Hallway, con el día y la hora (hora de Puerto Rico). Toca una persona para ver su historial, imprimirlo o descargarlo.</p>
    <section class="card stack">
      <h2 class="card-title">${icon('download')} Respaldo del año escolar</h2>
      <p class="hint">${KEEP_HINT}</p>
      <button type="button" class="btn btn-secondary btn-block" data-download-all>${icon('download', 18)} Descargar todo el historial del año (Excel)</button>
      <p class="hint">${full
        ? 'Incluye una hoja con el récord de cada turno: el estudiante, su grupo, el motivo y cómo terminó.'
        : 'El récord de los turnos con los estudiantes solo lo descargan Admin y Director(a).'}</p>
    </section>
    <label class="field"><span>Buscar</span><input type="search" data-search placeholder="Buscar por nombre o puesto…" autocomplete="off"></label>
    <div data-people></div>
  </div>`);
  render();
  $('[data-search]', el).addEventListener('input', (e) => render(e.target.value));
  const all = $('[data-download-all]', el);
  all.addEventListener('click', () => busy(all, async () => {
    const from = yearStart();
    const rows = await activityHistoryAll(from, new Date(Date.now() + 86_400_000).toISOString());
    exportSchoolHistoryXlsx(state.me.school, rows, full, from);
  }));
}

/** #/history/:id: one person's history, by day, with a period and a search; «Imprimir» prints what is shown. */
export async function historyView({ el, params, setTitle }) {
  const id = params[0];
  const people = await historyPeople();
  const person = people.find((p) => p.id === id);
  if (!person) {
    el.innerHTML = String(html`<div class="card">${empty('user', 'Empleado no encontrado.', '')}</div>`);
    return;
  }
  setTitle(`Historial · ${person.full_name}`);
  let period = '30';
  let rows = [];

  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => !needle || `${r.action} ${r.details || ''} ${r.actor_name} ${r.record || ''}`.toLowerCase().includes(needle));
    const days = [];
    for (const r of list) {
      const k = dayKey(r.at);
      if (days.at(-1)?.key !== k) days.push({ key: k, title: dayTitle(r.at), rows: [] });
      days.at(-1).rows.push(r);
    }
    $('[data-rows]', el).innerHTML = String(days.length
      ? html`${days.map((d) => html`<section class="section history-day">
          <h3 class="section-title">${d.title} <span class="count">${d.rows.length}</span></h3>
          <div class="list">${d.rows.map((r) => html`<div class="item history-row">
            <span class="history-time">${timeOf(r.at)}</span>
            <span class="item-main">
              <strong>${r.about ? `${r.actor_name}: ${r.action}` : r.action}</strong>
              ${r.details ? html`<span class="item-sub">${r.details}</span>` : ''}
              ${r.record ? html`<span class="item-sub history-record">${r.record}</span>` : ''}
              ${r.about ? html`<span class="item-sub">Lo hizo ${r.actor_name}, sobre ${person.full_name}</span>` : ''}
            </span>
            ${r.link ? html`<a class="icon-btn no-print" href="${r.link}" aria-label="Abrir">${icon('chevron', 18)}</a>` : ''}
          </div>`)}</div>
        </section>`)}`
      : empty('list', 'Sin actividad en este período', 'Prueba con un período más largo.'));
    $('[data-count]', el).textContent = `${list.length} ${list.length === 1 ? 'acción' : 'acciones'}`;
  };

  const load = async () => {
    const from = period === 'year' ? yearStart() : new Date(Date.now() - Number(period) * 86_400_000).toISOString();
    rows = await activityHistory(id, from, null);
    draw($('[data-search]', el).value);
  };

  el.innerHTML = String(html`<div class="stack history">
    <section class="card profile-head history-head">
      ${avatar(person.full_name, 'xl')}
      <h2>${person.full_name}</h2>
      <p class="muted">${[person.job, roleLabel(person.role), person.active ? null : 'Inactivo'].filter(Boolean).join(' · ')}</p>
      <p class="hint print-only">Historial de Hallway · impreso el ${dayTitle(new Date().toISOString())}, ${timeOf(new Date().toISOString())} (hora de Puerto Rico)</p>
    </section>
    <div class="grid2 no-print">
      <label class="field"><span>Período</span>
        <select data-period>${PERIODS.map(([v, l]) => html`<option value="${v}" ${v === period ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="field"><span>Buscar</span><input type="search" data-search placeholder="Ausencia, turno, alerta…" autocomplete="off"></label>
    </div>
    <div class="list-head no-print">
      <p class="muted" data-count></p>
      <span class="quick">
        <button type="button" class="btn btn-secondary btn-sm" data-xlsx>${icon('download', 16)} Excel</button>
        <button type="button" class="btn btn-secondary btn-sm" data-print>${icon('list', 16)} Imprimir</button>
      </span>
    </div>
    <div data-rows></div>
    <p class="hint">Las horas son de Puerto Rico. ${historyFull(state.me.user)
      ? 'El récord de los turnos (estudiante, motivo y resultado) solo lo ven Admin y Director(a).'
      : 'El récord de los turnos con los estudiantes solo lo ven Admin y Director(a).'}</p>
    <p class="hint no-print">${KEEP_HINT}</p>
  </div>`);
  $('[data-period]', el).addEventListener('change', (e) => {
    period = e.target.value;
    load();
  });
  $('[data-search]', el).addEventListener('input', (e) => draw(e.target.value));
  $('[data-print]', el).addEventListener('click', () => window.print());
  $('[data-xlsx]', el).addEventListener('click', () => exportPersonHistoryXlsx(person, rows, historyFull(state.me.user)));
  await load();
}
