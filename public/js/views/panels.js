// Paneles: what each part of the school did over a period, with an Excel download, and the live board.
//   * Service (Enfermería, Trabajo Social…): whoever attends it (only theirs) and the dirección (permission
//     "reports"), with the reasons and never the teachers' notes. At the end of the school year the service
//     downloads its history and closes it, so the names don't carry over to the next year.
//   * Mantenimiento: Mantenimiento, the dirección and the secretaría.
//   * Conference room: Secretaría and the dirección (permission "calendar").
//   * En vivo: the dirección and Secretaría (permission "live"), with each turn's reason; it refreshes by itself.
//     A grade or group can be chosen, it can ring when a student doesn't arrive, it shows who is out of their room,
//     each service's peak hours, and a big screen for a TV.
import {
  bookingsBetween,
  closeServiceYear,
  downloadXlsx,
  listClosures,
  liveBoard,
  liveHours,
  liveTurns,
  maintenanceBetween,
  servicesOverview,
  serviceTurns,
} from '../backend.js';
import {
  $,
  WEEKDAYS,
  addDays,
  busy,
  can,
  dialog,
  fmtTime,
  html,
  isoWeekday,
  schoolCalendar,
  schoolYearStart,
  timeAgo,
  toast,
  todayStr,
} from '../lib.js';
import { icon } from '../icons.js';
import { ringOnce, soundReady } from '../alarm.js';
import { appIcon } from '../branding.js';
import { state } from '../store.js';
import { xDate, xDateTime } from '../xlsx.js';
import { empty } from './common.js';
import { KINDS, URGENCY } from './maintenance.js';
import { keepFresh } from './students.js';
import { OUTCOMES, SEVERITY, STAFF_STATUS, SUPPORT_OUTCOMES } from './turns.js';

// ---- Shared ----------------------------------------------------------------------------------

