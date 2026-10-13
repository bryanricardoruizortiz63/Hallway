// Salón de conferencias: anyone reserves it by hours on a school day; Secretaría and the dirección (permission
// "calendar") approve. Their own reservations are approved at once and can replace someone else's (the app
// asks first). Days marked in the school calendar can't be reserved.
import {
  addBookingNote,
  bookingHistory,
  bookingNotes,
  cancelBooking,
  createBooking,
  decideBooking,
  getBooking,
  listBookings,
  listClosures,
  markAlertsRead,
  myBookings,
  pendingBookings,
} from '../backend.js';
import {
  $,
  WEEKDAYS,
  addDays,
  busy,
  can,
  dayLabel,
  daysText,
  dialog,
  fmtDate,
  fmtDateTime,
  fmtLongDate,
  fmtTime,
  html,
  isoWeekday,
  roleLabel,
  schoolCalendar,
  timeAgo,
  toast,
  todayStr,
} from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { empty } from './common.js';
import { fact, keepFresh } from './students.js';

/** Secretaría and the dirección: they approve, and their reservations come first. */
export const approvesBookings = (u) => can(u, 'rooms');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => String(t || '').slice(0, 5);
const toMin = (t) => {
  const [h, m] = hm(t).split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const timeRange = (b) => `${fmtTime(b.start_time)} – ${fmtTime(b.end_time)}`;
const overlaps = (b, start, end) => toMin(b.start_time) < toMin(end) && toMin(b.end_time) > toMin(start);
const isActive = (b) => b.status === 'pending' || b.status === 'approved';
/** Already over, by the phone's clock. */
const isPast = (b) => b.day < todayStr() || (b.day === todayStr() && toMin(b.end_time) <= nowMin());
const weekStart = (day) => addDays(day, 1 - isoWeekday(day));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const longDay = (day) => cap(fmtLongDate(day));

function statusTag(b) {
  if (b.status === 'pending') return isPast(b) ? { label: 'Sin respuesta', cls: '' } : { label: 'Esperando aprobación', cls: 'tag-warn' };
  if (b.status === 'approved') return { label: 'Aprobada', cls: 'tag-ok' };
  if (b.status === 'rejected') return { label: 'No aprobada', cls: 'tag-danger' };
  if (b.status === 'replaced') return { label: 'Reemplazada', cls: 'tag-danger' };
  return { label: 'Cancelada', cls: '' };
}

/** Why a day can't be reserved: not a school day, or a day without classes. */
function dayProblem(day, closures, cal) {
  if (!cal.school_days.includes(isoWeekday(day))) return 'Ese día no hay clases.';
  const c = closures.find((x) => x.start_date <= day && x.end_date >= day);
  if (c) return `${c.name} (${c.kind === 'holiday' ? 'feriado' : 'sin estudiantes'}): ese día no se puede reservar.`;
  return '';
}

/** Free times of a day within class hours (15 minutes or more), outside approved reservations; today, from now on. */
export function freeSlots(dayBookings, day, cal) {
  let at = toMin(cal.day_start);
  const end = toMin(cal.day_end);
  if (day === todayStr()) at = Math.max(at, Math.ceil(nowMin() / 5) * 5);
  const taken = dayBookings
    .filter((b) => b.status === 'approved')
    .map((b) => [toMin(b.start_time), toMin(b.end_time)])
    .sort((a, b) => a[0] - b[0]);
  const slots = [];
  for (const [s, e] of taken) {
    if (s - at >= 15) slots.push([at, s]);
    at = Math.max(at, e);
  }
  if (end - at >= 15) slots.push([at, end]);
  return slots.map(([s, e]) => ({ start: fromMin(s), end: fromMin(e) }));
}

/** A link to reserve part of a free time: an hour, or less if the gap is shorter. */
const reserveLink = (day, slot) =>
  `#/rooms/new?day=${day}&start=${slot.start}&end=${fromMin(Math.min(toMin(slot.start) + 60, toMin(slot.end)))}`;

export function bookingItem(b, me, { showDay = true, actions = false } = {}) {
  const s = statusTag(b);
  const live = isActive(b) && !isPast(b);
  return html`<div class="item alert-item booking-item ${live ? '' : 'is-muted'}">
    <a class="item-link" href="#/rooms/${b.id}">
      <span class="item-icon ${b.status === 'approved' && live ? 'is-ok' : ''}">${icon('room')}</span>
      <span class="item-main">
        <strong>${b.purpose}</strong>
        <span class="item-sub">${[showDay ? dayLabel(b.day) : '', timeRange(b), b.created_by === me.id ? 'tú' : b.created_by_name].filter(Boolean).join(' · ')}</span>
        <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span></span>
      </span>
    </a>
    ${actions && b.status === 'pending' && !isPast(b)
      ? html`<span class="booking-actions">
          <button type="button" class="btn btn-primary btn-sm" data-approve="${b.id}">Aprobar</button>
          <button type="button" class="btn btn-secondary btn-sm" data-reject="${b.id}" aria-label="No aprobar">No</button>
        </span>`
      : ''}
  </div>`;
}

async function approve(id) {
  await decideBooking(id, true);
  toast('Aprobada. Le avisamos a quien la pidió.', 'ok');
}

/** Asks why (optional) and rejects. Resolves false if the person went back. */
async function reject(id) {
  const v = await dialog({
    title: '¿No aprobar esta reserva?',
    message: 'Le avisamos a quien la pidió, con las horas libres de ese día.',
    body: html`<label class="field"><span>¿Por qué? <em class="optional">opcional</em></span>
      <input name="note" maxlength="300" autocomplete="off" placeholder="Ej. Ese día hay evaluación"></label>`,
    confirmText: 'No aprobar',
    cancelText: 'Volver',
    danger: true,
    collect: true,
  });
  if (!v) return false;
  await decideBooking(id, false, v.note.trim());
  toast('Le avisamos que no se aprobó.', 'ok');
  return true;
}

function bindDecisions(root, reload) {
  for (const btn of root.querySelectorAll('[data-approve]')) {
    btn.addEventListener('click', () => busy(btn, async () => {
      await approve(Number(btn.dataset.approve));
      await reload();
    }));
  }
  for (const btn of root.querySelectorAll('[data-reject]')) {
    btn.addEventListener('click', () => busy(btn, async () => {
      if (await reject(Number(btn.dataset.reject))) await reload();
    }));
  }
}

// ---- Calendar ------------------------------------------------------------------------------

export async function roomsView(ctx) {
  const { el, query, isCurrent } = ctx;
  const me = state.me.user;
  const manager = approvesBookings(me);
  const cal = schoolCalendar(state.me.school);
  const today = todayStr();
  let mode = query.get('view') === 'month' ? 'month' : 'week';
  let day = DAY_RE.test(query.get('day') || '') ? query.get('day') : today;
  let data = null;

  const schoolDays = (from, to) => {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (cal.school_days.includes(isoWeekday(d))) out.push(d);
    return out;
  };
  // A weekend (or another day without classes in the week) shows the next school day.
  const fixDay = () => {
    if (cal.school_days.includes(isoWeekday(day))) return;
    day = schoolDays(day, addDays(day, 7))[0] || day;
  };
  const monthBounds = () => {
    const first = `${day.slice(0, 8)}01`;
    const next = addDays(first, 32).slice(0, 8);
    const last = addDays(`${next}01`, -1);
    return { first, last, from: weekStart(first), to: addDays(weekStart(last), 6) };
  };
  const range = () => (mode === 'week' ? [weekStart(day), addDays(weekStart(day), 6)] : [monthBounds().from, monthBounds().to]);

  const remember = () => {
    const hash = `#/rooms?day=${day}${mode === 'month' ? '&view=month' : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };

  const onDay = (d) => data.list.filter((b) => b.day === d && isActive(b)).sort((a, b) => toMin(a.start_time) - toMin(b.start_time));

  const agenda = () => {
    const problem = dayProblem(day, data.closures, cal);
    const bookings = onDay(day);
    const open = !problem && day >= today;
    const free = open ? freeSlots(bookings, day, cal) : [];
    const rows = [
      ...bookings.map((b) => ({ at: toMin(b.start_time), b })),
      ...free.map((s) => ({ at: toMin(s.start), s })),
    ].sort((a, b) => a.at - b.at || (a.s ? 1 : -1));
    return html`<div class="agenda">
      <h3 class="agenda-title">${longDay(day)}${day === today ? ' · hoy' : ''}</h3>
      ${problem ? html`<p class="status-note warn">${icon('calendar', 16)} ${problem}</p>` : ''}
      ${rows.length
        ? html`<div class="agenda-list">${rows.map(({ b, s }) => (b
            ? html`<a class="agenda-row is-${b.status}" href="#/rooms/${b.id}">
                <span class="agenda-time">${timeRange(b)}</span>
                <span class="agenda-main"><strong>${b.purpose}</strong>
                  <small>${b.created_by === me.id ? 'Tú' : b.created_by_name}${b.status === 'pending' ? ' · esperando aprobación' : ''}</small></span>
              </a>`
            : html`<div class="agenda-row is-free">
                <span class="agenda-time">${fmtTime(s.start)} – ${fmtTime(s.end)}</span>
                <span class="agenda-main"><strong>Libre</strong></span>
                <a class="btn btn-secondary btn-sm" href="${reserveLink(day, s)}">Reservar</a>
              </div>`))}</div>`
        : problem ? '' : html`<p class="muted">${day < today ? 'No hubo reservas ese día.' : 'Ya no queda tiempo libre hoy.'}</p>`}
    </div>`;
  };

  const weekView = () => {
    const days = schoolDays(weekStart(day), addDays(weekStart(day), 6));
    return html`<div class="day-strip" style="--cols:${days.length}">${days.map((d) => {
      const n = onDay(d).length;
      const off = !!dayProblem(d, data.closures, cal);
      const w = WEEKDAYS.find((x) => x.n === isoWeekday(d));
      return html`<button type="button" class="day-pill ${d === day ? 'active' : ''} ${d === today ? 'is-today' : ''} ${off ? 'is-off' : ''}"
          data-day="${d}" aria-label="${fmtLongDate(d)}${n ? `, ${n} reserva(s)` : ''}">
          <small>${w.short}</small><b>${Number(d.slice(8))}</b><i>${n || ''}</i></button>`;
    })}</div>
    ${agenda()}`;
  };

  const monthView = () => {
    const { first, last, from, to } = monthBounds();
    const cells = schoolDays(from, to);
    const heads = WEEKDAYS.filter((w) => cal.school_days.includes(w.n));
    return html`<div class="month-grid" style="--cols:${heads.length}">
      ${heads.map((w) => html`<span class="month-head">${w.short}</span>`)}
      ${cells.map((d) => {
        const n = onDay(d).length;
        const off = !!dayProblem(d, data.closures, cal);
        return html`<button type="button" class="month-cell ${d < first || d > last ? 'is-out' : ''} ${d === today ? 'is-today' : ''} ${off ? 'is-off' : ''}"
            data-day="${d}" aria-label="${fmtLongDate(d)}${n ? `, ${n} reserva(s)` : ''}${off ? ', sin clases' : ''}">
            <b>${Number(d.slice(8))}</b>${n ? html`<small>${n}</small>` : ''}</button>`;
      })}
    </div>
    <p class="hint">El número es cuántas reservas hay. Los días en gris no tienen clases. Toca un día para verlo.</p>`;
  };

  const title = () => {
    if (mode === 'month') return cap(new Date(`${day}T12:00:00`).toLocaleDateString('es', { month: 'long', year: 'numeric' }));
    const days = schoolDays(weekStart(day), addDays(weekStart(day), 6));
    const a = days[0] || weekStart(day);
    const b = days[days.length - 1] || addDays(weekStart(day), 6);
    return `${fmtDate(a, { day: 'numeric', month: 'short' })} – ${fmtDate(b, { day: 'numeric', month: 'short' })}`;
  };

  const render = () => {
    const { mine, pending } = data;
    const waiting = pending.filter((b) => !isPast(b));
    // Mine that still matter: coming up, or turned down for a day that hasn't passed.
    const myList = mine.filter((b) => !isPast(b) && b.status !== 'cancelled');
    const reserveDay = day >= today && !dayProblem(day, data.closures, cal) ? day : '';
    el.innerHTML = String(html`
      <div class="stack">
        <a class="btn btn-primary btn-block btn-lg" href="#/rooms/new${reserveDay ? `?day=${reserveDay}` : ''}">${icon('plus')} Reservar el salón</a>

        ${manager && waiting.length
          ? html`<section class="section">
              <h3 class="section-title">Por aprobar <span class="count warn">${waiting.length}</span></h3>
              <div class="list">${waiting.map((b) => bookingItem(b, me, { actions: true }))}</div>
            </section>`
          : ''}

        ${myList.length
          ? html`<section class="section">
              <h3 class="section-title">Tus reservas</h3>
              <div class="list">${myList.map((b) => bookingItem(b, me))}</div>
            </section>`
          : ''}

        <section class="card stack room-cal">
          <div class="cal-head">
            <button type="button" class="icon-btn" data-move="-1" aria-label="${mode === 'week' ? 'Semana anterior' : 'Mes anterior'}">${icon('back')}</button>
            <strong class="cal-title">${title()}</strong>
            <button type="button" class="icon-btn" data-move="1" aria-label="${mode === 'week' ? 'Semana siguiente' : 'Mes siguiente'}">${icon('chevron')}</button>
          </div>
          <div class="segmented" role="group" aria-label="Vista">
            <button type="button" class="seg ${mode === 'week' ? 'active' : ''}" data-mode="week" aria-pressed="${mode === 'week'}">Semana</button>
            <button type="button" class="seg ${mode === 'month' ? 'active' : ''}" data-mode="month" aria-pressed="${mode === 'month'}">Mes</button>
          </div>
          ${mode === 'week' ? weekView() : monthView()}
          ${day !== today ? html`<button type="button" class="btn btn-ghost btn-sm" data-today>Ir a hoy</button>` : ''}
        </section>

        <p class="hint">${manager
          ? 'Tus reservas quedan aprobadas al momento. Si eliges una hora que ya tiene otra persona, la app te pregunta antes de reemplazarla.'
          : 'La secretaría o la dirección aprueban las reservas. Te avisamos cuando respondan.'}</p>
        <a class="btn btn-ghost btn-block" href="#/rooms/history">${icon('list', 18)} Historial y canceladas</a>
        ${manager ? html`<a class="btn btn-ghost btn-block" href="#/rooms/panel">${icon('chart', 18)} Uso del salón y Excel</a>` : ''}
      </div>`);

    for (const btn of el.querySelectorAll('[data-day]')) {
      btn.addEventListener('click', () => {
        day = btn.dataset.day;
        const switching = mode === 'month';
        mode = 'week';
        remember();
        if (switching) load();
        else render();
      });
    }
    for (const btn of el.querySelectorAll('[data-mode]')) {
      btn.addEventListener('click', () => {
        if (mode === btn.dataset.mode) return;
        mode = btn.dataset.mode;
        remember();
        load();
      });
    }
    for (const btn of el.querySelectorAll('[data-move]')) {
      btn.addEventListener('click', () => {
        const step = Number(btn.dataset.move);
        if (mode === 'week') day = addDays(day, 7 * step);
        else {
          const first = `${day.slice(0, 8)}01`;
          day = step > 0 ? `${addDays(first, 32).slice(0, 8)}01` : `${addDays(first, -1).slice(0, 8)}01`;
        }
        fixDay();
        remember();
        load();
      });
    }
    $('[data-today]', el)?.addEventListener('click', () => {
      day = today;
      fixDay();
      remember();
      load();
    });
    bindDecisions(el, load);
  };

  async function load() {
    const [from, to] = range();
    const [list, mine, pending, closures] = await Promise.all([
      listBookings(from, to),
      myBookings(me.id, today),
      manager ? pendingBookings(today) : [],
      listClosures({ from }).catch(() => []),
    ]);
    if (!isCurrent()) return;
    data = { list, mine, pending, closures };
    render();
  }

  fixDay();
  await load();
  markAlertsRead('#/rooms').catch(() => {});
  keepFresh(ctx, load);
}

// ---- New reservation -----------------------------------------------------------------------

export async function newBookingView({ el, query }) {
  const me = state.me.user;
  const manager = approvesBookings(me);
  const cal = schoolCalendar(state.me.school);
  const today = todayStr();
  const closures = await listClosures({ from: today }).catch(() => []);
  const asked = query.get('day') || '';
  let day = DAY_RE.test(asked) && asked >= today ? asked : today;
  // Start on a day that can be reserved.
  for (let i = 0; i < 60 && dayProblem(day, closures, cal); i++) day = addDays(day, 1);
  const start = TIME_RE.test(query.get('start') || '') ? query.get('start') : '';
  const end = TIME_RE.test(query.get('end') || '') ? query.get('end') : '';
  let dayList = [];

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('room')} Salón de conferencias</h2>
        <label class="field"><span>¿Para qué es?</span>
          <input name="purpose" required maxlength="120" value="${query.get('purpose') || ''}" autocomplete="off" placeholder="Ej. Reunión de padres de 9-B"></label>
        <p class="hint">Todo el personal ve para qué es; no escribas datos privados.</p>
        <label class="field"><span>Día</span>
          <input type="date" name="day" required min="${today}" max="${addDays(today, 365)}" value="${day}"></label>
        <p class="status-note warn" data-day-note hidden></p>
        <div class="grid2">
          <label class="field"><span>Desde</span>
            <input type="time" name="start" required step="300" min="${cal.day_start}" max="${cal.day_end}" value="${start}"></label>
          <label class="field"><span>Hasta</span>
            <input type="time" name="end" required step="300" min="${cal.day_start}" max="${cal.day_end}" value="${end}"></label>
        </div>
        <p class="hint">Horario escolar: ${fmtTime(cal.day_start)} – ${fmtTime(cal.day_end)}, de ${daysText(cal.school_days)}.</p>
        <p class="status-note" data-clash hidden></p>
        <label class="field"><span>${manager ? 'Nota' : 'Nota para la dirección'} <em class="optional">opcional</em></span>
          <textarea name="note" rows="2" maxlength="1000" placeholder="Ej. Necesito el proyector y 30 sillas"></textarea></label>
        <p class="hint">Solo la ven tú, la secretaría y la dirección. Luego pueden seguir conversando en la reserva.</p>
      </section>
      <section class="card stack" data-day-agenda></section>
      <p class="status-note muted">${icon('calendar', 16)} <span>Revisa que ese día no sea feriado ni día sin clases. Los días marcados en el
        <a href="#/calendar">calendario escolar</a> no se pueden reservar.</span></p>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} ${manager ? 'Reservar' : 'Pedir la reserva'}</button>
      <p class="hint center">${manager
        ? 'Tu reserva queda aprobada al momento.'
        : 'La secretaría o la dirección la aprueban. Te avisamos cuando respondan.'}</p>
    </form>`);

  const form = $('[data-form]', el);
  const field = (name) => form.querySelector(`[name=${name}]`);
  const others = (s, e) => dayList.filter((b) => isActive(b) && b.created_by !== me.id && overlaps(b, s, e));

  const showDay = () => {
    const d = field('day').value;
    const note = $('[data-day-note]', el);
    const problem = DAY_RE.test(d) ? dayProblem(d, closures, cal) : '';
    note.textContent = problem;
    note.hidden = !problem;
    const box = $('[data-day-agenda]', el);
    if (!DAY_RE.test(d) || problem) {
      box.hidden = true;
      return;
    }
    const bookings = dayList.filter(isActive).sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
    const free = freeSlots(bookings, d, cal);
    box.hidden = false;
    box.innerHTML = String(html`
      <h2 class="card-title">${icon('calendar')} ${longDay(d)}</h2>
      ${bookings.length
        ? html`<div class="list flat">${bookings.map((b) => bookingItem(b, me, { showDay: false }))}</div>`
        : html`<p class="muted">Nadie lo ha reservado todavía.</p>`}
      <p class="hint">${free.length
        ? html`Libre: ${free.map((s, i) => html`${i ? ', ' : ''}<button type="button" class="link-btn" data-slot="${s.start}-${s.end}">${fmtTime(s.start)} – ${fmtTime(s.end)}</button>`)}`
        : 'Ese día ya no queda tiempo libre.'}</p>`);
    for (const btn of box.querySelectorAll('[data-slot]')) {
      btn.addEventListener('click', () => {
        const [s, e] = btn.dataset.slot.split('-');
        field('start').value = s;
        field('end').value = fromMin(Math.min(toMin(s) + 60, toMin(e)));
        showClash();
      });
    }
  };

  const showClash = () => {
    const note = $('[data-clash]', el);
    const s = field('start').value;
    const e = field('end').value;
    const list = TIME_RE.test(s) && TIME_RE.test(e) && e > s ? others(s, e) : [];
    note.hidden = !list.length;
    if (!list.length) return;
    const who = list.map((b) => `${b.created_by_name} (${timeRange(b)}${b.status === 'pending' ? ', esperando aprobación' : ''})`).join('; ');
    const blocked = list.some((b) => b.status === 'approved' && (b.priority || !manager));
    note.className = `status-note ${blocked ? 'danger' : 'warn'}`;
    note.textContent = blocked
      ? `Ya está reservado a esa hora: ${who}.`
      : manager
        ? `A esa hora ya está ${who}. Si sigues, se reemplaza y le avisamos.`
        : `También lo pidió ${who}. La secretaría o la dirección decidirán.`;
  };

  const loadDay = async () => {
    const d = field('day').value;
    dayList = DAY_RE.test(d) ? await listBookings(d, d).catch(() => []) : [];
    showDay();
    showClash();
  };

  field('day').addEventListener('change', loadDay);
  field('start').addEventListener('change', () => {
    // An hour by default.
    const s = field('start').value;
    if (TIME_RE.test(s) && (!field('end').value || field('end').value <= s)) {
      field('end').value = fromMin(Math.min(toMin(s) + 60, toMin(cal.day_end)));
    }
    showClash();
  });
  field('end').addEventListener('change', showClash);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const purpose = field('purpose').value.trim().replace(/\s+/g, ' ');
      if (!purpose) throw new Error('Escribe para qué es (por ejemplo, «Reunión de padres de 9-B»).');
      const d = field('day').value;
      if (!DAY_RE.test(d)) throw new Error('Elige el día.');
      if (d < today) throw new Error('Esa fecha ya pasó.');
      const problem = dayProblem(d, closures, cal);
      if (problem) throw new Error(problem);
      const s = field('start').value;
      const en = field('end').value;
      if (!TIME_RE.test(s) || !TIME_RE.test(en)) throw new Error('Elige la hora de inicio y la de fin.');
      if (en <= s) throw new Error('La hora de fin debe ser después de la de inicio.');
      if (toMin(en) - toMin(s) < 15) throw new Error('Reserva al menos 15 minutos.');
      if (s < cal.day_start || en > cal.day_end) {
        throw new Error(`Elige una hora dentro del horario escolar: de ${fmtTime(cal.day_start)} a ${fmtTime(cal.day_end)}`);
      }
      if (d === today && toMin(s) < nowMin() - 5) throw new Error('Esa hora ya pasó.');

      // Secretaría and the dirección are asked before taking someone else's time.
      let replace = false;
      if (manager) {
        dayList = await listBookings(d, d);
        const list = others(s, en);
        if (list.length && !list.some((b) => b.status === 'approved' && b.priority)) {
          const ok = await dialog({
            title: '¿Reemplazar la reserva?',
            message: 'Se cancela y le avisamos, con las horas libres de ese día.',
            body: html`<div class="list flat">${list.map((b) => bookingItem(b, me, { showDay: false }))}</div>`,
            confirmText: 'Reemplazar',
            cancelText: 'Volver',
            danger: true,
          });
          if (!ok) return;
          replace = true;
        }
      }
      const b = await createBooking({ day: d, start: s, end: en, purpose, replace, note: field('note').value.trim() });
      toast(manager ? 'Salón reservado' : 'Reserva pedida. Te avisamos cuando respondan.', 'ok');
      go(`/rooms/${b.id}`, { replace: true });
    });
  });

  await loadDay();
}

