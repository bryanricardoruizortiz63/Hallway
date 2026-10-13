import {
  $,
  CATEGORIES,
  addDays,
  busy,
  dialog,
  fileSize,
  fmtDate,
  fmtDateTime,
  fmtLongDate,
  fmtRange,
  fmtTime,
  formValues,
  html,
  can,
  isStaff,
  isoWeekday,
  roleLabel,
  roleNeedsCoverage,
  scheduleText,
  schoolCalendar,
  timeAgo,
  toast,
  todayStr,
  weekdays,
} from '../lib.js';
import {
  addAttachments,
  addComment,
  cancelAbsence,
  checkFile,
  createAbsence,
  deleteAttachment,
  getAbsence,
  getCoverage,
  listClosures,
  listEmployees,
  markAlertsRead,
  myAbsences,
  myCoverages,
  receiveAbsence,
  replyCoverage,
  setCovers,
  updateAbsence,
} from '../backend.js';
import { MAX_FILES, MAX_UPLOAD_MB as maxMb } from '../config.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { absenceList, avatar, empty, installHint, statusBadge } from './common.js';
import { closureNote } from './calendar.js';
import { guideHint } from './guide.js';

const ACCEPT = 'image/*,application/pdf,.pdf,.heic,.heif,.doc,.docx';

// ---- Mis ausencias --------------------------------------------------------