const minutesBetween = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);
const average = (list) => {
  const xs = list.filter((x) => x !== null && x >= 0);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const plain = (s) => String(s).replace(/ /g, ' ');
/** The local time of a timestamp, for Excel ("1:05 p. m."). */
const clock = (iso) => (iso ? plain(fmtTime(new Date(iso))) : '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s) =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** "45 min", "1 h 20 min"; "—" when there is nothing to measure. */
export function fmtMinutes(m) {
  if (m === null || m === undefined) return '—';
  const n = Math.round(m);
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}`;
}

/** [{ label, value }] counting by key, biggest first. */
function countBy(list, keyOf) {
  const counts = new Map();
  for (const x of list) {
    const key = keyOf(x);
    if (key === null || key === undefined || key === '') continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label), 'es'));
}

/** The school days of the week, with a value each (zero included, so the pattern shows). */
function byWeekday(list, dayOf, valueOf = () => 1) {
  const days = schoolCalendar(state.me.school).school_days;
  const sums = new Map(days.map((d) => [d, 0]));
  for (const x of list) {
    const d = isoWeekday(dayOf(x));
    if (sums.has(d)) sums.set(d, sums.get(d) + valueOf(x));
  }
  return WEEKDAYS.filter((w) => sums.has(w.n)).map((w) => ({ label: cap(w.name), value: sums.get(w.n) }));
}

const localDay = (iso) => todayStr(new Date(iso));

function presets(today) {
  const thisMonth = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(thisMonth, -1);
  const year = schoolYearStart(today);
  return {
    month: { label: 'Este mes', from: thisMonth, to: today },
    last: { label: 'Mes pasado', from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    year: { label: 'Año escolar', from: year, to: today },
    prev: { label: 'Año escolar pasado', from: schoolYearStart(addDays(year, -1)), to: addDays(year, -1) },
  };
}

/** The period picker of every panel; returns a function that gives the current period. */
function rangePicker(slot, initial, onChange) {
  const list = presets(todayStr());
  let range = { ...list[initial] };
  slot.innerHTML = String(html`<section class="card stack">
    <div class="quick">${Object.entries(list).map(
      ([key, p]) => html`<button type="button" class="chip-btn ${key === initial ? 'active' : ''}" data-preset="${key}">${p.label}</button>`,
    )}</div>
    <div class="grid2">
      <label class="field"><span>Desde</span><input type="date" data-from value="${range.from}"></label>
      <label class="field"><span>Hasta</span><input type="date" data-to value="${range.to}"></label>
    </div>
  </section>`);
  const fromInput = $('[data-from]', slot);
  const toInput = $('[data-to]', slot);
  for (const btn of slot.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      range = { ...list[btn.dataset.preset] };
      fromInput.value = range.from;
      toInput.value = range.to;
      for (const b of slot.querySelectorAll('[data-preset]')) b.classList.toggle('active', b === btn);
      onChange();
    });
  }
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      if (!fromInput.value || !toInput.value) return;
      if (fromInput.value > toInput.value) {
        toast('La fecha inicial debe ser antes de la final.', 'error');
        return;
      }
      range = { from: fromInput.value, to: toInput.value };
      for (const b of slot.querySelectorAll('[data-preset]')) b.classList.remove('active');
      onChange();
    });
  }
  return () => range;
}

const tile = (value, label, cls = '') => html`<div class="stat ${cls}"><strong>${value}</strong><span>${label}</span></div>`;

/** The rows of a bar chart, one hue; the value is written next to each bar. */
function barRows(rows, format = (v) => v) {
  const max = Math.max(...rows.map((r) => r.value));
  return html`<div class="bars">${rows.map(
    (r) => html`<div class="bar-row"><span>${r.label}${r.sub ? html`<small>${r.sub}</small>` : ''}</span>
      <span class="bar"><i data-w="${(r.value / max) * 100}"></i></span><b>${format(r.value)}</b></div>`,
  )}</div>`;
}

/** A ranked list of bars. */
function bars(title, iconName, rows, { format = (v) => v, note = '' } = {}) {
  if (!rows.length || rows.every((r) => !r.value)) return '';
  return html`<section class="card stack">
    <h2 class="card-title">${icon(iconName)} ${title}</h2>
    ${barRows(rows, format)}
    ${note ? html`<p class="hint">${note}</p>` : ''}
  </section>`;
}

/** How many turns were asked at each hour of the day. */
function countByHour(turns) {
  const counts = new Map();
  for (const t of turns) {
    const h = new Date(t.created_at).getHours();
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return counts;
}

/** One row per hour of the school day (and any hour outside it that has something): "8:00 a. m.". */
function hourRows(counts) {
  const cal = schoolCalendar(state.me.school);
  const first = Math.floor(toMin(cal.day_start) / 60);
  const last = Math.floor((toMin(cal.day_end) - 1) / 60);
  const from = Math.min(first, ...counts.keys());
  const to = Math.max(last, ...counts.keys());
  const out = [];
  for (let h = from; h <= to; h++) out.push({ label: plain(fmtTime(`${h}:00`)), value: counts.get(h) || 0 });
  return out;
}

function sizeBars(root) {
  for (const bar of root.querySelectorAll('.bar i')) {
    const w = Number(bar.dataset.w);
    bar.style.width = `${w ? Math.max(3, w) : 0}%`;
  }
}

const loading = () => html`<div class="loading"><span class="spinner"></span></div>`;

/** Shows a panel's body, or the error, in its slot. */
async function fill(slot, isCurrent, build) {
  slot.innerHTML = String(loading());
  try {
    const content = await build();
    if (!isCurrent()) return;
    slot.innerHTML = String(content);
    sizeBars(slot);
  } catch (err) {
    if (isCurrent()) slot.innerHTML = String(html`<p class="status-note danger">${err.message}</p>`);
  }
}

// ---- Service ---------------------------------------------------------------------------------

export async function servicePanelView(ctx) {
  const { el, params, isCurrent, setTitle } = ctx;
  const id = Number(params[0]);
  const service = (await servicesOverview()).find((s) => s.id === id);
  if (!service) throw new Error('No se encontró el servicio.');
  if (!service.serves && !can(state.me.user, 'reports')) throw new Error('Solo quien atiende este servicio y la dirección ven su panel.');
  setTitle(`Panel de ${service.name}`);
  const visit = service.mode === 'visit';
  // Soporte IT and other help for the staff: no students; who asked, where, and what was done.
  const support = service.mode === 'support';
  const today = todayStr();
  let rows = [];
  let downloaded = false;

  el.innerHTML = String(html`<div class="stack">
    <div data-range></div>
    <div class="stack" data-body></div>
    <p class="hint">Ven este panel quien atiende ${service.name} y la dirección. Ni el panel ni el Excel incluyen las notas de los maestros.</p>
  </div>`);
  const body = $('[data-body]', el);
  const range = rangePicker($('[data-range]', el), 'month', () => load());

  const walkIn = (t) => visit && !t.called_at && !t.sent_at && !!t.arrived_at;
  const waitOf = (t) => (walkIn(t) ? null : minutesBetween(t.created_at, t.called_at || t.on_the_way_at || t.arrived_at));
  const careOf = (t) => (visit ? minutesBetween(t.arrived_at, t.returning_at || t.closed_at) : minutesBetween(t.on_the_way_at, t.closed_at));
  const resultOf = (t) =>
    t.status === 'cancelled' ? 'Cancelado' : (support && SUPPORT_OUTCOMES[t.outcome]) || OUTCOMES[t.outcome] || 'En curso';
  const totalOf = (t) => minutesBetween(t.created_at, t.closed_at);
  const whole = (m) => (m === null ? null : Math.round(m));
  const isOpen = (t) => t.status !== 'done' && t.status !== 'cancelled';

  /** Soporte IT: a summary, every request (who, where, what, what was done, times) and by reason, room and person. */
  function exportSupportExcel() {
    const r = range();
    const turns = rows.filter((t) => t.status !== 'cancelled');
    const count = (pred) => turns.filter(pred).length;
    const byRoom = new Map();
    for (const t of turns) {
      const x = byRoom.get(t.room || '—') || { count: 0, reasons: new Set() };
      x.count++;
      if (t.reason) x.reasons.add(t.reason);
      byRoom.set(t.room || '—', x);
    }
    const byPerson = new Map();
    for (const t of turns) {
      const x = byPerson.get(t.created_by_name) || { count: 0, last: null };
      x.count++;
      if (!x.last || t.created_at > x.last) x.last = t.created_at;
      byPerson.set(t.created_by_name, x);
    }
    const avg = (f) => whole(average(turns.map(f)));
    downloadXlsx(`${slug(service.name)}_${r.from}_${r.to}.xlsx`, [
      {
        name: 'Resumen',
        columns: [{ header: 'Dato', width: 34 }, { header: 'Valor', width: 14 }],
        rows: [
          ['Desde', xDate(r.from)], ['Hasta', xDate(r.to)],
          ['Pedidos', turns.length],
          ['Resueltos', count((t) => t.outcome === 'attended')],
          ['Necesitan seguimiento', count((t) => t.outcome === 'referred')],
          ['Abiertos', count(isOpen)],
          ['Cancelados', rows.length - turns.length],
          ['Urgentes', count((t) => t.severity === 4)],
          ['Personas que pidieron ayuda', byPerson.size],
          ['Espera promedio (min)', avg(waitOf)],
          ['Atención promedio (min)', avg(careOf)],
          ['Tiempo total promedio (min)', avg(totalOf)],
        ],
      },
      {
        name: 'Pedidos',
        columns: [
          { header: 'Fecha', width: 11 }, { header: 'Hora', width: 11 }, { header: 'Pidió', width: 24 },
          { header: 'Dónde', width: 14 }, { header: 'Motivo', width: 22 }, { header: 'Gravedad', width: 10 },
          { header: 'Resultado', width: 20 }, { header: 'Qué se hizo', width: 40, wrap: true }, { header: 'Espera (min)', width: 12 },
          { header: 'Atención (min)', width: 13 }, { header: 'Total (min)', width: 11 }, { header: 'Atendió', width: 22 },
        ],
        rows: rows.map((t) => [
          xDate(localDay(t.created_at)), clock(t.created_at), t.created_by_name, t.room, t.reason, SEVERITY[t.severity]?.label,
          resultOf(t), t.resolution, whole(waitOf(t)), whole(careOf(t)), whole(totalOf(t)), t.handled_by_name,
        ]),
      },
      {
        name: 'Por motivo',
        columns: [{ header: 'Motivo', width: 28 }, { header: 'Pedidos', width: 9 }, { header: 'Resueltos', width: 10 }, { header: 'Seguimiento', width: 12 }],
        rows: countBy(turns, (t) => t.reason || 'Sin motivo').map((x) => [
          x.label, x.value,
          turns.filter((t) => (t.reason || 'Sin motivo') === x.label && t.outcome === 'attended').length,
          turns.filter((t) => (t.reason || 'Sin motivo') === x.label && t.outcome === 'referred').length,
        ]),
      },
      {
        name: 'Por salón',
        columns: [{ header: 'Dónde', width: 16 }, { header: 'Pedidos', width: 9 }, { header: 'Motivos', width: 40, wrap: true }],
        rows: [...byRoom].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'es'))
          .map(([room, x]) => [room, x.count, [...x.reasons].join(', ')]),
      },
      {
        name: 'Por persona',
        columns: [{ header: 'Persona', width: 26 }, { header: 'Pedidos', width: 9 }, { header: 'Último pedido', width: 13 }],
        rows: [...byPerson].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'es'))
          .map(([name, x]) => [name, x.count, xDate(localDay(x.last))]),
      },
    ]);
  }

  function exportExcel() {
    if (support) return exportSupportExcel();
    const r = range();
    const turns = rows.filter((t) => t.status !== 'cancelled');
    const byStudent = new Map();
    for (const t of turns) {
      const s = byStudent.get(t.student_key) || { name: t.student_name, group: t.group_name, visits: 0, last: null, reasons: new Set() };
      s.visits++;
      s.group = t.group_name;
      if (!s.last || t.created_at > s.last) s.last = t.created_at;
      if (t.reason) s.reasons.add(t.reason);
      byStudent.set(t.student_key, s);
    }
    downloadXlsx(`${slug(service.name)}_${r.from}_${r.to}.xlsx`, [
      {
        name: 'Visitas',
        columns: [
          { header: 'Fecha', width: 11 }, { header: 'Hora', width: 11 }, { header: 'Estudiante', width: 26 },
          { header: 'Grupo', width: 8 }, { header: 'Motivo', width: 22 }, { header: 'Gravedad', width: 10 },
          { header: 'Resultado', width: 18 }, { header: 'Espera (min)', width: 12 }, { header: 'Atención (min)', width: 13 },
          { header: 'Llegó tarde', width: 11 }, { header: 'Sin turno', width: 10 }, { header: 'Pidió', width: 22 },
          { header: 'Atendió', width: 22 },
        ],
        rows: rows.map((t) => {
          const wait = waitOf(t);
          const care = careOf(t);
          return [
            xDate(localDay(t.created_at)), clock(t.created_at), t.student_name, t.group_name, t.reason,
            SEVERITY[t.severity]?.label, resultOf(t), wait === null ? null : Math.round(wait), care === null ? null : Math.round(care),
            t.late_at ? 'Sí' : 'No', walkIn(t) ? 'Sí' : 'No', t.created_by_name, t.handled_by_name,
          ];
        }),
      },
      {
        name: 'Por estudiante',
        columns: [
          { header: 'Estudiante', width: 26 }, { header: 'Grupo', width: 8 }, { header: 'Visitas', width: 8 },
          { header: 'Última visita', width: 13 }, { header: 'Motivos', width: 40, wrap: true },
        ],
        rows: [...byStudent.values()]
          .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name, 'es'))
          .map((s) => [s.name, s.group, s.visits, xDate(localDay(s.last)), [...s.reasons].join(', ')]),
      },
      {
        name: 'Por motivo',
        columns: [{ header: 'Motivo', width: 28 }, { header: 'Visitas', width: 8 }],
        rows: countBy(turns, (t) => t.reason || 'Sin motivo').map((x) => [x.label, x.value]),
      },
    ]);
  }

  function render() {
    const r = range();
    const turns = rows.filter((t) => t.status !== 'cancelled');
    const closable = rows.filter((t) => t.status === 'done' || t.status === 'cancelled').length;
    if (!rows.length) {
      return html`<div class="card">${empty('chart', support ? 'Sin pedidos en este período' : 'Sin turnos en este período', 'Elige otras fechas.')}</div>`;
    }
    const students = new Set(turns.map((t) => t.student_key)).size;
    const count = (pred) => turns.filter(pred).length;
    const closeCard = service.serves && r.to < today && closable
      ? html`<section class="card stack" data-close-card>
          <h2 class="card-title">${icon('archive')} Cerrar este período</h2>
          <p class="muted">Al terminar el año escolar, descarga el Excel y después borra de la app los ${support ? 'pedidos terminados' : 'turnos terminados'} de este
            período, para que el historial con nombres no pase al año siguiente. Los que siguen abiertos se quedan.</p>
          <button type="button" class="btn btn-ghost-danger btn-block" data-close ${downloaded ? '' : 'disabled'}>${icon('trash', 18)} ${closable === 1 ? `Borrar este ${support ? 'pedido' : 'turno'}` : `Borrar estos ${closable} ${support ? 'pedidos' : 'turnos'}`}</button>
          ${downloaded ? '' : html`<p class="hint">Primero descarga el Excel de este período.</p>`}
        </section>`
      : '';
    const hours = hourRows(countByHour(turns));
    if (support) {
      const referred = count((t) => t.outcome === 'referred');
      return html`
        <div class="stats">
          ${tile(turns.length, 'Pedidos')}
          ${tile(new Set(turns.map((t) => t.created_by_name)).size, 'Personas')}
          ${tile(fmtMinutes(average(turns.map(waitOf))), 'Espera promedio')}
          ${tile(fmtMinutes(average(turns.map(careOf))), 'Atención promedio')}
        </div>
        <div class="stats">
          ${tile(count((t) => t.outcome === 'attended'), 'Resueltos')}
          ${tile(referred, 'Necesitan seguimiento', referred ? 'stat-warn' : '')}
          ${tile(count(isOpen), 'Abiertos')}
          ${tile(rows.length - turns.length, 'Cancelados')}
        </div>
        <section class="card stack">
          <h2 class="card-title">${icon('download')} Descargar</h2>
          <p class="muted">Un Excel con el resumen del período, cada pedido (fecha, hora, quién lo pidió, dónde, motivo, gravedad,
            resultado, qué se hizo y tiempos) y los pedidos por motivo, por salón y por persona.</p>
          <button type="button" class="btn btn-secondary btn-block" data-export>${icon('download', 18)} Descargar Excel</button>
        </section>
        ${bars('Motivos', 'list', countBy(turns, (t) => t.reason || 'Sin motivo'))}
        ${bars('Resultado', 'check', countBy(rows, resultOf))}
        ${bars('Salones con más pedidos', 'school', countBy(turns, (t) => t.room).slice(0, 10))}
        ${bars('Quién pide más', 'users', countBy(turns, (t) => t.created_by_name).slice(0, 10))}
        ${bars('Por día de la semana', 'calendar', byWeekday(turns, (t) => localDay(t.created_at)))}
        ${bars('Por hora', 'clock', hours, { note: 'Hora en que se pidió la ayuda.' })}
        ${bars('Gravedad', 'alert', [1, 2, 3, 4].map((n) => ({ label: SEVERITY[n].label, value: count((t) => t.severity === n) })))}
        ${closeCard}`;
    }
    const topStudents = (() => {
      const m = new Map();
      for (const t of turns) {
        const s = m.get(t.student_key) || { label: t.student_name, sub: t.group_name, value: 0 };
        s.value++;
        m.set(t.student_key, s);
      }
      return [...m.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es')).slice(0, 10);
    })();
    return html`
      <div class="stats">
        ${tile(turns.length, 'Turnos')}
        ${tile(students, 'Estudiantes')}
        ${tile(fmtMinutes(average(turns.map(waitOf))), 'Espera promedio')}
        ${tile(fmtMinutes(average(turns.map(careOf))), visit ? 'Atención promedio' : 'Duración promedio')}
      </div>
      <div class="stats">
        ${visit ? tile(count((t) => t.outcome === 'picked_up'), 'Los recogieron') : tile(count((t) => t.outcome === 'attended'), 'Atendidos')}
        ${tile(count((t) => t.outcome === 'referred'), 'Referidos')}
        ${visit ? tile(count((t) => !!t.late_at), 'Llegaron tarde', count((t) => !!t.late_at) ? 'stat-warn' : '') : ''}
        ${visit ? tile(count(walkIn), 'Sin turno') : tile(rows.length - turns.length, 'Cancelados')}
      </div>
      <section class="card stack">
        <h2 class="card-title">${icon('download')} Descargar</h2>
        <p class="muted">Un Excel con cada turno (fecha, hora, estudiante, grupo, motivo, gravedad, resultado y tiempos), las visitas por estudiante y por motivo.</p>
        <button type="button" class="btn btn-secondary btn-block" data-export>${icon('download', 18)} Descargar Excel</button>
      </section>
      ${bars('Motivos', 'list', countBy(turns, (t) => t.reason || 'Sin motivo'))}
      ${bars('Resultado', 'check', countBy(rows, resultOf))}
      ${bars('Estudiantes con más turnos', 'users', topStudents)}
      ${bars('Por día de la semana', 'calendar', byWeekday(turns, (t) => localDay(t.created_at)))}
      ${bars('Por hora', 'clock', hours, { note: 'Hora en que se pidió el turno.' })}
      ${bars('Por grupo', 'grid', countBy(turns, (t) => t.group_name).slice(0, 12))}
      ${bars('Gravedad', 'alert', [1, 2, 3, 4].map((n) => ({ label: SEVERITY[n].label, value: count((t) => t.severity === n) })))}
      ${closeCard}`;
  }

  function bind() {
    $('[data-export]', body)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        exportExcel();
        if (!downloaded) {
          downloaded = true;
          body.innerHTML = String(render());
          sizeBars(body);
          bind();
        }
      }),
    );
    $('[data-close]', body)?.addEventListener('click', async () => {
      const r = range();
      const result = await dialog({
        title: '¿Borrar los turnos de este período?',
        message: `Se borran de la app los turnos terminados de ${service.name} entre ${r.from} y ${r.to}. No se puede deshacer.`,
        body: html`<label class="field"><span>Escribe BORRAR para confirmar</span>
          <input name="confirm" autocomplete="off" autocapitalize="characters"></label>`,
        confirmText: 'Borrar',
        danger: true,
        onSubmit: (v) => {
          if ((v.confirm || '').trim().toUpperCase() !== 'BORRAR') throw new Error('Escribe BORRAR para confirmar.');
          return closeServiceYear(id, r.from, r.to);
        },
      });
      if (!result) return;
      toast(`Se ${result.removed === 1 ? 'borró 1 turno' : `borraron ${result.removed} turnos`}.`, 'ok');
      await load();
    });
  }

  async function load() {
    const r = range();
    downloaded = false;
    await fill(body, isCurrent, async () => {
      rows = await serviceTurns(id, r.from, r.to);
      return render();
    });
    bind();
  }

  await load();
}

// ---- Mantenimiento ---------------------------------------------------------------------------

export async function maintenancePanelView({ el, isCurrent }) {
  let rows = [];
  el.innerHTML = String(html`<div class="stack">
    <div data-range></div>
    <div class="stack" data-body></div>
  </div>`);
  const body = $('[data-body]', el);
  const range = rangePicker($('[data-range]', el), 'month', () => load());
  const kindOf = (m) => (KINDS[m.kind] || KINDS.other).label;
  const takerOf = (m) => m.taken_by_name || m.closed_by_name;
  const statusOf = (m) => ({ pending: 'Pendiente', on_the_way: 'En camino', done: 'Listo', cancelled: 'Cancelada' })[m.status] || m.status;

  function exportExcel() {
    const r = range();
    const places = new Map();
    for (const m of rows) {
      const key = m.place.toLowerCase();
      const p = places.get(key) || { place: m.place, total: 0, done: 0, times: [] };
      p.total++;
      if (m.status === 'done') {
        p.done++;
        p.times.push(minutesBetween(m.created_at, m.done_at));
      }
      places.set(key, p);
    }
    downloadXlsx(`mantenimiento_${r.from}_${r.to}.xlsx`, [
      {
        name: 'Solicitudes',
        columns: [
          { header: 'Fecha', width: 11 }, { header: 'Hora', width: 11 }, { header: 'Tipo', width: 16 },
          { header: 'Lugar', width: 20 }, { header: 'Urgencia', width: 13 }, { header: 'Nota', width: 30, wrap: true },
          { header: 'Estado', width: 11 }, { header: 'Pidió', width: 22 }, { header: 'Atendió', width: 22 },
          { header: 'Hasta en camino (min)', width: 12 }, { header: 'Hasta listo (min)', width: 12 },
          { header: 'Qué se hizo / por qué se canceló', width: 30, wrap: true }, { header: 'Foto', width: 6 },
        ],
        rows: rows.map((m) => {
          const go = minutesBetween(m.created_at, m.on_the_way_at);
          const fixed = minutesBetween(m.created_at, m.done_at);
          return [
            xDate(localDay(m.created_at)), clock(m.created_at), kindOf(m), m.place, URGENCY[m.urgency]?.label, m.note, statusOf(m),
            m.created_by_name, takerOf(m), go === null ? null : Math.round(go), fixed === null ? null : Math.round(fixed),
            m.close_note, m.photo_path ? 'Sí' : 'No',
          ];
        }),
      },
      {
        name: 'Por lugar',
        columns: [
          { header: 'Lugar', width: 24 }, { header: 'Solicitudes', width: 11 }, { header: 'Resueltas', width: 10 },
          { header: 'Resolución promedio (min)', width: 14 },
        ],
        rows: [...places.values()]
          .sort((a, b) => b.total - a.total)
          .map((p) => [p.place, p.total, p.done, p.times.length ? Math.round(average(p.times)) : null]),
      },
    ]);
  }

  function render() {
    if (!rows.length) return html`<div class="card">${empty('wrench', 'Sin solicitudes en este período', 'Elige otras fechas.')}</div>`;
    const done = rows.filter((m) => m.status === 'done');
    const open = rows.filter((m) => m.status === 'pending' || m.status === 'on_the_way');
    const places = new Map();
    for (const m of rows) {
      const key = m.place.toLowerCase();
      const p = places.get(key) || { label: m.place, value: 0 };
      p.value++;
      places.set(key, p);
    }
    return html`
      <div class="stats">
        ${tile(rows.length, 'Solicitudes')}
        ${tile(done.length, 'Resueltas')}
        ${tile(fmtMinutes(average(rows.map((m) => minutesBetween(m.created_at, m.on_the_way_at)))), 'Hasta «en camino»')}
        ${tile(fmtMinutes(average(done.map((m) => minutesBetween(m.created_at, m.done_at)))), 'Hasta «listo»')}
      </div>
      <div class="stats">
        ${tile(rows.filter((m) => m.urgency === 3).length, 'Urgentes')}
        ${tile(open.length, 'Abiertas', open.length ? 'stat-warn' : '')}
        ${tile(rows.filter((m) => m.status === 'cancelled').length, 'Canceladas')}
      </div>
      <section class="card stack">
        <h2 class="card-title">${icon('download')} Descargar</h2>
        <p class="muted">Un Excel con cada solicitud (tipo, lugar, urgencia, quién la pidió y la atendió, y cuánto tardó) y un resumen por lugar.</p>
        <button type="button" class="btn btn-secondary btn-block" data-export>${icon('download', 18)} Descargar Excel</button>
      </section>
      ${bars('Por tipo', 'wrench', countBy(rows, kindOf))}
      ${bars('Lugares con más solicitudes', 'door', [...places.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es')).slice(0, 10))}
      ${bars('Urgencia', 'alert', [3, 2, 1].map((n) => ({ label: URGENCY[n].label, value: rows.filter((m) => m.urgency === n).length })))}
      ${bars('Por día de la semana', 'calendar', byWeekday(rows, (m) => localDay(m.created_at)))}
      ${bars('Quién las resolvió', 'users', countBy(done, takerOf))}`;
  }

  async function load() {
    const r = range();
    await fill(body, isCurrent, async () => {
      rows = await maintenanceBetween(r.from, r.to);
      return render();
    });
    $('[data-export]', body)?.addEventListener('click', (e) => busy(e.currentTarget, async () => exportExcel()));
  }

  await load();
}

// ---- Salón de conferencias -------------------------------------------------------------------

export async function roomsPanelView({ el, isCurrent }) {
  let rows = [];
  let closures = [];
  const cal = schoolCalendar(state.me.school);
  el.innerHTML = String(html`<div class="stack">
    <div data-range></div>
    <div class="stack" data-body></div>
  </div>`);
  const body = $('[data-body]', el);
  const range = rangePicker($('[data-range]', el), 'month', () => load());
  const hoursOf = (b) => (toMin(b.end_time) - toMin(b.start_time)) / 60;
  const today = todayStr();
  const statusOf = (b) => ({
    approved: 'Aprobada',
    pending: b.day < today ? 'Sin respuesta' : 'Esperando aprobación',
    rejected: 'No aprobada',
    replaced: 'Reemplazada',
    cancelled: 'Cancelada',
  })[b.status] || b.status;

  /** Hours of class in the period: school days, minus days without classes. */
  function schoolHours(r) {
    const perDay = (toMin(cal.day_end) - toMin(cal.day_start)) / 60;
    let days = 0;
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
      if (!cal.school_days.includes(isoWeekday(d))) continue;
      if (closures.some((c) => c.start_date <= d && c.end_date >= d)) continue;
      days++;
    }
    return days * perDay;
  }

  function exportExcel() {
    const r = range();
    downloadXlsx(`salon_de_conferencias_${r.from}_${r.to}.xlsx`, [{
      name: 'Reservas',
      columns: [
        { header: 'Día', width: 11 }, { header: 'Desde', width: 11 }, { header: 'Hasta', width: 11 }, { header: 'Horas', width: 7 },
        { header: 'Para qué', width: 30, wrap: true }, { header: 'Estado', width: 18 }, { header: 'Pidió', width: 22 },
        { header: 'Aprobó', width: 22 }, { header: 'Rechazó, canceló o reemplazó', width: 22 }, { header: 'Motivo', width: 28, wrap: true },
        { header: 'Pedida', width: 17 },
      ],
      rows: rows.map((b) => [
        xDate(b.day), plain(fmtTime(b.start_time)), plain(fmtTime(b.end_time)), round1(hoursOf(b)), b.purpose, statusOf(b),
        b.created_by_name, b.approved_by_name, b.closed_by_name, b.close_note, xDateTime(b.created_at),
      ]),
    }]);
  }

  function render() {
    if (!rows.length) return html`<div class="card">${empty('room', 'Sin reservas en este período', 'Elige otras fechas.')}</div>`;
    const approved = rows.filter((b) => b.status === 'approved');
    const hours = approved.reduce((s, b) => s + hoursOf(b), 0);
    const capacity = schoolHours(range());
    const hoursFmt = (h) => `${round1(h)} h`;
    const byPerson = new Map();
    for (const b of approved) byPerson.set(b.created_by_name, (byPerson.get(b.created_by_name) || 0) + hoursOf(b));
    return html`
      <div class="stats">
        ${tile(approved.length, 'Reservas aprobadas')}
        ${tile(hoursFmt(hours), 'Horas reservadas')}
        ${tile(capacity ? `${Math.round((hours / capacity) * 100)} %` : '—', 'Del horario de clases')}
        ${tile(rows.filter((b) => b.status === 'rejected').length, 'No aprobadas')}
      </div>
      <section class="card stack">
        <h2 class="card-title">${icon('download')} Descargar</h2>
        <p class="muted">Un Excel con cada reserva del período: día, horas, para qué, estado y quién la pidió y la aprobó.</p>
        <button type="button" class="btn btn-secondary btn-block" data-export>${icon('download', 18)} Descargar Excel</button>
      </section>
      ${bars('Horas por persona', 'users', [...byPerson].map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es')).slice(0, 10), { format: hoursFmt })}
      ${bars('Horas por día de la semana', 'calendar', byWeekday(approved, (b) => b.day, hoursOf), { format: hoursFmt })}
      ${bars('Estado de las reservas', 'list', countBy(rows, statusOf))}
      <p class="hint">«Del horario de clases»: horas aprobadas entre las horas de clase del período (días de clases, sin los días sin clases).</p>`;
  }

  async function load() {
    const r = range();
    await fill(body, isCurrent, async () => {
      [rows, closures] = await Promise.all([bookingsBetween(r.from, r.to), listClosures({ from: r.from }).catch(() => [])]);
      return render();
    });
    $('[data-export]', body)?.addEventListener('click', (e) => busy(e.currentTarget, async () => exportExcel()));
  }

  await load();
}

// ---- En vivo ---------------------------------------------------------------------------------

const TURN_STATUS = {
  waiting: () => 'En fila',
  called: () => 'Lo llamaron',
  sent: (s) => `Va a ${s.name}`,
  arrived: (s) => `En ${s.name}`,
  on_the_way: (s) => `${s.name} va al salón`,
  returning: () => 'Regresa al salón',
};
const PICKUP_STATUS = { scheduled: 'Por llegar el encargado', arrived: 'Llegó el encargado', on_the_way: 'Seguridad va al salón' };
const who = (name, group) => html`${name || 'Estudiante'} <span class="nowrap">(${group})</span>`;

function liveTurn(t, service) {
  const support = service.mode === 'support';
  const status = t.late ? 'No ha llegado' : support && t.status === 'on_the_way' ? `${service.name} va en camino` : TURN_STATUS[t.status]?.(service) || t.status;
  const sev = SEVERITY[t.level] || SEVERITY[1];
  return html`<div class="item ${t.late ? 'alert-item is-urgent' : ''}">
    <span class="item-icon ${t.late ? 'is-danger' : t.status === 'waiting' ? '' : 'is-ok'}">${icon(support ? 'wrench' : 'pulse')}</span>
    <span class="item-main">
      <strong>${support ? html`${t.created_by_name}${t.room ? html` <span class="nowrap">(${t.room})</span>` : ''}` : who(t.student, t.group)}</strong>
      ${t.reason ? html`<span class="item-sub" data-reason>${t.reason}</span>` : ''}
      <span class="item-sub">${[status, t.handled_by_name && t.status !== 'waiting' ? t.handled_by_name : null, timeAgo(t.since)].filter(Boolean).join(' · ')}</span>
    </span>
    <span class="tag ${sev.cls}">${sev.label}</span>
  </div>`;
}

/** Who attends a service and how they are now (Disponible, En reunión hasta…). */
const staffTags = (s) => html`<div class="chips">${s.staff.length
  ? s.staff.map((p) => html`<span class="tag ${p.status === 'available' ? 'tag-ok' : 'tag-warn'}">${p.name} · ${STAFF_STATUS[p.status] || p.status}${p.until ? ` hasta ${fmtTime(new Date(p.until))}` : ''}</span>`)
  : html`<span class="muted">Nadie tiene un rol que atienda este servicio.</span>`}</div>`;

/** The services, to open one's turns of today; the one open is marked. */
const serviceChips = (services, current = null) => html`<div class="quick live-services" data-live-services>${services.map(
  (x) => html`<a class="chip-btn ${x.id === current ? 'active' : ''}" href="#/live/service/${x.id}">${x.name}</a>`,
)}</div>`;

/** filtered: only a grade's or group's turns show (the day's numbers are the whole service's); link: to its day. */
function liveService(s, { filtered = false, link = true } = {}) {
  // Late first, then whoever is out of the room, then the queue by level.
  const rank = (t) => (t.late ? 0 : t.status === 'waiting' ? 2 : 1);
  const active = [...s.active].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.level - a.level : 0));
  const waiting = s.active.filter((t) => t.status === 'waiting').length;
  const d = s.today;
  const summary = [
    `${d.requested} ${d.requested === 1 ? 'pedido' : 'pedidos'}`,
    `${d.done} ${d.done === 1 ? 'terminado' : 'terminados'}`,
    s.mode === 'visit' && d.picked_up ? `${d.picked_up} ${d.picked_up === 1 ? 'recogido' : 'recogidos'}` : null,
    d.referred ? (s.mode === 'support' ? `${d.referred} con seguimiento` : `${d.referred} referido${d.referred === 1 ? '' : 's'}`) : null,
    d.late ? `${d.late} no ${d.late === 1 ? 'llegó' : 'llegaron'} a tiempo` : null,
  ].filter(Boolean).join(' · ');
  return html`<section class="card stack live-service" data-live-service="${s.id}">
    <div class="card-head">
      <h2 class="card-title">${icon(s.mode === 'support' ? 'wrench' : 'pulse')} ${s.name}</h2>
      <span class="count ${waiting ? 'warn' : ''}">${waiting} en fila</span>
    </div>
    ${staffTags(s)}
    ${active.length ? html`<div class="list flat">${active.map((t) => liveTurn(t, s))}</div>` : html`<p class="muted">Nadie en fila ni en atención.</p>`}
    <p class="hint">${filtered && s.mode !== 'support' ? 'Hoy, en todo el servicio' : 'Hoy'}: ${summary}.</p>
    ${link ? html`<a class="btn btn-secondary btn-block" href="#/live/service/${s.id}">${icon('list', 18)} Ver todos los turnos de hoy</a>` : ''}
  </section>`;
}

function liveSection(title, items, renderItem, { danger = false, note = '' } = {}) {
  if (!items.length && !note) return '';
  return html`<section class="section">
    <h3 class="section-title">${title} <span class="count ${danger && items.length ? 'danger' : ''}">${items.length}</span></h3>
    ${items.length ? html`<div class="list">${items.map(renderItem)}</div>` : ''}
    ${note ? html`<p class="hint pad">${note}</p>` : ''}
  </section>`;
}

const alertItem = (a) => html`<a class="item alert-item is-urgent" href="#/alerts/missing/${a.id}">
    <span class="item-icon is-danger">${icon('alert')}</span>
    <span class="item-main"><strong>${who(a.student, a.group)}</strong>
      <span class="item-sub">${[a.place ? `venía de ${a.place}` : null, `avisó ${a.created_by_name}`, timeAgo(a.created_at)].filter(Boolean).join(' · ')}</span></span>
  </a>`;
const pickupItem = (k) => html`<a class="item" href="#/alerts/pickup/${k.id}">
    <span class="item-icon">${icon('user')}</span>
    <span class="item-main"><strong>${who(k.student, k.group)}</strong>
      <span class="item-sub">${[PICKUP_STATUS[k.status], k.expected_time ? `hacia las ${fmtTime(k.expected_time)}` : null].filter(Boolean).join(' · ')}</span></span>
  </a>`;
const reliefItem = (x) => html`<a class="item" href="#/alerts/relief/${x.id}">
    <span class="item-icon is-danger">${icon('users')}</span>
    <span class="item-main"><strong>${x.name}</strong>
      <span class="item-sub">${[x.room ? `Salón ${x.room}` : null, timeAgo(x.created_at)].filter(Boolean).join(' · ')}</span></span>
  </a>`;

// ---- En vivo › a grade or group, the sound and «Fuera del salón ahora» -------------------------

const FILTER_KEY = 'lah:live-filter';
const SOUND_KEY = 'lah:live-sound';
/** Minutes an urgent turn waits in line before the board rings. */
const URGENT_WAIT_MIN = 5;
/** A student out of their room: on the way to the service, in it, or going back. */
const OUT = ['sent', 'arrived', 'returning'];

/** This device's choices. A private window may not keep them: then they last while the app is open. */
const memory = new Map();
function stored(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key, value) {
  memory.set(key, value || null);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* only for now */
  }
}

/** "9" from "9-B", "Pre-K" from "Pre-K-A"; a group without a dash is a grade of its own. */
const gradeOf = (g) => (g.includes('-') ? g.slice(0, g.lastIndexOf('-')) : g);
/** "9.º grado", "Kínder", "Pre-kínder". */
const gradeName = (g) => (/^\d+$/.test(g) ? `${g}.º grado` : { K: 'Kínder', 'Pre-K': 'Pre-kínder' }[g] || g);

/** The grade ("grade:9") or group ("group:9-B") chosen on this device, if the school still has it; '' is everyone. */
function liveFilter() {
  const value = stored(FILTER_KEY) || '';
  const { groups } = schoolCalendar(state.me.school);
  const name = value.slice(6);
  if (value.startsWith('group:') && groups.includes(name)) return value;
  if (value.startsWith('grade:') && groups.some((g) => gradeOf(g) === name)) return value;
  return '';
}
const filterLabel = (f) => (f.startsWith('grade:') ? gradeName(f.slice(6)) : f.slice(6));
/** Whether a student of that group is in the grade or group chosen. */
const inFilter = (f, group) =>
  !f || (!!group && (f.startsWith('grade:') ? gradeOf(group) === f.slice(6) : group === f.slice(6)));

/**
 * The board for a grade or group: its students' turns, «No ha llegado» and pickups. Soporte IT, relief requests,
 * maintenance and the conference room are the whole school's.
 */
function forFilter(b, f) {
  const mine = (x) => inFilter(f, x.group);
  const services = b.services.map((s) => (s.mode === 'support' ? s : { ...s, active: s.active.filter(mine) }));
  return { ...b, services, alerts: b.alerts.filter(mine), pickups: b.pickups.filter(mine), active: services.flatMap((s) => s.active) };
}

/** «Toda la escuela», then each grade («Todo 9.º grado») with its groups; a grade of one group is just the group. */
function filterField(f) {
  const { groups } = schoolCalendar(state.me.school);
  if (!groups.length) return '';
  const option = (value, label) => html`<option value="${value}" ${value === f ? 'selected' : ''}>${label}</option>`;
  return html`<label class="field"><span>Grado o grupo</span>
    <select data-live-filter>
      ${option('', 'Toda la escuela')}
      ${[...new Set(groups.map(gradeOf))].map((g) => {
        const list = groups.filter((x) => gradeOf(x) === g);
        return list.length === 1
          ? option(`group:${list[0]}`, list[0])
          : html`<optgroup label="${gradeName(g)}">${option(`grade:${g}`, `Todo ${gradeName(g)}`)}${list.map((x) => option(`group:${x}`, x))}</optgroup>`;
      })}
    </select></label>`;
}

/** What already rang on this device while the app is open: each thing rings once. */
const heard = new Set();
const soundOn = () => stored(SOUND_KEY) === '1';

/** What rings: a student who didn't arrive, and an urgent turn waiting in line for 5 minutes or more. */
function alarmKeys(v) {
  const now = Date.now();
  return [
    ...v.alerts.map((a) => `alert-${a.id}`),
    ...v.active.flatMap((t) => {
      if (t.late) return [`late-${t.id}`];
      const waited = (now - new Date(t.since)) / 60000;
      return t.status === 'waiting' && t.level >= 4 && waited >= URGENT_WAIT_MIN ? [`urgent-${t.id}`] : [];
    }),
  ];
}

/** Rings once when something new needs looking at, if the sound is on here and can play. */
function ringFor(keys) {
  if (!soundOn() || !soundReady()) return;
  const fresh = keys.filter((k) => !heard.has(k));
  if (!fresh.length) return;
  for (const k of fresh) heard.add(k);
  ringOnce();
}

function soundButton() {
  const on = soundOn();
  return html`<button type="button" class="chip-btn ${on ? 'active' : ''}" data-live-sound aria-pressed="${on}">${icon('bell', 16)} Sonido ${on ? 'encendido' : 'apagado'}</button>`;
}

function soundHint() {
  if (!soundOn()) return '';
  return soundReady()
    ? html`<p class="hint" data-sound-hint>Suena cuando un estudiante no llega o un turno urgente lleva ${URGENT_WAIT_MIN} minutos en fila. Solo en este dispositivo, mientras En vivo está abierto.</p>`
    : html`<p class="hint" data-sound-hint>El teléfono no deja sonar hasta que tocas la pantalla. <button type="button" class="link-btn" data-sound-unlock>Activar el sonido</button></p>`;
}

/** The grade or group and the sound, after each render; rerender shows the change. keysNow: what would ring now. */
function bindTools(root, rerender, keysNow) {
  $('[data-live-filter]', root)?.addEventListener('change', (e) => {
    store(FILTER_KEY, e.target.value);
    rerender();
  });
  $('[data-live-sound]', root)?.addEventListener('click', () => {
    const on = !soundOn();
    store(SOUND_KEY, on ? '1' : '');
    if (on) {
      // It rings now, so the person hears how it sounds; what is already on the board counts as heard.
      for (const k of keysNow()) heard.add(k);
      ringOnce();
    }
    rerender();
  });
  $('[data-sound-unlock]', root)?.addEventListener('click', () => {
    for (const k of keysNow()) heard.add(k);
    ringOnce();
    setTimeout(rerender, 300);
  });
}

/**
 * The students out of their room now, by group in the school's order: whoever didn't arrive first, then whoever
 * has been out the longest. The «No ha llegado» alerts count as out.
 */
function outNow(v) {
  const list = [
    ...v.alerts.map((a) => ({
      key: `alert-${a.id}`, student: a.student, group: a.group, late: true, since: a.created_at,
      where: a.place ? `No ha llegado · venía de ${a.place}` : 'No ha llegado', link: `#/alerts/missing/${a.id}`,
    })),
    ...v.services.filter((s) => s.mode !== 'support').flatMap((s) => s.active.filter((t) => OUT.includes(t.status)).map((t) => ({
      key: `turn-${t.id}`, student: t.student, group: t.group, late: t.late, since: t.out_since || t.since,
      where: t.late ? `No ha llegado a ${s.name}` : TURN_STATUS[t.status](s), link: null,
    }))),
  ];
  const order = schoolCalendar(state.me.school).groups;
  const rank = (g) => (order.includes(g) ? order.indexOf(g) : order.length);
  const groups = [...new Set(list.map((x) => x.group || ''))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'es'));
  return groups.map((g) => ({
    group: g,
    students: list.filter((x) => (x.group || '') === g).sort((a, b) => b.late - a.late || String(a.since).localeCompare(String(b.since))),
  }));
}

function outItem(x) {
  const minutes = minutesText(minutesBetween(x.since, new Date().toISOString()));
  const inner = html`<span class="item-icon ${x.late ? 'is-danger' : 'is-ok'}">${icon(x.late ? 'alert' : 'door')}</span>
    <span class="item-main"><strong>${x.student || 'Estudiante'}</strong>
      <span class="item-sub">${[x.where, minutes ? `${minutes} fuera del salón` : null].filter(Boolean).join(' · ')}</span></span>`;
  const cls = `item ${x.late ? 'alert-item is-urgent' : ''}`;
  return x.link
    ? html`<a class="${cls}" href="${x.link}" data-out="${x.key}">${inner}</a>`
    : html`<div class="${cls}" data-out="${x.key}">${inner}</div>`;
}

/** «Fuera del salón ahora», by group. */
function outSection(out) {
  const count = out.reduce((n, g) => n + g.students.length, 0);
  if (!count) return '';
  const late = out.some((g) => g.students.some((x) => x.late));
  return html`<section class="section" data-out-now>
    <h3 class="section-title">Fuera del salón ahora <span class="count ${late ? 'danger' : 'warn'}">${count}</span></h3>
    <div class="out-groups">${out.map((g) => html`<div class="out-group" data-out-group="${g.group}">
      <h4 class="out-group-title">${g.group || 'Sin grupo'} <span>${g.students.length}</span></h4>
      <div class="list">${g.students.map(outItem)}</div>
    </div>`)}</div>
  </section>`;
}

// ---- En vivo › one service: today's turns, now and attended ----------------------------------

const LIVE_OPEN = ['waiting', 'called', 'sent', 'arrived', 'on_the_way', 'returning'];
const isLiveOpen = (t) => LIVE_OPEN.includes(t.status);
/** "8:05 a. m." */
const at = (ts) => fmtTime(new Date(ts));
/** "6 min", "1 h 10 min", "menos de 1 min" */
function minutesText(m) {
  if (m === null || m < 0) return null;
  if (m < 1) return 'menos de 1 min';
  const n = Math.round(m);
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}`;
}
/** How it ended: «Regresó al salón», «Resuelto», «Cancelado»… */
const endText = (t, s) =>
  t.status === 'cancelled' ? 'Cancelado' : (s.mode === 'support' ? SUPPORT_OUTCOMES[t.outcome] : null) || OUTCOMES[t.outcome] || 'Terminado';
/** Minutes waiting (until it was called or someone went) and being attended (until it ended). */
function turnMinutes(t) {
  const start = t.called_at || t.on_the_way_at || t.arrived_at;
  return {
    wait: minutesBetween(t.created_at, start),
    care: t.status === 'done' ? minutesBetween(t.arrived_at || t.on_the_way_at || t.called_at, t.closed_at) : null,
  };
}

/** Every step of a turn with its time: "Pedido 8:02 · Lo llamaron 8:05 · Llegó a Enfermería 8:09 · …". */
function turnSteps(t, s) {
  return [
    ['Pedido', t.created_at],
    ['Lo llamaron', t.called_at],
    ['Salió del salón', t.sent_at],
    [s.mode === 'support' ? 'Va en camino' : 'Va al salón', t.on_the_way_at],
    [`Llegó a ${s.name}`, t.arrived_at],
    ['Regresa al salón', t.returning_at],
    [isLiveOpen(t) ? null : endText(t, s), t.closed_at],
  ]
    .filter(([label, ts]) => label && ts)
    .map(([label, ts]) => `${label} ${at(ts)}`)
    .join(' · ');
}

/** A turn of the day with everything about it (never the teacher's note). */
function dayTurn(t, s) {
  const support = s.mode === 'support';
  const open = isLiveOpen(t);
  const missing = open && t.late_at && !t.arrived_at;
  const sev = SEVERITY[t.level] || SEVERITY[1];
  const { wait, care } = turnMinutes(t);
  const status = missing
    ? 'No ha llegado'
    : open
      ? support && t.status === 'on_the_way' ? `${s.name} va en camino` : TURN_STATUS[t.status]?.(s) || t.status
      : endText(t, s);
  const statusCls = missing ? 'tag-danger' : open ? (t.status === 'waiting' ? 'tag-warn' : 'tag-info') : t.status === 'cancelled' ? '' : 'tag-ok';
  const place = t.room ? (/^\d/.test(t.room) ? `Salón ${t.room}` : t.room) : null;
  const people = [
    `Pidió ${t.created_by_name}`,
    !support && t.teacher_name && t.teacher_name !== t.created_by_name ? `lo tiene ${t.teacher_name}` : null,
    t.handled_by_name ? `${open ? 'atiende' : 'atendió'} ${t.handled_by_name}` : null,
    t.status === 'cancelled' && t.closed_by_name ? `lo canceló ${t.closed_by_name}` : null,
  ].filter(Boolean).join(' · ');
  const times = open
    ? t.status === 'waiting' ? `En fila hace ${minutesText(minutesBetween(t.created_at, new Date().toISOString()))}` : null
    : [wait !== null ? `Esperó ${minutesText(wait)}` : null, care !== null ? `atención ${minutesText(care)}` : null].filter(Boolean).join(' · ');
  const flags = [
    t.late_at && t.arrived_at ? `Tardó en llegar a ${s.name}` : null,
    t.return_late_at ? 'Tardó en regresar al salón' : null,
    t.out_of_order ? 'Se atendió antes de su turno' : null,
  ].filter(Boolean);
  return html`<div class="item day-turn ${missing ? 'alert-item is-urgent' : ''}" data-turn="${t.id}">
    <span class="item-icon ${missing ? 'is-danger' : open && t.status !== 'waiting' ? 'is-ok' : ''}">${icon(support ? 'wrench' : 'pulse')}</span>
    <span class="item-main">
      <strong>${support ? html`${t.reason || 'Pedido de ayuda'}${place ? html` <span class="nowrap">(${place})</span>` : ''}` : who(t.student_name, t.group_name)}</strong>
      <span class="item-sub" data-reason>${[support ? null : t.reason, sev.label].filter(Boolean).join(' · ')}</span>
      <span class="item-sub" data-people>${people}</span>
      <span class="item-sub" data-steps>${turnSteps(t, s)}</span>
      ${times ? html`<span class="item-sub" data-times>${times}</span>` : ''}
      ${flags.length ? html`<span class="item-sub" data-flags>${icon('alert', 13)} ${flags.join(' · ')}</span>` : ''}
      ${support && t.resolution ? html`<span class="item-sub">Qué se hizo: «${t.resolution}»</span>` : ''}
    </span>
    <span class="tag ${statusCls}">${status}</span>
  </div>`;
}

/**
 * «Horas pico»: today's turns by hour (of the grade or group chosen), or an average day of the 4 weeks before today
 * (the whole service; it doesn't know groups). history: null when it couldn't be read.
 */
function peakCard(today, history, which, f) {
  const weeks = which === 'weeks' && !!history;
  const counts = weeks ? new Map(history.hours.map((h) => [h.hour, h.turns / history.days])) : countByHour(today);
  const rows = hourRows(counts).map((r) => ({ ...r, value: round1(r.value) }));
  const top = rows.reduce((a, r) => (r.value > a.value ? r : a), rows[0]);
  const any = !!top?.value;
  let note;
  if (weeks) {
    note = history.days
      ? `Un día promedio de las 4 semanas antes de hoy (${history.days} ${history.days === 1 ? 'día' : 'días'} con pedidos). La hora más llena: ${top.label}, con ${top.value} por día.${f ? ' Cuenta todos los grupos.' : ''}`
      : 'No hubo pedidos en las 4 semanas antes de hoy.';
  } else {
    note = any ? `La hora con más pedidos hoy: ${top.label} (${top.value}).` : 'Todavía no hay pedidos hoy.';
  }
  return html`<section class="card stack" data-peak>
    <h2 class="card-title">${icon('clock')} Horas pico</h2>
    ${history ? html`<div class="quick">
      <button type="button" class="chip-btn ${weeks ? '' : 'active'}" data-peak-show="today">Hoy</button>
      <button type="button" class="chip-btn ${weeks ? 'active' : ''}" data-peak-show="weeks">Últimas 4 semanas</button>
    </div>` : ''}
    ${any ? barRows(rows) : ''}
    <p class="hint" data-peak-note>${note}</p>
  </section>`;
}

/** En vivo › Enfermería: the day of one service — who is in line or being attended now, and everyone attended today. */
export async function liveServiceView(ctx) {
  const { el, params, isCurrent, setTitle } = ctx;
  const id = Number(params[0]);
  let board = null;
  let all = [];
  // The 4 weeks before today, asked once.
  let history;
  let peak = 'today';

  function render() {
    const s = board.services.find((x) => x.id === id);
    if (!s) {
      el.innerHTML = String(html`<div class="card">${empty('pulse', 'Ese servicio no está activo', 'Vuelve a En vivo para ver los demás.')}</div>`);
      return;
    }
    setTitle(`En vivo · ${s.name}`);
    // Soporte IT helps the staff, not students: no grade or group.
    const support = s.mode === 'support';
    const f = support ? '' : liveFilter();
    const turns = all.filter((t) => inFilter(f, t.group_name));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = turns.filter((t) => new Date(t.created_at) >= start);
    // Late first, then whoever is out of the room, then the line by level.
    const rank = (t) => (t.late_at && !t.arrived_at ? 0 : t.status === 'waiting' ? 2 : 1);
    const now = turns.filter(isLiveOpen).sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.level - a.level : 0));
    const done = turns.filter((t) => !isLiveOpen(t)).sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
    const finished = done.filter((t) => t.status === 'done');
    const avgWait = average(today.map((t) => turnMinutes(t).wait));
    const avgCare = average(finished.map((t) => turnMinutes(t).care));
    const rings = () => alarmKeys(forFilter(board, liveFilter()));
    el.innerHTML = String(html`<div class="stack">
      ${serviceChips(board.services, id)}
      <p class="hint live-stamp">${icon('refresh', 14)} Se actualiza solo. Última vez: ${fmtTime(new Date())}</p>
      <div class="stack-sm" data-live-tools>
        ${support ? '' : filterField(f)}
        <div class="quick">${soundButton()}</div>
        ${soundHint()}
      </div>
      ${f ? html`<p class="hint" data-filter-note>Solo los turnos de ${filterLabel(f)}.</p>` : ''}
      <div class="stats">
        ${tile(today.length, 'Pedidos hoy')}
        ${tile(now.filter((t) => t.status === 'waiting').length, 'En fila')}
        ${tile(now.filter((t) => t.status !== 'waiting').length, 'En atención o en camino')}
        ${tile(finished.length, 'Atendidos')}
        ${tile(avgWait === null ? '—' : minutesText(avgWait), 'Espera promedio')}
        ${tile(avgCare === null ? '—' : minutesText(avgCare), 'Atención promedio')}
      </div>
      ${staffTags(s)}
      <section class="section" data-now>
        <h3 class="section-title">Ahora <span class="count ${now.length ? 'warn' : ''}">${now.length}</span></h3>
        ${now.length ? html`<div class="list">${now.map((t) => dayTurn(t, s))}</div>` : html`<p class="muted pad">Nadie en fila ni en atención.</p>`}
      </section>
      <section class="section" data-done>
        <h3 class="section-title">Atendidos hoy <span class="count">${done.length}</span></h3>
        ${done.length ? html`<div class="list">${done.map((t) => dayTurn(t, s))}</div>` : html`<p class="muted pad">Todavía no se ha atendido a nadie hoy.</p>`}
      </section>
      ${peakCard(today, history, peak, f)}
      <p class="hint">Cada turno dice su motivo, quién lo pidió, quién lo atendió y la hora de cada paso. Las notas de los maestros no salen aquí: solo las ve el servicio.</p>
      <a class="btn btn-ghost btn-block" href="#/live">${icon('back', 18)} Todo En vivo</a>
    </div>`);
    sizeBars(el);
    bindTools(el, render, rings);
    for (const b of el.querySelectorAll('[data-peak-show]')) {
      b.addEventListener('click', () => {
        peak = b.dataset.peakShow;
        render();
      });
    }
    ringFor(rings());
  }

  async function load() {
    const [b, turns, hours] = await Promise.all([
      liveBoard(),
      liveTurns(id),
      history === undefined ? liveHours(id).catch(() => null) : history,
    ]);
    if (!isCurrent()) return;
    [board, all, history] = [b, turns, hours || null];
    render();
  }

  await load();
  keepFresh(ctx, load);
}

export async function liveView(ctx) {
  const { el, isCurrent } = ctx;
  let board = null;

  function render() {
    const f = liveFilter();
    const b = forFilter(board, f);
    const { active } = b;
    const late = active.filter((t) => t.late).length + b.alerts.length;
    const quiet = !active.length && !b.alerts.length && !b.pickups.length && !b.relief.length && !b.maintenance.length && !b.rooms.length;
    el.innerHTML = String(html`<div class="stack">
      <p class="hint live-stamp">${icon('refresh', 14)} Se actualiza solo. Última vez: ${fmtTime(new Date())}</p>
      <div class="stack-sm" data-live-tools>
        ${filterField(f)}
        <div class="quick">${soundButton()}<a class="chip-btn" href="#/live/tv" data-live-tv>${icon('live', 16)} Pantalla grande</a></div>
        ${soundHint()}
      </div>
      ${f ? html`<p class="hint" data-filter-note>Solo ${filterLabel(f)}: sus turnos, «No ha llegado», las salidas y quién está fuera del salón. Soporte IT, los relevos, el mantenimiento y el salón de conferencias son de toda la escuela.</p>` : ''}
      <div class="stats">
        ${tile(active.filter((t) => t.status === 'waiting').length, 'En fila')}
        ${tile(active.filter((t) => t.status !== 'waiting').length, 'En atención o en camino')}
        ${tile(late, 'No han llegado', late ? 'stat-danger' : '')}
        ${tile(b.maintenance.length, 'Mantenimiento abierto', b.maintenance.some((m) => m.urgency === 3) ? 'stat-warn' : '')}
      </div>
      ${b.services.length ? html`<div class="stack-sm"><p class="muted">Los turnos de hoy de un servicio, uno por uno:</p>${serviceChips(b.services)}</div>` : ''}
      ${quiet ? html`<div class="card">${empty('check', 'Todo tranquilo', 'No hay movimiento en este momento.')}</div>` : ''}
      ${liveSection('No ha llegado', b.alerts, alertItem, { danger: true })}
      ${outSection(outNow(b))}
      ${b.services.map((s) => liveService(s, { filtered: !!f }))}
      ${liveSection('Salidas de hoy', b.pickups, pickupItem, { note: !f && b.pickups_done ? `${b.pickups_done} ya ${b.pickups_done === 1 ? 'se entregó' : 'se entregaron'} hoy.` : '' })}
      ${liveSection('Piden relevo', b.relief, reliefItem, { danger: true })}
      ${liveSection('Mantenimiento', b.maintenance, (m) => html`<a class="item ${m.urgency === 3 ? 'alert-item is-urgent' : ''}" href="#/maintenance/${m.id}">
          <span class="item-icon ${m.urgency === 3 ? 'is-danger' : ''}">${icon((KINDS[m.kind] || KINDS.other).icon)}</span>
          <span class="item-main"><strong>${(KINDS[m.kind] || KINDS.other).label} · ${m.place}</strong>
            <span class="item-sub">${[m.status === 'on_the_way' ? `Va ${m.taken_by_name}` : 'Pendiente', timeAgo(m.created_at)].join(' · ')}</span></span>
          <span class="tag ${URGENCY[m.urgency]?.cls || ''}">${URGENCY[m.urgency]?.label}</span>
        </a>`, { note: b.maintenance_done ? `${b.maintenance_done} ${b.maintenance_done === 1 ? 'resuelta' : 'resueltas'} hoy.` : '' })}
      ${liveSection('Salón de conferencias hoy', b.rooms, (r) => html`<a class="item" href="#/rooms/${r.id}">
          <span class="item-icon">${icon('room')}</span>
          <span class="item-main"><strong>${r.purpose}</strong>
            <span class="item-sub">${fmtTime(r.start_time)} – ${fmtTime(r.end_time)} · ${r.created_by_name}</span></span>
        </a>`, { note: b.rooms_pending ? `${b.rooms_pending} ${b.rooms_pending === 1 ? 'reserva espera' : 'reservas esperan'} aprobación.` : '' })}
      <p class="hint">Cada turno dice su motivo. Las notas de los maestros no salen aquí: solo las ve el servicio.</p>
    </div>`);
    bindTools(el, render, () => alarmKeys(b));
    ringFor(alarmKeys(b));
  }

  async function load() {
    const b = await liveBoard();
    if (!isCurrent()) return;
    board = b;
    render();
  }

  await load();
  keepFresh(ctx, load);
}

// ---- En vivo › pantalla grande ----------------------------------------------------------------

const TV_PAGE_SECONDS = 15;

/** The first page of the big screen: who is out of their room, by group; relief requests and today's pickups. */
function tvSummary(v, out) {
  const quiet = !out.length && !v.relief.length && !v.pickups.length;
  return html`<div class="stack">
    ${quiet ? html`<div class="card">${empty('check', 'Todo tranquilo', 'Nadie está fuera del salón ahora.')}</div>` : ''}
    ${outSection(out)}
    ${liveSection('Piden relevo', v.relief, reliefItem, { danger: true })}
    ${liveSection('Salidas de hoy', v.pickups, pickupItem)}
  </div>`;
}

/**
 * En vivo for a TV in the office: big letters, without the app's bars. The summary, then each service, one after
 * the other by itself (it can be paused or a page chosen). The screen stays on while it's open.
 */
export async function liveTvView(ctx) {
  const { el, isCurrent, onLeave } = ctx;
  let board = null;
  let loadedAt = new Date();
  let page = 0;
  let paused = false;
  let lock = null;

  const stayAwake = async () => {
    try {
      lock = (await navigator.wakeLock?.request('screen')) || null;
    } catch {
      lock = null;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') stayAwake();
  };
  const turnPage = setInterval(() => {
    if (board && !paused && isCurrent()) {
      page += 1;
      render();
    }
  }, TV_PAGE_SECONDS * 1000);
  const clock = setInterval(() => {
    const c = $('[data-tv-clock]', el);
    if (c) c.textContent = fmtTime(new Date());
  }, 10000);
  document.body.classList.add('tv-mode');
  document.addEventListener('visibilitychange', onVisible);
  stayAwake();
  onLeave(() => {
    clearInterval(turnPage);
    clearInterval(clock);
    document.body.classList.remove('tv-mode');
    document.removeEventListener('visibilitychange', onVisible);
    if (lock) lock.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });

  function render() {
    const f = liveFilter();
    const v = forFilter(board, f);
    const pages = [{ label: 'Resumen', key: 'summary' }, ...v.services.map((s) => ({ label: s.name, key: String(s.id), service: s }))];
    page %= pages.length;
    const current = pages[page];
    const out = outNow(v);
    const outCount = out.reduce((n, g) => n + g.students.length, 0);
    const late = v.active.filter((t) => t.late).length + v.alerts.length;
    el.innerHTML = String(html`<div class="tv" data-tv>
      <header class="tv-head">
        <img src="${appIcon()}" alt="" width="56" height="56">
        <div class="tv-title"><strong>En vivo</strong><small>${state.me.school.name}${f ? ` · Solo ${filterLabel(f)}` : ''}</small></div>
        <span class="tv-clock" data-tv-clock>${fmtTime(new Date())}</span>
      </header>
      <div class="stats">
        ${tile(v.active.filter((t) => t.status === 'waiting').length, 'En fila')}
        ${tile(v.active.filter((t) => t.status !== 'waiting').length, 'En atención o en camino')}
        ${tile(outCount, 'Fuera del salón')}
        ${tile(late, 'No han llegado', late ? 'stat-danger' : '')}
      </div>
      <div class="quick" data-tv-pages>${pages.map(
        (p, i) => html`<button type="button" class="chip-btn ${i === page ? 'active' : ''}" data-tv-go="${i}" aria-pressed="${i === page}">${p.label}</button>`,
      )}</div>
      <div class="tv-page" data-tv-page="${current.key}">
        ${current.service ? liveService(current.service, { filtered: !!f, link: false }) : tvSummary(v, out)}
      </div>
      <footer class="tv-foot">
        <p class="hint" data-tv-stamp>${paused ? 'En pausa.' : `Cambia cada ${TV_PAGE_SECONDS} segundos.`} Se actualiza solo. Última vez: ${fmtTime(loadedAt)}</p>
        <div class="quick">
          ${soundButton()}
          <button type="button" class="chip-btn" data-tv-pause aria-pressed="${paused}">${paused ? 'Seguir' : 'Pausar'}</button>
          ${document.fullscreenEnabled ? html`<button type="button" class="chip-btn" data-tv-full>${document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'}</button>` : ''}
          <a class="chip-btn" href="#/live" data-tv-exit>Salir</a>
        </div>
        ${soundHint()}
      </footer>
    </div>`);
    bindTools(el, render, () => alarmKeys(v));
    for (const b of el.querySelectorAll('[data-tv-go]')) {
      b.addEventListener('click', () => {
        page = Number(b.dataset.tvGo);
        render();
      });
    }
    $('[data-tv-pause]', el)?.addEventListener('click', () => {
      paused = !paused;
      render();
    });
    $('[data-tv-full]', el)?.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        /* the browser said no */
      }
      render();
    });
    ringFor(alarmKeys(v));
  }

  async function load() {
    const b = await liveBoard();
    if (!isCurrent()) return;
    board = b;
    loadedAt = new Date();
    render();
  }

  await load();
  keepFresh(ctx, load);
}