// ---- Detail --------------------------------------------------------------------------------

export async function bookingDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;
  const manager = approvesBookings(me);

  async function load() {
    const b = await getBooking(id);
    const mine = b.created_by === me.id;
    const [sameDay, notes] = await Promise.all([
      // Secretaría sees what else is asked or reserved at that time before deciding.
      manager && b.status === 'pending' ? listBookings(b.day, b.day) : [],
      // The conversation is only between whoever asked and Secretaría / the dirección.
      mine || manager ? bookingNotes(id) : [],
    ]);
    if (!isCurrent()) return;
    // What was being written survives a refresh.
    const draft = $('[data-note-form] textarea', el)?.value || '';
    const s = statusTag(b);
    const past = isPast(b);
    const active = isActive(b);
    const clashes = sameDay.filter((x) => x.id !== b.id && isActive(x) && overlaps(x, b.start_time, b.end_time));
    const closedLabel = { rejected: 'No aprobada', cancelled: 'Cancelada', replaced: 'Reemplazada' }[b.status];
    const buttons = [];
    if (manager && b.status === 'pending' && !past) {
      buttons.push(html`<button type="button" class="btn btn-primary btn-block btn-lg" data-step="approve">${icon('check')} Aprobar</button>`);
      buttons.push(html`<button type="button" class="btn btn-secondary btn-block" data-step="reject">No aprobar</button>`);
    }
    if (active && !past && (mine || manager)) {
      buttons.push(html`<button type="button" class="btn btn-ghost-danger btn-block" data-step="cancel">Cancelar reserva</button>`);
    }
    if (!active && mine && b.day >= todayStr()) {
      buttons.push(html`<a class="btn btn-primary btn-block" href="#/rooms/new?day=${b.day}&purpose=${encodeURIComponent(b.purpose)}">${icon('plus')} Pedir otra hora</a>`);
    }
    if (b.status === 'replaced' && b.replaced_by) {
      buttons.push(html`<a class="btn btn-secondary btn-block" href="#/rooms/${b.replaced_by}">${icon('room', 18)} Ver la reserva que la reemplazó</a>`);
    }

    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${b.status === 'approved' && !past ? 'is-ok' : ''}">
          <p class="alert-kind">${icon('room', 18)} Salón · <span class="tag ${s.cls}">${s.label}</span></p>
          <h2>${b.purpose}</h2>
          <div class="facts">
            ${fact('Día', longDay(b.day))}
            ${fact('Hora', timeRange(b))}
            ${fact(b.priority ? 'Reservó' : 'Pidió', `${mine ? 'Tú' : b.created_by_name} · ${fmtDateTime(b.created_at)}`)}
            ${b.approved_at && !b.priority ? fact('Aprobó', `${b.approved_by_name} · ${fmtDateTime(b.approved_at)}`) : ''}
            ${b.status === 'replaced' ? fact('La reemplazó', `${b.closed_by_name}, que necesitó el salón a esa hora · ${fmtDateTime(b.closed_at)}`) : ''}
            ${b.status === 'rejected' ? fact('No la aprobó', `${b.closed_by_name} · ${fmtDateTime(b.closed_at)}`) : ''}
            ${b.status === 'cancelled' ? fact('La canceló', `${b.closed_by_name} · ${fmtDateTime(b.closed_at)}`) : ''}
            ${fact('Motivo', b.close_note)}
          </div>
          <ol class="timeline steps">
            <li class="is-done"><strong>${b.priority ? 'Reservada' : 'Pedida'}</strong> · ${b.created_by_name}<small>${timeAgo(b.created_at)}</small></li>
            ${!b.priority && (b.approved_at || b.status === 'pending')
              ? html`<li class="${b.approved_at ? 'is-done' : ''}"><strong>Aprobada</strong>${b.approved_at ? html` · ${b.approved_by_name}<small>${timeAgo(b.approved_at)}</small>` : ''}</li>`
              : ''}
            ${closedLabel ? html`<li class="is-done"><strong>${closedLabel}</strong> · ${b.closed_by_name}<small>${timeAgo(b.closed_at)}</small></li>` : ''}
          </ol>
        </section>
        ${clashes.length
          ? html`<section class="card stack">
              <h2 class="card-title">${icon('alert')} A la misma hora</h2>
              <div class="list flat">${clashes.map((x) => bookingItem(x, me, { showDay: false }))}</div>
              <p class="hint">${clashes.some((x) => x.status === 'approved')
                ? 'Choca con una reserva aprobada: para aprobar esta, primero cancela la otra.'
                : 'Si apruebas esta, las otras se rechazan y les avisamos con las horas libres de ese día.'}</p>
            </section>`
          : ''}
        ${buttons}
        ${b.status === 'pending' && mine && !past ? html`<p class="hint">Te avisamos cuando la secretaría o la dirección respondan.</p>` : ''}
        ${mine || manager ? notesSection(b, notes, me, mine) : ''}
        <a class="btn btn-ghost btn-block" href="#/rooms?day=${b.day}">${icon('calendar', 18)} Ver ese día</a>
      </div>`);

    const noteForm = $('[data-note-form]', el);
    if (noteForm) {
      noteForm.body.value = draft;
      noteForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const body = noteForm.body.value.trim();
        if (!body) return;
        busy(noteForm.querySelector('button'), async () => {
          await addBookingNote(id, body);
          noteForm.body.value = '';
          await load();
          $('[data-notes] .bubble:last-child', el)?.scrollIntoView({ block: 'center' });
        });
      });
    }

    for (const btn of el.querySelectorAll('[data-step]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          const step = btn.dataset.step;
          if (step === 'approve') await approve(id);
          if (step === 'reject' && !(await reject(id))) return;
          if (step === 'cancel') {
            const v = await dialog({
              title: '¿Cancelar esta reserva?',
              message: `${b.purpose} · ${dayLabel(b.day)}, ${timeRange(b)}`,
              body: !mine
                ? html`<label class="field"><span>¿Por qué? <em class="optional">opcional</em></span>
                    <input name="note" maxlength="300" autocomplete="off" placeholder="Ej. Se usará para la feria"></label>`
                : '',
              confirmText: 'Cancelar reserva',
              cancelText: 'Volver',
              danger: true,
              collect: true,
            });
            if (!v) return;
            await cancelBooking(id, (v.note || '').trim());
            toast(mine ? 'Reserva cancelada' : 'Reserva cancelada. Le avisamos.', 'ok');
          }
          await load();
        }),
      );
    }
  }

  await load();
  markAlertsRead(`#/rooms/${id}`).catch(() => {});
  // Not while someone is writing a note.
  const writing = () => {
    const box = $('[data-note-form] textarea', el);
    return !!box && (document.activeElement === box || !!box.value.trim());
  };
  keepFresh(ctx, () => (writing() ? Promise.resolve() : load()));
}