export async function homeView({ el }) {
  const today = todayStr();
  const [absences, covering] = await Promise.all([myAbsences(state.me.user.id), myCoverages(today).catch(() => [])]);
  const current = absences
    .filter((a) => a.status !== 'cancelled' && a.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = absences.filter((a) => !current.includes(a));
  const firstName = state.me.user.full_name.split(' ')[0];

  el.innerHTML = String(html`
    <section class="hero">
      <div>
        <p class="hero-kicker">Hola, ${firstName} 👋</p>
        <h2>¿Te ausentarás?</h2>
        <p>Registra tu ausencia aquí.</p>
      </div>
      <a href="#/report" class="btn btn-light btn-lg btn-block">${icon('plus')} Reportar ausencia</a>
    </section>
    ${coveringSection(covering)}
    <div data-guide-slot></div>
    <div data-install-slot></div>
    <section class="section">
      <h3 class="section-title">Hoy y próximas</h3>
      ${current.length
        ? absenceList(current, { showName: false })
        : empty('calendar', 'No tienes ausencias próximas', 'Cuando reportes una, verás aquí si la administración la recibió.')}
    </section>
    ${past.length
      ? html`<section class="section"><h3 class="section-title">Historial</h3>${absenceList(past, { showName: false })}</section>`
      : ''}`);
  guideHint($('[data-guide-slot]', el));
  installHint($('[data-install-slot]', el));
}

// ---- Reportar / modificar ---------------------------------------------------

/** The employee (while the absence hasn't passed) or whoever registers the staff's absences can edit or cancel it. */
function canChange(a, me) {
  return a.status !== 'cancelled' && (can(me, 'register') || (a.user_id === me.id && a.end_date >= todayStr()));
}

export const reportView = (ctx) => absenceForm(ctx, null);

export async function editAbsenceView(ctx) {
  const { absence } = await getAbsence(ctx.params[0]);
  if (!canChange(absence, state.me.user)) {
    throw new Error(
      absence.status === 'cancelled'
        ? 'La ausencia está cancelada.'
        : 'Solo el empleado o quien registra las ausencias del personal pueden modificar esta ausencia.',
    );
  }
  return absenceForm(ctx, absence);
}

async function absenceForm({ el, query }, absence) {
  const me = state.me.user;
  const editing = !!absence;
  // Whoever registers the staff's absences (and the Administración account) can report one for someone else;
  // the Administración account always does, the rest also their own.
  const forOthers = !editing && can(me, 'register');
  const onlyOthers = me.role === 'admin';
  const today = todayStr();
  const [employees, closures] = await Promise.all([
    forOthers ? listEmployees().then((list) => list.filter((e) => e.active && e.role !== 'admin' && e.id !== me.id)) : [],
    // To warn when the chosen days have no classes; the form works without it.
    listClosures({ from: addDays(today, -60) }).catch(() => []),
  ]);
  const preselect = query.get('user_id') || '';
  const files = [];
  const v0 = absence || { start_date: today, end_date: today, partial: false, category: '', reason: '', coverage_notes: '' };
  // Teachers' absences need someone to cover them; nursing, maintenance or security don't.
  const needsCoverage = (roleKey) => !!roleKey && roleNeedsCoverage(roleKey);
  const roleOf = (userId) => (userId ? employees.find((e) => e.id === userId)?.role : onlyOthers ? null : me.role);
  const initialRole = editing ? absence.employee_role : roleOf(preselect);
  const startTime = absence?.start_time?.slice(0, 5) || '08:00';
  const endTime = absence?.end_time?.slice(0, 5) || '';
  const category = v0.category || '';

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      ${forOthers
        ? html`<section class="card">
            <label class="field"><span>¿Quién va a faltar?</span>
              <select name="user_id" ${onlyOthers ? 'required' : ''}>
                ${onlyOthers
                  ? html`<option value="" ${preselect ? '' : 'selected'} disabled>Selecciona un empleado…</option>`
                  : html`<option value="" ${preselect && preselect !== me.id ? '' : 'selected'}>Yo (${me.full_name})</option>`}
                ${employees.map(
                  (e) => html`<option value="${e.id}" ${String(e.id) === preselect ? 'selected' : ''}>
                    ${e.full_name}${e.position ? ` — ${e.position}` : ''}</option>`,
                )}
              </select>
            </label>
          </section>`
        : ''}
      ${editing && absence.user_id !== me.id
        ? html`<section class="card row">${avatar(absence.employee_name)}<div><strong>${absence.employee_name}</strong>
            <p class="muted">Estás modificando su ausencia.</p></div></section>`
        : ''}

      <section class="card stack">
        <h2 class="card-title">${icon('calendar')} ¿Cuándo?</h2>
        <div class="quick">
          <button type="button" class="chip-btn active" data-quick="0">Hoy</button>
          <button type="button" class="chip-btn" data-quick="1">Mañana</button>
          <button type="button" class="chip-btn" data-quick="range">Varios días</button>
        </div>
        <div class="grid2">
          <label class="field"><span data-start-label>Fecha</span>
            <input type="date" name="start_date" value="${v0.start_date}" min="${addDays(today, -60)}" max="${addDays(today, 365)}" required>
          </label>
          <label class="field" data-end hidden><span>Hasta</span>
            <input type="date" name="end_date" value="${v0.end_date}" min="${v0.start_date}" max="${addDays(today, 365)}">
          </label>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Duración">
          <label class="seg"><input type="radio" name="partial" value="0" ${v0.partial ? '' : 'checked'}> Día completo</label>
          <label class="seg"><input type="radio" name="partial" value="1" ${v0.partial ? 'checked' : ''}> Parte del día</label>
        </div>
        <div class="grid2" data-times hidden>
          <label class="field"><span>Desde</span><input type="time" name="start_time" value="${startTime}"></label>
          <label class="field"><span>Hasta <em class="optional">opcional</em></span><input type="time" name="end_time" value="${endTime}"></label>
        </div>
        <p class="hint" data-summary></p>
        <p class="status-note warn" data-closure-note hidden></p>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('chat')} Motivo <em class="optional">opcional</em></h2>
        <div class="chips" role="radiogroup" aria-label="Tipo de ausencia">
          <label class="chip"><input type="radio" name="category" value="" ${category ? '' : 'checked'}><span>Prefiero no decir</span></label>
          ${Object.entries(CATEGORIES).map(
            ([value, label]) => html`<label class="chip"><input type="radio" name="category" value="${value}" ${category === value ? 'checked' : ''}><span>${label}</span></label>`,
          )}
        </div>
        <label class="field"><span>Causa</span>
          <textarea name="reason" rows="3" maxlength="1000" placeholder="Puedes dejarlo en blanco si prefieres no especificar.">${v0.reason || ''}</textarea>
        </label>
      </section>

      <section class="card stack" data-coverage-notes ${needsCoverage(initialRole) || v0.coverage_notes ? '' : 'hidden'}>
        <h2 class="card-title">${icon('users')} Para cubrir la clase <em class="optional">opcional</em></h2>
        <label class="field"><span>Instrucciones para quien te cubra</span>
          <textarea name="coverage_notes" rows="3" maxlength="1000"
            placeholder="Ej.: El plan está en el escritorio. Grupo 3-B: lectura pág. 45.">${v0.coverage_notes || ''}</textarea>
        </label>
      </section>

      ${editing
        ? html`<section class="card stack">
            <h2 class="card-title">${icon('edit')} ¿Qué corregiste? <em class="optional">opcional</em></h2>
            <label class="field"><span>Queda en el historial de la ausencia</span>
              <textarea name="note" rows="2" maxlength="500" placeholder="Ej.: Puse el lunes por error, era el martes."></textarea>
            </label>
            <p class="hint">Los documentos se añaden o quitan desde la ausencia.</p>
          </section>`
        : html`<section class="card stack">
            <h2 class="card-title">${icon('clip')} Excusa o evidencia <em class="optional">opcional</em></h2>
            <label class="dropzone">
              <input type="file" name="files" multiple accept="${ACCEPT}">
              ${icon('camera', 26)}
              <strong>Tomar foto o elegir archivo</strong>
              <small>PDF, foto o Word · máx. ${maxMb} MB · hasta ${MAX_FILES} archivos</small>
            </label>
            <ul class="file-list" data-files></ul>
          </section>`}

      <button class="btn btn-primary btn-block btn-lg" type="submit">
        ${editing ? html`${icon('check')} Guardar cambios` : html`${icon('send')} Enviar ausencia`}</button>
      <p class="hint center">${!editing
        ? 'La dirección recibirá una notificación al instante.'
        : absence.status === 'received'
          ? 'La dirección verá el cambio. Si cambias la fecha o la hora, tendrá que confirmarla de nuevo.'
          : 'La dirección verá el cambio y quedará en el historial.'}</p>
    </form>`);

  const form = $('[data-form]', el);
  const start = form.start_date;
  const end = form.end_date;
  const endWrap = $('[data-end]', el);
  const times = $('[data-times]', el);
  const summary = $('[data-summary]', el);
  let multi = v0.start_date !== v0.end_date;

  function update() {
    const partial = form.querySelector('[name=partial]:checked').value === '1';
    if (partial) multi = false;
    endWrap.hidden = !multi;
    times.hidden = !partial;
    $('[data-start-label]', el).textContent = multi ? 'Desde' : 'Fecha';
    end.min = start.value;
    if (!multi || end.value < start.value) end.value = start.value;
    for (const seg of el.querySelectorAll('.segmented .seg')) seg.classList.toggle('active', seg.querySelector('input').checked);
    const quick = multi ? 'range' : start.value === today ? '0' : start.value === addDays(today, 1) ? '1' : '';
    for (const b of el.querySelectorAll('[data-quick]')) b.classList.toggle('active', b.dataset.quick === quick);
    if (start.value) {
      const days = multi ? weekdays(start.value, end.value) : 1;
      summary.textContent = multi && end.value !== start.value
        ? `Del ${fmtLongDate(start.value)} al ${fmtLongDate(end.value)} · ${days} día(s) laborable(s)`
        : `${fmtLongDate(start.value)}${partial ? ' · parte del día' : ''}`;
    }
    const note = $('[data-closure-note]', el);
    note.textContent = start.value ? closureNote(closures, start.value, multi ? end.value : start.value) : '';
    note.hidden = !note.textContent;
  }

  for (const b of el.querySelectorAll('[data-quick]')) {
    b.addEventListener('click', () => {
      if (b.dataset.quick === 'range') {
        multi = true;
        form.querySelector('[name=partial][value="0"]').checked = true;
        if (end.value <= start.value) end.value = addDays(start.value, 1);
      } else {
        multi = false;
        start.value = addDays(today, Number(b.dataset.quick));
      }
      update();
    });
  }
  start.addEventListener('change', update);
  end.addEventListener('change', update);
  form.user_id?.addEventListener('change', () => {
    const notes = $('[data-coverage-notes]', el);
    notes.hidden = !needsCoverage(roleOf(form.user_id.value)) && !notes.querySelector('textarea').value.trim();
  });
  for (const r of form.querySelectorAll('[name=partial]')) r.addEventListener('change', update);
  update();

  // Files are kept in an array so people can take several photos one by one.
  const fileInput = form.querySelector('[type=file]');
  const list = $('[data-files]', el);
  function renderFiles() {
    list.innerHTML = String(html`${files.map(
      (f, i) => html`<li>${icon('file', 18)}<span>${f.name}</span><small>${fileSize(f.size)}</small>
        <button type="button" class="icon-btn" data-remove="${i}" aria-label="Quitar">${icon('x', 16)}</button></li>`,
    )}`);
    for (const btn of list.querySelectorAll('[data-remove]')) {
      btn.addEventListener('click', () => {
        files.splice(Number(btn.dataset.remove), 1);
        renderFiles();
      });
    }
  }
  fileInput?.addEventListener('change', () => {
    for (const f of fileInput.files) {
      if (files.length >= MAX_FILES) {
        toast(`Máximo ${MAX_FILES} archivos.`, 'error');
        break;
      }
      const problem = checkFile(f);
      if (problem) {
        toast(problem, 'error');
        continue;
      }
      files.push(f);
    }
    fileInput.value = '';
    renderFiles();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      if (onlyOthers && !v.user_id) throw new Error('Selecciona el empleado que va a faltar.');
      if (!v.start_date) throw new Error('Selecciona la fecha.');
      if (v.partial === '1' && !v.start_time) throw new Error('Indica desde qué hora vas a faltar.');
      if (!multi) v.end_date = null;
      if (editing) {
        await updateAbsence(absence.id, v);
        toast('Cambios guardados', 'ok');
        go(`/absence/${absence.id}`, { replace: true });
        return;
      }
      const id = await createAbsence(state.me, v, files);
      toast('Ausencia enviada. La dirección fue notificada.', 'ok');
      go(`/absence/${id}`, { replace: true });
    });
  });
}

// ---- Detalle ----------------------------------------------------------------

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const HISTORY_LABELS = { edited: 'Modificó la ausencia', cancelled: 'Canceló la ausencia', received: 'La marcó como recibida' };
// Cancelled absences are removed by the daily maintenance job after this many days.
const CANCELLED_KEEP_DAYS = 15;

function historySection(a, history) {
  if (!history.length) return '';
  return html`<section class="card stack">
    <h3 class="card-title">${icon('clock')} Historial</h3>
    <ol class="timeline">
      <li><strong>Reportada</strong> · ${a.created_by_name || a.employee_name}<small>${fmtDateTime(a.created_at)}</small></li>
      ${history.map(
        (h) => html`<li class="t-${h.action}">
          <strong>${HISTORY_LABELS[h.action] || h.action}</strong> · ${h.actor_name}<small>${fmtDateTime(h.created_at)}</small>
          ${h.changes?.length
            ? html`<ul class="changes">${h.changes.map(
                (c) => html`<li><b>${c.label}:</b> <del>${c.before || '—'}</del> <span aria-hidden="true">→</span> <ins>${c.after || '—'}</ins></li>`,
              )}</ul>`
            : ''}
          ${h.note ? html`<p class="pre">${h.action === 'cancelled' ? 'Motivo: ' : ''}${h.note}</p>` : ''}
        </li>`,
      )}
    </ol>
  </section>`;
}

// ---- Cobertura ------------------------------------------------------------

/** "Grupos 7-A, 7-B · Salón 204", or ''. */
export const coverWhere = (groups = [], room = '') =>
  [groups.length ? `${groups.length === 1 ? 'Grupo' : 'Grupos'} ${groups.join(', ')}` : '', room ? `Salón ${room}` : '']
    .filter(Boolean)
    .join(' · ');

/** "8:00 a. m. – 9:00 a. m.", or '' when it's the absence's hours. */
const coverHours = (start, end) => (start ? `${fmtTime(start)} – ${fmtTime(end)}` : '');

/** "lun 12 oct". */
const dayName = (d) => fmtDate(d).replace(/[,.]/g, '');

/** "lun 12 oct, mar 13 oct": the days of one row, or '' when it's every day of the absence. */
const coverDays = (days) => (days?.length ? days.map(dayName).join(', ') : '');

/** One row: "lun 12 oct · Grupo 7-A · 8:00 a. m. – 9:00 a. m. · Salón 204". */
const coverLine = (c) =>
  [coverDays(c.days), coverWhere(c.groups || []), coverHours(c.start_time, c.end_time), c.room ? `Salón ${c.room}` : '']
    .filter(Boolean)
    .join(' · ');

/** Who covers an absence, in order (an absence covered before the list existed has only the name). */
const coversOf = (a) =>
  a.covers?.length
    ? a.covers
    : a.substitute
      ? [{ substitute_id: a.substitute_id, name: a.substitute, groups: a.cover_groups || [], room: a.cover_room, days: [] }]
      : [];

/** Whether an answer (received_at, on_the_way_at) is from today, on this phone. */
const fromToday = (iso) => !!iso && todayStr(new Date(iso)) === todayStr();
/** "9:10 a. m." today, "12 oct, 9:10 a. m." another day. */
const answeredAt = (iso) => (fromToday(iso) ? fmtTime(new Date(iso)) : fmtDateTime(iso));

/**
 * What each person of the staff answered («Recibido», «Voy en camino» today): one line each. Rows assigned before
 * there were answers (without set_by) only show an answer they got.
 */
function coverReplies(a) {
  if (a.status === 'cancelled') return '';
  const people = new Map();
  for (const c of coversOf(a)) {
    if (c.substitute_id) people.set(c.substitute_id, [...(people.get(c.substitute_id) || []), c]);
  }
  return [...people.values()].map((rows) => {
    const { name } = rows[0];
    const way = rows.map((c) => c.on_the_way_at).filter(fromToday).sort().pop();
    const got = rows.map((c) => c.received_at).filter(Boolean).sort();
    if (way) return html`<p class="status-note ok" data-cover-reply>${icon('send', 16)} ${name} va en camino · ${answeredAt(way)}</p>`;
    if (got.length === rows.length) {
      return html`<p class="status-note ok" data-cover-reply>${icon('check', 16)} ${name} recibió el aviso · ${answeredAt(got.pop())}</p>`;
    }
    if (rows.some((c) => c.set_by) && a.end_date >= todayStr()) {
      return html`<p class="status-note warn" data-cover-reply>${icon('clock', 16)} ${name} ${got.length ? 'aún no confirma el cambio' : 'aún no confirma que lo recibió'}</p>`;
    }
    return '';
  });
}

/** The school days of an absence of more than one day, to choose who covers which ([] for a single day). */
function absenceDays(a) {
  if (a.partial || a.start_date === a.end_date) return [];
  const { school_days: schoolDays } = schoolCalendar(state.me.school);
  const days = [];
  for (let d = a.start_date; d <= a.end_date && days.length < 60; d = addDays(d, 1)) {
    if (schoolDays.includes(isoWeekday(d))) days.push(d);
  }
  return days;
}

/** The days of the absence nobody covers yet. */
const uncovered = (days, covers) => days.filter((d) => !covers.some((c) => !c.days?.length || c.days.includes(d)));

/** One row of who covers: who, which days (several days), their groups, their hours (optional) and the room (optional). */
function coverRow(c, ctx, preset = {}) {
  const { people, schoolGroups, theirs, days } = ctx;
  const others = schoolGroups.filter((g) => !theirs.includes(g));
  const external = !!c && !c.substitute_id;
  const chosen = new Set(c ? c.groups || [] : preset.groups || []);
  const on = new Set(c?.days?.length ? c.days : c ? days : preset.days || days);
  const chip = (g) => html`<label class="chip"><input type="checkbox" name="groups" value="${g}" ${chosen.has(g) ? 'checked' : ''}><span>${g}</span></label>`;
  const dayChip = (d) => html`<label class="chip"><input type="checkbox" name="days" value="${d}" ${on.has(d) ? 'checked' : ''}><span>${dayName(d)}</span></label>`;
  return html`<div class="cover-row stack" data-cover-row>
    <div class="cover-row-head">
      <label class="field grow"><span>¿Quién cubre?</span>
        <select name="who">
          <option value="">Elige a alguien…</option>
          ${people.map((e) => html`<option value="${e.id}" ${c?.substitute_id === e.id ? 'selected' : ''}>${e.full_name}${e.position ? ` · ${e.position}` : ''}</option>`)}
          <option value="other" ${external ? 'selected' : ''}>Otra persona (no usa la app)</option>
        </select>
      </label>
      <button type="button" class="icon-btn" data-remove-cover aria-label="Quitar a esta persona">${icon('x', 18)}</button>
    </div>
    <label class="field" data-external ${external ? '' : 'hidden'}><span>Nombre de quien cubre</span>
      <input name="name" maxlength="300" autocomplete="off" value="${external ? c.name : ''}" placeholder="Ej. Sra. Díaz (sustituta)"></label>
    <div class="stack" data-cover-where>
      ${days.length ? html`<div class="field"><span>Días que cubre</span><div class="chips">${days.map(dayChip)}</div></div>` : ''}
      ${schoolGroups.length
        ? html`<div class="field"><span>Grado y grupo</span>
            ${theirs.length ? html`<div class="chips">${theirs.map(chip)}</div>` : ''}
            ${others.length
              ? html`<details class="help" ${!theirs.length || others.some((g) => chosen.has(g)) ? 'open' : ''}>
                  <summary>${theirs.length ? 'Otros grupos' : 'Grupos de la escuela'}</summary>
                  <div class="chips">${others.map(chip)}</div>
                </details>`
              : ''}
          </div>`
        : ''}
      <div class="grid2">
        <label class="field"><span>Desde <em class="optional">opcional</em></span><input type="time" name="start" value="${c?.start_time || ''}"></label>
        <label class="field"><span>Hasta</span><input type="time" name="end" value="${c?.end_time || ''}"></label>
      </div>
      <label class="field"><span>Salón <em class="optional">opcional</em></span>
        <input name="room" maxlength="40" autocomplete="off" value="${c ? c.room || '' : preset.room || ''}" placeholder="Ej. 204"></label>
    </div>
  </div>`;
}

/**
 * Who covers: one or more people, each on every day of the absence or only some, with their hours. Secretaría
 * and the dirección choose each one from the staff (they get a notice with their days, groups, hours, room and
 * the instructions) or write the name of someone from outside; the rest, the absent person included, only see it.
 */
function coverageCard(a, { form, employees }) {
  const covers = coversOf(a);
  const missing = covers.length ? uncovered(absenceDays(a), covers) : [];
  const missingNote = (list) => html`<p class="status-note warn" data-cover-missing ${list.length ? '' : 'hidden'}>${icon('alert', 16)} <span>Sin cubrir: ${list.map(dayName).join(', ')}</span></p>`;
  if (!form) {
    return html`<section class="card stack">
      <h3 class="card-title">${icon('users')} Cobertura / arreglos</h3>
      ${covers.length
        ? html`<div class="list flat cover-list">${covers.map((c) => html`<div class="item">
            ${avatar(c.name)}
            <span class="item-main"><strong>${c.name}</strong>${coverLine(c) ? html`<span class="item-sub">${coverLine(c)}</span>` : ''}</span>
          </div>`)}</div>`
        : html`<p class="muted">Aún no se han registrado arreglos.</p>`}
      ${missing.length ? missingNote(missing) : ''}
      ${coverReplies(a)}
    </section>`;
  }
  const ctx = coverContext(a, employees);
  const told = [...new Set(covers.filter((c) => c.substitute_id).map((c) => c.name))];
  return html`<section class="card stack">
    <h3 class="card-title">${icon('users')} Cobertura / arreglos</h3>
    ${told.length
      ? html`<p class="status-note ok">${icon('check', 16)} Se le avisó a ${told.join(', ')}${a.cover_set_by_name ? ` · ${a.cover_set_by_name}, ${fmtDateTime(a.cover_set_at)}` : ''}</p>`
      : ''}
    ${coverReplies(a)}
    <form class="stack" data-coverage novalidate>
      <div class="stack" data-covers>${covers.length ? covers.map((c) => coverRow(c, ctx)) : coverRow(null, ctx, ctx.first)}</div>
      ${missingNote(missing)}
      <button type="button" class="btn btn-secondary btn-block" data-add-cover>${icon('plus', 18)} Añadir otra persona</button>
      <p class="hint">${ctx.days.length ? 'Para otro día u otro horario, añade otra persona (o la misma con otros días). ' : ''}Si dejas el horario vacío, cubre todo el horario de la ausencia.</p>
      <p class="hint" data-cover-hint></p>
      <button class="btn btn-primary btn-block" type="submit">Guardar</button>
    </form>
  </section>`;
}

function coverContext(a, employees) {
  const { groups: schoolGroups } = schoolCalendar(state.me.school);
  // The absent person's groups first; the first person gets them all, with their room.
  const theirs = (a.employee_groups || []).filter((g) => schoolGroups.includes(g));
  return {
    schoolGroups,
    theirs,
    days: absenceDays(a),
    people: employees.filter((e) => e.active && e.id !== a.user_id && e.role !== 'admin'),
    first: { groups: theirs, room: a.employee_room || '' },
  };
}

function bindCoverage(form, a, employees, reload) {
  const ctx = coverContext(a, employees);
  const before = coversOf(a);
  const first = a.employee_name.split(' ')[0];
  const list = $('[data-covers]', form);
  const rows = () => [...list.querySelectorAll('[data-cover-row]')];
  const who = (row) => row.querySelector('[name=who]').value;
  const isStaffRow = (row) => !!who(row) && who(row) !== 'other';
  // The days checked in a row ([] when the absence is a single day: every day).
  const daysOf = (row) => [...row.querySelectorAll('[name=days]:checked')].map((c) => c.value);
  const covered = () => rows().filter(who).map((row) => ({ days: ctx.days.length ? daysOf(row) : [] }));

  const update = () => {
    for (const row of rows()) row.querySelector('[data-external]').hidden = who(row) !== 'other';
    const staffRows = new Set(rows().filter(isStaffRow).map(who)).size;
    const outside = rows().some((r) => who(r) === 'other');
    $('[data-add-cover]', form).lastChild.textContent = rows().length ? ' Añadir otra persona' : ' Añadir quien cubre';
    form.querySelector('[type=submit]').textContent = staffRows ? 'Guardar y avisar' : 'Guardar';
    // The days nobody has yet (once someone was chosen).
    const missing = covered().length ? ctx.days.filter((d) => !covered().some((c) => c.days.includes(d))) : [];
    const note = $('[data-cover-missing]', form);
    note.hidden = !missing.length;
    note.lastElementChild.textContent = `Sin cubrir: ${missing.map(dayName).join(', ')}`;
    const told = before.filter((c) => c.substitute_id).length;
    $('[data-cover-hint]', form).textContent = [
      staffRows
        ? `${staffRows === 1 ? 'Le llega un aviso' : 'A cada uno le llega un aviso'} con sus días, su horario, su grupo, el salón y ${a.coverage_notes ? `las instrucciones que dejó ${first}` : `que ${first} no dejó instrucciones`}. No ven la causa de la ausencia.`
        : '',
      outside ? 'A quien no usa la app no le llega aviso: avísale tú.' : '',
      rows().some(who) ? `A ${first} no le llega aviso: lo ve en su ausencia.` : '',
      !rows().some(who) && before.length ? `Se quita la cobertura${told ? ' y les avisamos' : ''}.` : '',
    ].filter(Boolean).join(' ');
  };

  form.addEventListener('change', (e) => {
    if (e.target.name === 'who' || e.target.name === 'days') update();
  });
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove-cover]')) {
      e.target.closest('[data-cover-row]').remove();
      update();
    } else if (e.target.closest('[data-add-cover]')) {
      // The days nobody has yet with the absent person's groups; or, every day covered, their groups nobody has.
      const open = ctx.days.filter((d) => !covered().some((c) => c.days.includes(d)));
      const taken = new Set([...form.querySelectorAll('[name=groups]:checked')].map((c) => c.value));
      const preset = open.length && rows().some(who)
        ? { days: open, groups: ctx.theirs, room: ctx.first.room }
        : { days: ctx.days, groups: rows().length ? ctx.theirs.filter((g) => !taken.has(g)) : ctx.theirs, room: ctx.first.room };
      list.insertAdjacentHTML('beforeend', String(coverRow(null, ctx, preset)));
      update();
      list.lastElementChild.querySelector('[name=who]').focus();
    }
  });
  update();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const covers = [];
    const seen = new Map();
    for (const row of rows().filter(who)) {
      const id = who(row);
      const name = id === 'other' ? row.querySelector('[name=name]').value.trim() : row.querySelector('[name=who]').selectedOptions[0].textContent.split(' · ')[0];
      const start = row.querySelector('[name=start]').value;
      const end = row.querySelector('[name=end]').value;
      const picked = daysOf(row);
      // Every day checked: every day of the absence (so it stays covered if the absence gets longer).
      const days = picked.length === ctx.days.length ? [] : picked;
      const key = id === 'other' ? `name:${name.toLowerCase()}` : id;
      const earlier = seen.get(key) || [];
      let problem = '';
      if (id === 'other' && !name) problem = 'Escribe el nombre de quien cubre.';
      else if (ctx.days.length && !picked.length) problem = `Elige qué días cubre ${name}.`;
      else if (earlier.some((d) => !d.length || !days.length || d.some((x) => days.includes(x)))) problem = `${name} está dos veces el mismo día.`;
      else if (!start !== !end) problem = `Indica de qué hora a qué hora cubre ${name}.`;
      else if (start && end <= start) problem = `La hora final debe ser después de la inicial (${name}).`;
      if (problem) {
        row.scrollIntoView({ block: 'center' });
        toast(problem, 'error');
        return;
      }
      seen.set(key, [...earlier, days]);
      covers.push({
        substituteId: id === 'other' ? null : id,
        name: id === 'other' ? name : '',
        days,
        groups: [...row.querySelectorAll('[name=groups]:checked')].map((c) => c.value),
        room: row.querySelector('[name=room]').value.trim(),
        start,
        end,
        label: name,
      });
    }
    if (!covers.length && !before.length) {
      toast('Elige quién cubre.', 'error');
      return;
    }
    const told = [...new Set(covers.filter((c) => c.substituteId).map((c) => c.label))];
    busy(form.querySelector('[type=submit]'), async () => {
      await setCovers(a.id, covers);
      toast(
        !covers.length
          ? 'Cobertura quitada'
          : told.length
            ? `Cobertura guardada. ${told.length === 1 ? 'Le avisamos' : 'Les avisamos'} a ${told.join(' y ')}.`
            : 'Cobertura guardada',
        'ok',
      );
      await reload();
    });
  });
}

/** My rows of one coverage: their days ("lun 12 oct, mar 13 oct" or the absence's dates) and hours. */
const partWhen = (p) => coverDays(p.cover_days) || fmtRange(p.start_date, p.end_date);
const partHours = (p) => coverHours(p.cover_start_time, p.cover_end_time) || scheduleText(p);
/** Whether one of my rows has me covering that day. */
const coversDay = (p, day) => (p.cover_days?.length ? p.cover_days.includes(day) : p.start_date <= day && p.end_date >= day);

/** My coverages grouped by absence (I can have more than one row in the same absence). */
function byAbsence(list) {
  const groups = new Map();
  for (const p of list) groups.set(p.id, [...(groups.get(p.id) || []), p]);
  return [...groups.values()];
}

/** On Ausencias: whom I'm going to cover, from today on. */
export function coveringSection(list) {
  if (!list?.length) return '';
  const today = todayStr();
  const absences = byAbsence(list);
  return html`<section class="section" data-covering>
    <h3 class="section-title">Vas a cubrir <span class="count">${absences.length}</span></h3>
    <div class="list">${absences.map((parts) => {
      const c = parts[0];
      // Before the answers existed the rows don't bring them: nothing to confirm.
      const ask = 'received_at' in c && parts.some((p) => !p.received_at);
      return html`<a class="item" href="#/cover/${c.id}">
        ${avatar(c.employee_name)}
        <span class="item-main">
          <strong>${c.employee_name}</strong>
          ${parts.map((p) => {
            const where = coverWhere(p.cover_groups, p.cover_room);
            return html`<span class="item-sub">${partWhen(p)} · ${partHours(p)}</span>${where ? html`<span class="item-sub">${where}</span>` : ''}`;
          })}
          ${ask ? html`<span class="item-tags"><span class="tag tag-info">Sin confirmar</span></span>` : ''}
        </span>
        ${parts.some((p) => fromToday(p.on_the_way_at))
          ? html`<span class="tag tag-ok">En camino</span>`
          : parts.some((p) => coversDay(p, today)) ? html`<span class="tag tag-warn">Hoy</span>` : ''}
      </a>`;
    })}</div>
  </section>`;
}

/**
 * What the substitute needs: who, when, their days, groups, hours and room, the instructions and who else covers.
 * «Recibido» and, on a day they cover, «Voy en camino» reach whoever assigned it.
 */
export async function coverView({ el, params }) {
  const id = Number(params[0]);

  async function load() {
    const parts = await getCoverage(id);
    if (!parts.length) {
      el.innerHTML = String(html`<div class="card">${empty('users', 'Ya no tienes esta cobertura',
        'Se le asignó a otra persona o se quitó. Si tienes dudas, pregúntale a la secretaría o a la dirección.')}</div>`);
      return;
    }
    const c = parts[0];
    const today = todayStr();
    const first = c.employee_name.split(' ')[0];
    const range = c.start_date === c.end_date ? fmtLongDate(c.start_date) : `${fmtLongDate(c.start_date)} → ${fmtLongDate(c.end_date)}`;
    // A single row for every day of the absence: as always; otherwise each of my rows with its days.
    const simple = parts.length === 1 && !c.cover_days?.length;
    const hours = coverHours(c.cover_start_time, c.cover_end_time);
    const none = html`<span class="muted">No se indicó</span>`;
    const others = c.others || [];
    const lastDay = parts.map((p) => (p.cover_days?.length ? p.cover_days[p.cover_days.length - 1] : p.end_date)).sort().pop();
    const assigned = [...parts].sort((x, y) => String(y.cover_set_at).localeCompare(String(x.cover_set_at)))[0];
    const boss = assigned.cover_set_by_name || 'la secretaría o la dirección';
    // Before the answers existed the rows don't bring them: no buttons.
    const answers = 'received_at' in c && c.status !== 'cancelled' && lastDay >= today;
    const received = parts.every((p) => p.received_at);
    const todayParts = parts.filter((p) => coversDay(p, today));
    const way = todayParts.map((p) => p.on_the_way_at).filter(fromToday).sort().pop();
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card absence-head">
          <div class="row">
            ${avatar(c.employee_name, 'lg')}
            <div class="grow">
              <p class="muted">Cubres a</p>
              <h2>${c.employee_name}</h2>
              <p class="muted">${c.employee_position || roleLabel(c.employee_role)}</p>
            </div>
            ${c.status !== 'cancelled' && todayParts.length ? html`<span class="tag tag-warn">Hoy</span>` : ''}
          </div>
          <div class="when">
            ${icon('calendar')}
            <div><strong class="capitalize">${simple ? range : partWhen({ ...c, cover_days: parts.flatMap((p) => p.cover_days || []).sort() }) || range}</strong>
              <span>${simple ? (hours ? `Tu horario: ${hours}` : scheduleText(c)) : `Ausencia: ${fmtRange(c.start_date, c.end_date)}`}</span></div>
          </div>
          ${c.status === 'cancelled'
            ? html`<p class="status-note muted">${icon('x', 16)} Se canceló la ausencia: ya no tienes que cubrir.</p>`
            : lastDay < today ? html`<p class="status-note muted">${icon('check', 16)} Ya pasó.</p>` : ''}
        </section>
        ${answers
          ? html`<section class="card stack" data-cover-answer>
              ${received
                ? html`<p class="status-note ok">${icon('check', 16)} Le avisaste a ${boss} que la recibiste · ${answeredAt(parts.map((p) => p.received_at).sort().pop())}</p>`
                : html`<p>${parts.some((p) => p.received_at) ? `Cambió tu cobertura: avísale a ${boss} que lo viste.` : `Avísale a ${boss} que te llegó.`}</p>
                    <button type="button" class="btn btn-primary btn-block btn-lg" data-reply="received">${icon('check')} Recibido</button>`}
              ${way ? html`<p class="status-note ok">${icon('send', 16)} Le avisaste a ${boss} que vas en camino · ${answeredAt(way)}</p>` : ''}
              ${todayParts.length && !way
                ? html`<button type="button" class="btn ${received ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-reply="on_the_way">${icon('send')} Voy en camino</button>`
                : ''}
              ${todayParts.length ? '' : html`<p class="hint">El día que cubres, toca «Voy en camino» al salir hacia el salón.</p>`}
            </section>`
          : ''}
        <section class="card">
          <dl class="details">
            ${simple
              ? html`<div><dt>Grado y grupo</dt><dd>${c.cover_groups.length ? html`<span class="chips">${c.cover_groups.map((g) => html`<span class="tag">${g}</span>`)}</span>` : none}</dd></div>
                  <div><dt>Salón</dt><dd>${c.cover_room || none}</dd></div>`
              : html`<div><dt>Tus días</dt><dd data-parts>${parts.map((p) => html`<div>${partWhen(p)} · ${partHours(p)}${coverWhere(p.cover_groups, p.cover_room) ? html` <span class="muted">· ${coverWhere(p.cover_groups, p.cover_room)}</span>` : ''}</div>`)}</dd></div>`}
            <div><dt>Instrucciones de ${first}</dt><dd class="pre">${c.coverage_notes || html`<span class="muted">No dejó instrucciones.</span>`}</dd></div>
            ${others.length
              ? html`<div><dt>También cubren</dt><dd data-others>${others.map((o) => html`<div>${o.name}${coverLine(o) ? html` <span class="muted">· ${coverLine(o)}</span>` : ''}</div>`)}</dd></div>`
              : ''}
            ${assigned.cover_set_by_name ? html`<div><dt>Te la asignó</dt><dd>${assigned.cover_set_by_name} · ${fmtDateTime(assigned.cover_set_at)}</dd></div>` : ''}
          </dl>
        </section>
        <p class="hint">Si tienes dudas, pregúntale a la secretaría o a la dirección.</p>
      </div>`);

    for (const btn of el.querySelectorAll('[data-reply]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          const step = btn.dataset.reply;
          await replyCoverage(id, step, todayStr());
          toast(`Le avisamos a ${boss} que ${step === 'received' ? 'la recibiste' : 'vas en camino'}.`, 'ok');
          await load();
        }),
      );
    }
  }

  await load();
  markAlertsRead(`#/cover/${id}`).catch(() => {});
}