/** The notes between whoever asked and Secretaría / the dirección about that day. */
function notesSection(b, notes, me, mine) {
  const who = mine ? 'tú, la secretaría y la dirección' : `${b.created_by_name}, la secretaría y la dirección`;
  return html`<section class="card stack" data-notes>
    <h3 class="card-title">${icon('chat')} Notas ${notes.length ? html`<span class="count">${notes.length}</span>` : ''}</h3>
    ${notes.length
      ? html`<div class="thread">${notes.map(
          (n) => html`<div class="bubble ${n.user_id === me.id ? 'mine' : ''}">
            <div class="bubble-head"><strong>${n.author_name}</strong><span>${roleLabel(n.author_role)} · ${timeAgo(n.created_at)}</span></div>
            <p class="pre">${n.body}</p>
          </div>`,
        )}</div>`
      : html`<p class="muted">${mine ? 'Escríbele a la secretaría o a la dirección sobre este día.' : `Escríbele a ${b.created_by_name} sobre este día.`}</p>`}
    <form class="comment-form" data-note-form>
      <textarea name="body" rows="2" maxlength="1000" required
        placeholder="${mine ? 'Escribe una nota para la dirección…' : 'Escribe una nota…'}"></textarea>
      <button class="btn btn-primary" type="submit" aria-label="Enviar nota">${icon('send', 18)}</button>
    </form>
    <p class="hint">Solo la ven ${who}.</p>
  </section>`;
}

// ---- History -------------------------------------------------------------------------------

const HISTORY_FILTERS = [
  ['all', 'Todas', 'No hay reservas en este período.'],
  ['cancelled', 'Canceladas', 'No hay reservas canceladas en este período.'],
  ['rejected', 'No aprobadas', 'No hay reservas sin aprobar en este período.'],
  ['replaced', 'Reemplazadas', 'No hay reservas reemplazadas en este período.'],
  ['approved', 'Aprobadas', 'No hay reservas aprobadas en este período.'],
  ['pending', 'Por aprobar', 'No hay reservas esperando aprobación en este período.'],
];
// [key, label, days back]: the reservations are kept a year.
const HISTORY_PERIODS = [['30', '30 días', 30], ['90', '3 meses', 90], ['year', 'Un año', null]];
const CLOSED_BY = { cancelled: 'La canceló', rejected: 'No la aprobó', replaced: 'La reemplazó' };

const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA');
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** The last thing that happened to a reservation, and when. */
function lastStep(b, me) {
  if (b.closed_at) return { at: b.closed_at, text: `${CLOSED_BY[b.status] || 'La cerró'} ${b.closed_by_name}` };
  if (b.approved_at && !b.priority) return { at: b.approved_at, text: `La aprobó ${b.approved_by_name}` };
  if (b.created_by === me.id) return { at: b.created_at, text: b.priority ? 'La reservaste' : 'La pediste' };
  return { at: b.created_at, text: `${b.priority ? 'La reservó' : 'La pidió'} ${b.created_by_name}` };
}