export async function absenceView({ el, params }) {
  const id = params[0];
  const me = state.me.user;
  const staff = isStaff(me);
  let data = await getAbsence(id);
  const employees = staff ? await listEmployees().catch(() => []) : [];

  const render = () => {
    const { absence: a, attachments, comments, history } = data;
    const mine = a.user_id === me.id;
    const cancelled = a.status === 'cancelled';
    const days = a.partial ? null : weekdays(a.start_date, a.end_date);
    const editable = canChange(a, me);
    const cancellation = [...history].reverse().find((h) => h.action === 'cancelled');
    const purgeDay = cancelled
      ? new Date(new Date(a.cancelled_at).getTime() + CANCELLED_KEEP_DAYS * 86_400_000).toLocaleDateString('es', {
          day: 'numeric',
          month: 'long',
        })
      : '';
    const range =
      a.start_date === a.end_date
        ? fmtLongDate(a.start_date)
        : `${fmtLongDate(a.start_date)} → ${fmtLongDate(a.end_date)}`;

    el.innerHTML = String(html`
      <div class="stack">
        <section class="card absence-head">
          <div class="row">
            ${avatar(a.employee_name, 'lg')}
            <div class="grow">
              <h2>${a.employee_name}</h2>
              <p class="muted">${a.employee_position || roleLabel(a.employee_role)}</p>
            </div>
            ${statusBadge(a.status)}
          </div>
          <div class="when">
            ${icon('calendar')}
            <div>
              <strong class="capitalize">${range}</strong>
              <span>${scheduleText(a)}${days && days > 1 ? ` · ${days} días laborables` : ''}</span>
            </div>
          </div>
          ${a.status === 'received'
            ? html`<p class="status-note ok">${icon('check', 16)} Recibida por ${a.received_by_name || 'la dirección'} · ${fmtDateTime(a.received_at)}</p>`
            : a.status === 'pending'
              ? html`<p class="status-note warn">${icon('clock', 16)} ${staff ? 'Pendiente de confirmar recibo' : 'Enviada · esperando que la dirección la confirme'}</p>`
              : html`<p class="status-note muted">${icon('x', 16)} Cancelada${cancellation ? ` por ${cancellation.actor_name}` : ''} · ${fmtDateTime(a.cancelled_at)}</p>
                ${cancellation?.note ? html`<p class="pre">Motivo: ${cancellation.note}</p>` : ''}
                <p class="hint">Se borrará automáticamente a partir del ${purgeDay}.</p>`}
        </section>

        <section class="card">
          <dl class="details">
            <div><dt>Tipo</dt><dd>${a.category ? CATEGORIES[a.category] : html`<span class="muted">No especificado</span>`}</dd></div>
            <div><dt>Causa</dt><dd class="pre">${a.reason || html`<span class="muted">No especificada</span>`}</dd></div>
            ${a.coverage_notes ? html`<div><dt>Instrucciones para cubrir</dt><dd class="pre">${a.coverage_notes}</dd></div>` : ''}
            <div><dt>Reportada</dt><dd>${fmtDateTime(a.created_at)}${a.created_by && a.created_by !== a.user_id ? ` · registrada por ${a.created_by_name}` : ''}</dd></div>
          </dl>
        </section>

        ${roleNeedsCoverage(a.employee_role) || a.substitute ? coverageCard(a, { form: staff && !cancelled, employees }) : ''}

        <section class="card stack">
          <h3 class="card-title">${icon('clip')} Documentos ${attachments.length ? html`<span class="count">${attachments.length}</span>` : ''}</h3>
          ${attachments.length
            ? html`<div class="attachments">${attachments.map(
                (f) => html`<div class="att">
                  <a href="${f.url || '#'}" target="_blank" rel="noopener" class="att-link">
                    ${IMAGE_MIME.includes(f.mime) && f.url
                      ? html`<img src="${f.url}" alt="" loading="lazy">`
                      : html`<span class="att-icon">${icon('file', 28)}</span>`}
                    <span class="att-name">${f.original_name}</span>
                    <small>${fileSize(f.size)} · ${f.uploaded_by_name || ''}</small>
                  </a>
                  ${f.uploaded_by === me.id || can(me, 'staff')
                    ? html`<button class="icon-btn att-del" data-del-att="${f.id}" aria-label="Eliminar archivo">${icon('trash', 16)}</button>`
                    : ''}
                </div>`,
              )}</div>`
            : html`<p class="muted">No hay documentos adjuntos.</p>`}
          ${!cancelled && (mine || staff)
            ? html`<label class="btn btn-secondary btn-block file-btn">
                ${icon('upload', 18)} Añadir documento
                <input type="file" multiple accept="${ACCEPT}" data-upload hidden>
              </label>`
            : ''}
        </section>

        <section class="card stack">
          <h3 class="card-title">${icon('chat')} Comentarios ${comments.length ? html`<span class="count">${comments.length}</span>` : ''}</h3>
          ${comments.length
            ? html`<div class="thread">${comments.map(
                (c) => html`<div class="bubble ${c.user_id === me.id ? 'mine' : ''}">
                  <div class="bubble-head"><strong>${c.author_name}</strong><span>${roleLabel(c.author_role)} · ${timeAgo(c.created_at)}</span></div>
                  <p class="pre">${c.body}</p>
                </div>`,
              )}</div>`
            : html`<p class="muted">${staff ? 'Deja un mensaje al empleado.' : 'Aquí verás los mensajes de la dirección.'}</p>`}
          <form class="comment-form" data-comment>
            <textarea name="body" rows="2" maxlength="2000" required
              placeholder="${staff && !mine ? 'Escribe un comentario para el empleado…' : 'Escribe un mensaje para la dirección…'}"></textarea>
            <button class="btn btn-primary" type="submit" aria-label="Enviar comentario">${icon('send', 18)}</button>
          </form>
        </section>

        ${historySection(a, history)}

        ${editable
          ? html`<div class="button-row split">
              <a class="btn btn-secondary" href="#/absence/${a.id}/edit">${icon('edit', 18)} Modificar</a>
              <button class="btn btn-ghost-danger" data-cancel>${icon('x', 18)} Cancelar ausencia</button>
            </div>`
          : ''}
      </div>
      ${staff && a.status === 'pending'
        ? html`<div class="action-bar"><button class="btn btn-primary btn-block btn-lg" data-receive>${icon('check')} Marcar como recibida</button></div>`
        : ''}`);
    bind();
  };

  const reload = async () => {
    data = await getAbsence(id);
    render();
  };

  function bind() {
    $('[data-receive]', el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const message = await dialog({
        title: 'Confirmar recibo',
        message: `${data.absence.employee_name} verá que su ausencia fue recibida.`,
        input: { label: 'Mensaje para el empleado (opcional)', placeholder: 'Ej.: Recibido, que te mejores. Ya tenemos sustituto.' },
        confirmText: 'Marcar como recibida',
      });
      if (message === null) return;
      await busy(btn, async () => {
        await receiveAbsence(id, message);
        toast('Ausencia marcada como recibida', 'ok');
        await reload();
      });
    });

    const coverage = $('[data-coverage]', el);
    if (coverage) bindCoverage(coverage, data.absence, employees, reload);

    const comment = $('[data-comment]', el);
    comment.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = comment.body.value.trim();
      if (!body) return;
      busy(comment.querySelector('button'), async () => {
        await addComment(id, body);
        await reload();
        $('.thread .bubble:last-child', el)?.scrollIntoView({ block: 'center' });
      });
    });

    $('[data-upload]', el)?.addEventListener('change', (e) => {
      const input = e.currentTarget;
      const chosen = [...input.files];
      input.value = '';
      const problem = chosen.map(checkFile).find(Boolean);
      if (problem) return toast(problem, 'error');
      if (!chosen.length) return;
      const label = input.closest('label');
      label.classList.add('is-busy');
      addAttachments(state.me, Number(id), chosen.slice(0, MAX_FILES))
        .then(async () => {
          toast('Documento añadido', 'ok');
          await reload();
        })
        .catch((err) => {
          toast(err.message, 'error');
          label.classList.remove('is-busy');
        });
    });

    for (const btn of el.querySelectorAll('[data-del-att]')) {
      btn.addEventListener('click', async () => {
        const ok = await dialog({ title: '¿Eliminar este archivo?', confirmText: 'Eliminar', danger: true });
        if (!ok) return;
        await busy(btn, async () => {
          await deleteAttachment(Number(btn.dataset.delAtt));
          await reload();
        });
      });
    }

    $('[data-cancel]', el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const own = data.absence.user_id === me.id;
      const answer = await dialog({
        title: '¿Por qué la cancelas?',
        message: 'La dirección recibirá un aviso con el motivo (también por Teams).',
        body: html`<div class="choices">
            <label class="choice"><input type="radio" name="reason" value="no_absence" required>
              <span>${own ? 'Ya no voy a faltar' : 'Ya no va a faltar'}</span></label>
            <label class="choice"><input type="radio" name="reason" value="error">
              <span>${own ? 'La registré por error' : 'Se registró por error'}</span></label>
            <label class="choice"><input type="radio" name="reason" value="wrong_date">
              <span>La fecha o la hora están mal<small>No hace falta cancelarla: corrígela y el cambio queda en el historial.</small></span></label>
            <label class="choice"><input type="radio" name="reason" value="other"><span>Otra razón</span></label>
          </div>
          <label class="field" data-note><span>Detalles <em class="optional" data-optional>opcional</em></span>
            <textarea name="note" rows="2" maxlength="450"></textarea></label>`,
        collect: true,
        confirmText: 'Cancelar ausencia',
        cancelText: 'Volver',
        danger: true,
        onOpen(dlg) {
          const note = dlg.querySelector('[name=note]');
          const submit = dlg.querySelector('[type=submit]');
          for (const radio of dlg.querySelectorAll('[name=reason]')) {
            radio.addEventListener('change', () => {
              const fix = radio.value === 'wrong_date';
              note.required = radio.value === 'other';
              dlg.querySelector('[data-optional]').hidden = note.required;
              dlg.querySelector('[data-note]').hidden = fix;
              submit.textContent = fix ? 'Corregir fecha u hora' : 'Cancelar ausencia';
              submit.className = `btn ${fix ? 'btn-primary' : 'btn-danger'}`;
            });
          }
        },
      });
      if (!answer) return;
      if (answer.reason === 'wrong_date') {
        go(`/absence/${id}/edit`);
        return;
      }
      await busy(btn, async () => {
        await cancelAbsence(id, answer.reason, answer.note);
        toast('Ausencia cancelada', 'ok');
        await reload();
      });
    });
  }

  render();
}