function historyItem(b, me) {
  const s = statusTag(b);
  const step = lastStep(b, me);
  // Who asked, unless it's me or the last step already says it.
  const asked = b.created_by !== me.id && step.at !== b.created_at;
  return html`<a class="item booking-item" href="#/rooms/${b.id}">
    <span class="item-icon ${b.status === 'approved' && !isPast(b) ? 'is-ok' : ''}">${icon('room')}</span>
    <span class="item-main">
      <strong>${b.purpose}</strong>
      <span class="item-sub">${dayLabel(b.day)} · ${timeRange(b)}</span>
      ${asked ? html`<span class="item-sub">${b.priority ? 'Reservó' : 'Pidió'} ${b.created_by_name}</span>` : ''}
      <span class="item-sub">${step.text} · ${fmtTime(new Date(step.at))}</span>
      ${b.close_note ? html`<span class="item-sub">«${b.close_note}»</span>` : ''}
      <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span></span>
    </span>
  </a>`;
}

/**
 * Historial y canceladas: what happened to each reservation, newest first, with who cancelled, rejected or replaced
 * it and why. Secretaría and the dirección see the whole school's; everyone else, their own.
 */
export async function bookingHistoryView(ctx) {
  const { el, query, isCurrent } = ctx;
  const me = state.me.user;
  const manager = approvesBookings(me);
  const pick = (list, v, fallback) => (list.some(([k]) => k === v) ? v : fallback);
  let filter = pick(HISTORY_FILTERS, query.get('ver'), 'all');
  let period = pick(HISTORY_PERIODS, query.get('periodo'), '30');
  let rows = null;
  let q = '';
  let loads = 0;

  el.innerHTML = String(html`
    <div class="stack">
      <section class="card stack">
        <div class="segmented" role="group" aria-label="Período">${HISTORY_PERIODS.map(
          ([k, label]) => html`<button type="button" class="seg ${k === period ? 'active' : ''}" data-period="${k}" aria-pressed="${k === period}">${label}</button>`,
        )}</div>
        <div class="quick" data-filters></div>
        <label class="search">${icon('search', 18)}<input type="search" placeholder="Buscar por para qué o por persona…" data-q></label>
      </section>
      <div class="stack" data-list><div class="loading"><span class="spinner"></span></div></div>
      <p class="hint">${manager
        ? 'Todas las reservas de la escuela, por la fecha de lo último que pasó con cada una. Toca una para ver su historial y sus notas. Se guardan un año.'
        : 'Tus reservas, también las canceladas, las no aprobadas y las reemplazadas, por la fecha de lo último que pasó. Toca una para ver su historial. Se guardan un año.'}</p>
    </div>`);

  const remember = () => {
    const p = new URLSearchParams();
    if (filter !== 'all') p.set('ver', filter);
    if (period !== '30') p.set('periodo', period);
    const hash = `#/rooms/history${String(p) ? `?${p}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };
  const matches = (b) => !q || fold([b.purpose, b.created_by_name, b.approved_by_name, b.closed_by_name, b.close_note].join(' ')).includes(q);
  const inFilter = (b, f) => f === 'all' || b.status === f;

  function renderList() {
    if (!rows) return;
    const found = rows.filter(matches);
    const count = (f) => found.filter((b) => inFilter(b, f)).length;
    // The empty kinds stay out of the way, except "Canceladas" and the one chosen.
    $('[data-filters]', el).innerHTML = String(html`${HISTORY_FILTERS.filter(([k]) => k === 'all' || k === 'cancelled' || k === filter || count(k)).map(
      ([k, label]) => html`<button type="button" class="chip-btn ${k === filter ? 'active' : ''}" data-filter="${k}" aria-pressed="${k === filter}">${label} · ${count(k)}</button>`,
    )}`);
    const shown = found.filter((b) => inFilter(b, filter));
    const list = $('[data-list]', el);
    if (!shown.length) {
      const why = q ? 'Prueba con otra búsqueda.' : period === 'year' ? 'Las reservas se guardan un año.' : 'Elige un período más largo.';
      list.innerHTML = String(html`<div class="card">${empty('room', HISTORY_FILTERS.find(([k]) => k === filter)[2], why)}</div>`);
      return;
    }
    // By the day of the last change: today, yesterday, then the date.
    const days = new Map();
    for (const b of shown) {
      const d = localDay(lastStep(b, me).at);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(b);
    }
    list.innerHTML = String(html`${[...days].map(
      ([d, items]) => html`<section class="section">
        <h3 class="section-title">${dayLabel(d)} <span class="count">${items.length}</span></h3>
        <div class="list">${items.map((b) => historyItem(b, me))}</div>
      </section>`,
    )}`);
  }

  async function load() {
    const n = ++loads;
    const days = HISTORY_PERIODS.find(([k]) => k === period)[2];
    const list = await bookingHistory({ since: days ? addDays(todayStr(), -days) : null, userId: manager ? null : me.id });
    if (!isCurrent() || n !== loads) return;
    const at = (b) => new Date(lastStep(b, me).at).getTime();
    rows = list.sort((a, b) => at(b) - at(a));
    renderList();
  }

  $('[data-filters]', el).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn || btn.dataset.filter === filter) return;
    filter = btn.dataset.filter;
    remember();
    renderList();
  });
  $('[data-q]', el).addEventListener('input', (e) => {
    q = fold(e.target.value.trim());
    renderList();
  });
  for (const btn of el.querySelectorAll('[data-period]')) {
    btn.addEventListener('click', () => {
      if (period === btn.dataset.period) return;
      period = btn.dataset.period;
      for (const x of el.querySelectorAll('[data-period]')) {
        x.classList.toggle('active', x === btn);
        x.setAttribute('aria-pressed', String(x === btn));
      }
      remember();
      load();
    });
  }

  await load();
  keepFresh(ctx, load);
}

/** On Ausencias of Secretaría and the dirección: requests waiting for them. */
export function waitingCard(pending = []) {
  const n = pending.filter((b) => !isPast(b)).length;
  if (!n) return '';
  return html`<a class="card link-card room-link is-warn" href="#/rooms">${icon('room')}<span>
    <strong>${n} ${n === 1 ? 'reserva del salón por aprobar' : 'reservas del salón por aprobar'}</strong>
    <small>Toca para aprobarlas o no</small></span>${icon('chevron', 18)}</a>`;
}
