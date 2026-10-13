// Turnos: Enfermería, Trabajo Social and other services. A teacher asks for a turn for a student and follows it;
// the service sees its queue (most serious first), calls the student or goes to the room and marks each step.
// Teachers see the turns of their groups for 24 hours, without the reason; the service keeps its own history.
import {
  advanceTurn,
  getTurn,
  listTurns,
  listVisits,
  markAlertsRead,
  noteTurnResolution,
  requestService,
  saveService,
  servicesOverview,
  setMyServiceStatus,
  turnHistory,
} from '../backend.js';
import { $, busy, dialog, fmtDateTime, fmtTime, getSchoolRoles, html, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { empty } from './common.js';
import { confirmStudent, fact, keepFresh, studentFields, studentFrom } from './students.js';
import { bindVisits, visitsSection } from './visits.js';

export const SEVERITY = {
  1: { label: 'Baja', cls: '' },
  2: { label: 'Media', cls: 'tag-info' },
  3: { label: 'Alta', cls: 'tag-warn' },
  4: { label: 'Urgente', cls: 'tag-danger' },
};

export const STAFF_STATUS = { available: 'Disponible', meeting: 'En reunión', lunch: 'Almuerzo', away: 'Fuera' };

export const OUTCOMES = {
  returned: 'Regresó al salón',
  picked_up: 'Lo recogieron',
  referred: 'Referido',
  attended: 'Atendido',
  cancelled: 'Cancelado',
  expired: 'Nadie lo cerró',
  unconfirmed: 'Regreso sin confirmar',
};

// Support services (Soporte IT): the help is for whoever asks, not for a student.
export const SUPPORT_OUTCOMES = { attended: 'Resuelto', referred: 'Necesita seguimiento' };

const OPEN = ['waiting', 'called', 'sent', 'arrived', 'on_the_way', 'returning'];
const isOpen = (t) => OPEN.includes(t.status);
const isSupport = (t) => t.service_mode === 'support';
/** What a support request is about: its reason ("Proyector o pantalla"). */
const supportTitle = (t) => t.reason || 'Pedido de ayuda';
/** Where help is needed, as typed: "204" → "Salón 204"; "Biblioteca" stays. */
const placeText = (room) => (room ? (/^\d/.test(room) ? `Salón ${room}` : room) : null);
const outcomeLabel = (t) => (isSupport(t) && SUPPORT_OUTCOMES[t.outcome]) || OUTCOMES[t.outcome] || 'Terminado';
const who = (t) => (isSupport(t) ? `${supportTitle(t)}${t.room ? ` (${t.room})` : ''}` : `${t.student_name} (${t.group_name})`);
// The group doesn't break at its hyphen.
const whoHtml = (t) => (isSupport(t) ? html`${supportTitle(t)}` : html`${t.student_name} <span class="nowrap">(${t.group_name})</span>`);
const timeOf = (iso) => fmtTime(new Date(iso));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// With a time to get there: to the service (it starts with «Ya salió»), or back to class.
const TIMED = ['sent', 'returning'];
const pastDue = (t) => !!t.due_at && Date.now() > new Date(t.due_at);

/** Past the time to get to the service, or back to class. */
const isLate = (t) =>
  (['called', 'sent'].includes(t.status) && (!!t.late_at || pastDue(t))) || (t.status === 'returning' && (!!t.return_late_at || pastDue(t)));

/** The teacher who asked, has the student now, or teaches the group. */
const teacherSide = (t, me) => t.created_by === me.id || t.teacher_id === me.id || (me.groups || []).includes(t.group_name);

function statusTag(t) {
  if (isLate(t)) return { label: t.status === 'returning' ? 'No ha llegado al salón' : `No ha llegado a ${t.service_name}`, cls: 'tag-danger' };
  const open = {
    waiting: { label: t.position ? `En fila · turno ${t.position}` : 'En fila', cls: '' },
    called: { label: 'Lo llamaron', cls: 'tag-warn' },
    sent: { label: `Va a ${t.service_name}`, cls: 'tag-warn' },
    arrived: { label: `En ${t.service_name}`, cls: 'tag-ok' },
    on_the_way: { label: `${t.service_name} va ${isSupport(t) ? 'en camino' : 'al salón'}`, cls: 'tag-warn' },
    returning: { label: 'Regresa al salón', cls: 'tag-warn' },
  }[t.status];
  if (open) return open;
  if (t.status === 'cancelled') return { label: 'Cancelado', cls: '' };
  if (t.outcome === 'unconfirmed') return { label: OUTCOMES.unconfirmed, cls: 'tag-warn' };
  if (isSupport(t) && t.outcome === 'referred') return { label: outcomeLabel(t), cls: 'tag-warn' };
  return { label: outcomeLabel(t), cls: t.outcome === 'expired' ? '' : 'tag-ok' };
}

/** "Quedan 3:12" or "Atrasado 2 min". */
function countdown(dueAt) {
  const secs = Math.round((new Date(dueAt) - Date.now()) / 1000);
  if (secs <= 0) return `Atrasado ${Math.max(1, Math.round(-secs / 60))} min`;
  return `Quedan ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** The countdowns on screen tick every second. */
function tickCountdowns(ctx) {
  const timer = setInterval(() => {
    for (const el of ctx.el.querySelectorAll('[data-due]')) {
      el.textContent = countdown(el.dataset.due);
      el.classList.toggle('is-late', new Date(el.dataset.due) < Date.now());
    }
  }, 1000);
  ctx.onLeave(() => clearInterval(timer));
}

/** Whether someone of the service is available, or when they're back. */
function availability(service) {
  const staff = service.staff || [];
  if (!staff.length) return { text: 'Nadie asignado', ok: false };
  if (staff.some((p) => p.status === 'available')) return { text: 'Disponible', ok: true };
  const next = [...staff].sort((a, b) => String(a.until || '~').localeCompare(String(b.until || '~')))[0];
  return { text: `${STAFF_STATUS[next.status] || 'No disponible'}${next.until ? ` hasta ${timeOf(next.until)}` : ''}`, ok: false };
}

function availabilityText(service) {
  const a = availability(service);
  return `${a.text}${service.waiting ? ` · ${service.waiting} en fila` : ''}`;
}

/** "HH:MM" today → ISO. */
function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// ---- Steps ---------------------------------------------------------------------------------

const STEP_DONE = {
  call: 'Llamado. Le avisamos al maestro.',
  go: 'Le avisamos al maestro que vas.',
  sent: 'Listo. Corre el tiempo para que llegue.',
  arrived: 'Llegada anotada.',
  return: 'Le avisamos al maestro que regresa.',
  back: 'Turno terminado.',
  finish: 'Turno terminado.',
  cancel: 'Turno cancelado.',
  take: 'Ahora los avisos de este turno te llegan a ti.',
};

const FINISH_ASK = {
  picked_up: ['¿Lo recogieron?', 'El maestro sabrá que no regresa al salón.'],
  referred: ['¿Marcar como referido?', 'Se cierra el turno y se le avisa al maestro.'],
  attended: ['¿Ya lo atendiste?', 'Se cierra el turno y se le avisa al maestro.'],
};
const SUPPORT_ASK = {
  attended: ['¿Ya quedó resuelto?', 'Se cierra el pedido y se le avisa a quien lo pidió.'],
  referred: ['¿Necesita seguimiento?', 'Se cierra como pendiente (una pieza, un técnico de fuera…) y se le avisa a quien lo pidió.'],
};
const SUPPORT_DONE = { go: 'Le avisamos que vas en camino.', finish: 'Pedido cerrado.', cancel: 'Pedido cancelado.' };

/** What the service did, for the panel and the Excel (support). Resolves null if cancelled. */
function askResolution(t, current = '') {
  return dialog({
    title: '¿Qué se hizo?',
    message: who(t),
    body: html`<label class="field"><span>Lo que se hizo <em class="optional">opcional</em></span>
      <textarea name="resolution" rows="3" maxlength="300" placeholder="Ej. Se cambió el cable HDMI">${current}</textarea></label>`,
    confirmText: 'Guardar',
    collect: true,
  });
}

/** Asks what needs asking (out of order, outcome, cancel, room) and does the step. Resolves false if cancelled. */
async function doStep(t, step, value) {
  if (isSupport(t) && step === 'finish') {
    const [title, message] = SUPPORT_ASK[value];
    const v = await dialog({
      title,
      message: `${who(t)}. ${message}`,
      body: html`<label class="field"><span>¿Qué se hizo? <em class="optional">opcional</em></span>
        <textarea name="resolution" rows="3" maxlength="300" placeholder="Ej. Se cambió el cable HDMI"></textarea></label>`,
      confirmText: SUPPORT_OUTCOMES[value],
      cancelText: 'Volver',
      collect: true,
    });
    if (!v) return false;
    await advanceTurn(t.id, step, value);
    if (v.resolution.trim()) await noteTurnResolution(t.id, v.resolution.trim());
    toast(SUPPORT_DONE.finish, 'ok');
    return true;
  }
  if ((step === 'call' || step === 'go') && t.position > 1) {
    const ok = await dialog({
      title: isSupport(t) ? `¿Atender «${supportTitle(t)}» primero?` : `¿${step === 'call' ? 'Llamar' : 'Atender'} a ${t.student_name}?`,
      message: `Hay ${plural(t.position - 1, 'turno', 'turnos')} antes en la fila. Se anota que lo escogiste antes.`,
      confirmText: step === 'call' ? 'Llamar' : 'Voy en camino',
      cancelText: 'Volver',
    });
    if (!ok) return false;
  }
  if (step === 'finish') {
    const [title, message] = FINISH_ASK[value];
    if (!(await dialog({ title, message: `${who(t)}. ${message}`, confirmText: OUTCOMES[value], cancelText: 'Volver' }))) return false;
  }
  if (step === 'cancel') {
    const what = isSupport(t) ? 'pedido' : 'turno';
    const ok = await dialog({ title: `¿Cancelar este ${what}?`, message: who(t), confirmText: `Cancelar ${what}`, cancelText: 'Volver', danger: true });
    if (!ok) return false;
  }
  if (step === 'take') {
    const v = await dialog({
      title: `¿${t.student_name} está contigo?`,
      message: t.status === 'on_the_way'
        ? `${t.service_name} va en camino: le avisamos en qué salón está.`
        : `Los avisos de este turno de ${t.service_name} te llegarán a ti.`,
      body: html`<label class="field"><span>¿En qué salón?</span>
        <input name="room" maxlength="40" value="${state.me.user.room || ''}" placeholder="Ej. 204" autocomplete="off"></label>`,
      confirmText: 'Está conmigo',
      collect: true,
    });
    if (!v) return false;
    value = v.room.trim();
  }
  await advanceTurn(t.id, step, value);
  toast((isSupport(t) && SUPPORT_DONE[step]) || STEP_DONE[step], 'ok');
  return true;
}

/** What this person can do now with the turn: [{ step, value, label, kind }]. */
function turnActions(t, service, me) {
  const out = [];
  const add = (step, label, kind = 'secondary', value = null) => {
    if (!out.some((a) => a.step === step && a.value === value)) out.push({ step, value, label, kind });
  };
  if (!isOpen(t)) return out;
  const teacher = teacherSide(t, me);
  if (service.serves && t.service_mode === 'visit') {
    if (t.status === 'waiting') add('call', 'Llamar', 'primary');
    if (['called', 'sent'].includes(t.status)) add('arrived', 'Llegó', 'primary');
    if (t.status === 'waiting') add('arrived', 'Ya está aquí');
    if (t.status === 'arrived') {
      add('return', 'Regresa al salón', 'primary');
      add('finish', 'Lo recogieron', 'secondary', 'picked_up');
      add('finish', 'Referido', 'secondary', 'referred');
    }
  }
  if (service.serves && t.service_mode === 'room') {
    if (t.status === 'waiting') add('go', 'Voy en camino', 'primary');
    if (t.status === 'on_the_way') add('finish', 'Atendido', 'primary', 'attended');
    if (t.status === 'waiting') add('finish', 'Ya lo atendí', 'secondary', 'attended');
    if (t.status === 'on_the_way') add('finish', 'Referido', 'secondary', 'referred');
  }
  if (service.serves && isSupport(t)) {
    if (t.status === 'waiting') add('go', 'Voy en camino', 'primary');
    if (t.status === 'on_the_way') add('finish', 'Resuelto', 'primary', 'attended');
    if (t.status === 'waiting') add('finish', 'Ya lo resolví', 'secondary', 'attended');
    add('finish', 'Necesita seguimiento', 'secondary', 'referred');
  }
  if (teacher && !isSupport(t)) {
    if (t.status === 'called') add('sent', 'Ya salió', 'primary');
    if (t.status === 'returning') add('back', 'Llegó al salón', 'primary');
    if (['waiting', 'called', 'on_the_way', 'returning'].includes(t.status) && t.teacher_id !== me.id && !service.serves) add('take', 'Está conmigo');
  }
  if (service.serves && t.status === 'returning') add('back', 'Llegó al salón');
  const mine = t.created_by === me.id || t.teacher_id === me.id;
  if (service.serves || (mine && ['waiting', 'called'].includes(t.status))) add('cancel', isSupport(t) ? 'Cancelar pedido' : 'Cancelar turno', 'ghost-danger');
  return out;
}

const ICONS = { call: 'bell', go: 'send', sent: 'send', arrived: 'check', return: 'back', back: 'check', finish: 'check', take: 'user' };
// In the lists the button sits next to the student, so it says less.
const SHORT = { go: 'Voy', return: 'Regresa', back: 'Llegó' };

function actionButton(a, size = 'block') {
  const cls = {
    primary: size === 'sm' ? 'btn-primary btn-sm' : 'btn-primary btn-block btn-lg',
    secondary: size === 'sm' ? 'btn-secondary btn-sm' : 'btn-secondary btn-block',
    'ghost-danger': 'btn-ghost-danger btn-block',
  }[a.kind];
  return html`<button type="button" class="btn ${cls}" data-step="${a.step}" data-value="${a.value || ''}">
    ${size === 'sm' || !ICONS[a.step] ? '' : icon(ICONS[a.step])} ${size === 'sm' ? SHORT[a.step] || a.label : a.label}</button>`;
}

function bindSteps(root, turns, reload) {
  for (const btn of root.querySelectorAll('[data-step]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const t = turns.find((x) => x.id === Number(btn.closest('[data-turn]').dataset.turn));
      busy(btn, async () => {
        if (await doStep(t, btn.dataset.step, btn.dataset.value || null)) await reload();
      });
    });
  }
}

// ---- Lists ---------------------------------------------------------------------------------

/** A turn in the service's queue, with its next step at hand. */
function queueItem(t, me, service) {
  const sev = SEVERITY[t.severity];
  const late = isLate(t);
  const s = statusTag(t);
  const next = turnActions(t, service, me).find((a) => a.kind === 'primary');
  return html`<div class="item alert-item ${late || t.severity === 4 ? 'is-urgent' : ''}" data-turn="${t.id}">
    <a class="item-link" href="#/turns/${t.id}">
      ${t.status === 'waiting'
        ? html`<span class="item-icon queue-num" title="Turno ${t.position}">${t.position}</span>`
        : html`<span class="item-icon ${late ? 'is-danger' : ''}">${icon('pulse')}</span>`}
      <span class="item-main">
        <strong>${whoHtml(t)}</strong>
        <span class="item-sub">${(isSupport(t)
          ? [placeText(t.room), `pidió ${t.created_by_name}`, t.note]
          : [t.reason, t.room ? `Salón ${t.room}` : null, `pidió ${t.created_by_name}`]
        ).filter(Boolean).join(' · ')}</span>
        <span class="item-tags">
          <span class="tag ${sev.cls}">${sev.label}</span>
          ${t.status === 'waiting'
            ? html`<span class="tag">${icon('clock', 14)} ${timeAgo(t.created_at)}</span>
                ${t.level > t.severity ? html`<span class="tag">Sube por la espera</span>` : ''}`
            : html`<span class="tag ${s.cls}">${s.label}</span>`}
          ${t.status === 'called' && t.called_at ? html`<span class="tag">${icon('clock', 14)} ${timeAgo(t.called_at)}</span>` : ''}
          ${TIMED.includes(t.status) && t.due_at ? html`<span class="tag" data-due="${t.due_at}">${countdown(t.due_at)}</span>` : ''}
        </span>
      </span>
    </a>
    ${next ? actionButton(next, 'sm') : ''}
  </div>`;
}

/** A turn of one of my students (teacher side). */
function studentTurnItem(t, me) {
  const s = statusTag(t);
  const next = turnActions(t, { serves: false }, me).find((a) => a.kind === 'primary');
  const late = isLate(t);
  return html`<div class="item alert-item ${late || t.status === 'called' ? 'is-urgent' : ''} ${isOpen(t) ? '' : 'is-muted'}" data-turn="${t.id}">
    <a class="item-link" href="#/turns/${t.id}">
      <span class="item-icon ${late ? 'is-danger' : ''}">${icon('pulse')}</span>
      <span class="item-main">
        <strong>${whoHtml(t)}</strong>
        <span class="item-sub">${[t.service_name, t.reason, t.teacher_name && t.teacher_id !== me.id ? `está con ${t.teacher_name}` : null]
          .filter(Boolean)
          .join(' · ')}</span>
        <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span>
          ${t.status === 'called' && t.called_at ? html`<span class="tag">${icon('clock', 14)} ${timeAgo(t.called_at)}</span>` : ''}
          ${TIMED.includes(t.status) && t.due_at ? html`<span class="tag" data-due="${t.due_at}">${countdown(t.due_at)}</span>` : ''}</span>
      </span>
    </a>
    ${next ? actionButton(next, 'sm') : ''}
  </div>`;
}

/** A support request (Soporte IT): what, where and how it's going; for whoever asked, or in the service's list. */
function supportItem(t, { serving = false } = {}) {
  const s = statusTag(t);
  const sub = [placeText(t.room), serving ? `pidió ${t.created_by_name}` : null,
    t.handled_by_name && t.status !== 'waiting' ? `atiende ${t.handled_by_name}` : null];
  return html`<div class="item alert-item ${isOpen(t) ? '' : 'is-muted'}" data-turn="${t.id}">
    <a class="item-link" href="#/turns/${t.id}">
      <span class="item-icon">${icon('wrench')}</span>
      <span class="item-main">
        <strong>${serving ? supportTitle(t) : `${t.service_name}: ${supportTitle(t)}`}</strong>
        <span class="item-sub">${sub.filter(Boolean).join(' · ')}</span>
        <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span>
          ${t.status === 'waiting' ? html`<span class="tag">${icon('clock', 14)} ${timeAgo(t.created_at)}</span>` : ''}</span>
      </span>
    </a>
  </div>`;
}

function statusCard(me, myServices) {
  const mine = myServices.flatMap((s) => s.staff || []).find((p) => p.id === me.id) || { status: 'available' };
  return html`<section class="card stack">
    <h2 class="card-title">${icon('user')} Tu estado</h2>
    <div class="chips" data-staff-status>
      ${Object.entries(STAFF_STATUS).map(
        ([key, label]) => html`<label class="chip"><input type="radio" name="staff-status" value="${key}" ${mine.status === key ? 'checked' : ''}>
          <span>${key === 'away' ? 'Fuera hasta…' : label}</span></label>`,
      )}
    </div>
    <p class="hint">${mine.status === 'available'
      ? 'Los maestros ven si estás disponible cuando piden un turno.'
      : `Los maestros ven: ${STAFF_STATUS[mine.status]}${mine.until ? ` hasta ${timeOf(mine.until)}` : '.'}`}</p>
  </section>`;
}

async function askStatus(status) {
  if (status === 'available') return setMyServiceStatus('available');
  return dialog({
    title: STAFF_STATUS[status],
    message: status === 'away' ? '¿Hasta qué hora estarás fuera?' : '¿Hasta qué hora? Si no lo sabes, déjalo en blanco.',
    body: html`<label class="field"><span>Hasta ${status === 'away' ? '' : html`<em class="optional">opcional</em>`}</span>
      <input type="time" name="until" ${status === 'away' ? 'required' : ''}></label>`,
    confirmText: 'Guardar',
    onSubmit: (v) => {
      if (status === 'away' && !v.until) throw new Error('Elige la hora.');
      return setMyServiceStatus(status, v.until ? todayAt(v.until) : null);
    },
  });
}

export async function turnsView(ctx) {
  const { el, isCurrent } = ctx;
  const me = state.me.user;
  let data = null;
  let showDone = false;

  const render = () => {
    const { services, turns, visits } = data;
    const myServices = services.filter((s) => s.serves);
    const myIds = new Set(myServices.map((s) => s.id));
    const toRequest = services.filter((s) => s.active && !s.serves);
    const others = turns.filter((t) => !myIds.has(t.service_id));
    // Help I asked for (Soporte IT), and my students' turns.
    const myRequests = [...others.filter((t) => isSupport(t) && isOpen(t)), ...others.filter((t) => isSupport(t) && !isOpen(t)).reverse()];
    const students = others.filter((t) => !isSupport(t));
    // What the teacher has to do first: send the student, receive them back.
    const firstFor = (t) => (isLate(t) ? -1 : { called: 0, returning: 1, sent: 2, on_the_way: 3, arrived: 4 }[t.status] ?? 5);
    const studentsOpen = students.filter(isOpen).sort((a, b) => firstFor(a) - firstFor(b) || a.created_at.localeCompare(b.created_at));
    const studentsDone = students.filter((t) => !isOpen(t));
    const doneToday = turns.filter((t) => myIds.has(t.service_id) && !isOpen(t)).reverse();

    el.innerHTML = String(html`
      <div class="stack">
        ${myServices.length ? statusCard(me, myServices) : ''}

        ${visitsSection(visits, me)}

        ${myServices.map((service) => {
          const own = turns.filter((t) => t.service_id === service.id);
          const waiting = own.filter((t) => t.status === 'waiting').sort((a, b) => a.position - b.position);
          const active = own.filter((t) => isOpen(t) && t.status !== 'waiting');
          return html`<section class="section" data-service="${service.id}">
            <h3 class="section-title">${service.name} <span class="count ${waiting.length ? 'warn' : ''}">${waiting.length} en fila</span></h3>
            ${active.length ? html`<div class="list">${active.map((t) => queueItem(t, me, service))}</div>` : ''}
            ${waiting.length
              ? html`<div class="list">${waiting.map((t) => queueItem(t, me, service))}</div>`
              : html`<p class="hint">No hay nadie en fila${active.length ? '' : ' ni en curso'}.</p>`}
            <div class="button-row">
              ${service.mode === 'visit'
                ? html`<a class="btn btn-ghost btn-sm" href="#/turns/new?service=${service.id}&here=1">${icon('plus', 18)} Llegó sin turno</a>`
                : ''}
              <a class="btn btn-ghost btn-sm" href="#/turns/panel/${service.id}">${icon('chart', 18)} Panel y Excel</a>
            </div>
          </section>`;
        })}

        ${toRequest.length
          ? html`<section class="section">
              <h3 class="section-title">Pedir turno</h3>
              <div class="alert-actions">
                ${toRequest.map((s) => {
                  const a = availability(s);
                  return html`<a class="alert-action" href="#/turns/new?service=${s.id}">${icon(s.mode === 'support' ? 'wrench' : 'pulse', 26)}<strong>${s.name}</strong>
                    <small class="${a.ok ? '' : 'is-off'}">${availabilityText(s)}</small></a>`;
                })}
              </div>
            </section>`
          : ''}

        ${myRequests.length
          ? html`<section class="section" data-my-requests>
              <h3 class="section-title">Tus pedidos</h3>
              <div class="list">${myRequests.map((t) => supportItem(t))}</div>
            </section>`
          : ''}

        ${studentsOpen.length || studentsDone.length
          ? html`<section class="section">
              <h3 class="section-title">Turnos de tus estudiantes</h3>
              <div class="list">${[...studentsOpen, ...studentsDone].map((t) => studentTurnItem(t, me))}</div>
            </section>`
          : ''}

        ${!services.length ? html`<div class="card">${empty('pulse', 'No hay servicios', 'La dirección todavía no activó Enfermería ni Trabajo Social.')}</div>` : ''}
        ${services.length && !myServices.length && !students.length && !myRequests.length
          ? html`<p class="hint">Aquí verás los turnos que pidas y los de los estudiantes de tus grupos. Te avisamos cuando los llamen.</p>`
          : ''}

        ${doneToday.length
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-done>${showDone ? 'Ocultar' : 'Ver'} los atendidos hoy (${doneToday.length})</button>
            ${showDone ? html`<div class="list">${doneToday.map((t) => (isSupport(t) ? supportItem(t, { serving: true }) : studentTurnItem(t, me)))}</div>` : ''}`
          : ''}

        <p class="hint">${myServices.length
          ? 'La fila va por gravedad y, dentro de cada nivel, por orden de llegada. Cada 30 minutos de espera un turno sube un nivel. Solo tu servicio ve el motivo y el historial.'
          : 'El motivo y la nota solo los ven tú y el servicio. Los otros maestros del grupo ven cómo va el turno. Los nombres se borran de tu lista a las 24 horas.'}</p>
      </div>`);

    for (const input of el.querySelectorAll('[name=staff-status]')) {
      input.addEventListener('change', async () => {
        try {
          const saved = await askStatus(input.value);
          if (saved) toast('Estado actualizado', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        await load();
      });
    }
    $('[data-done]', el)?.addEventListener('click', () => {
      showDone = !showDone;
      render();
    });
    bindSteps(el, turns, load);
    bindVisits(el, visits, load);
  };

  async function load() {
    const [services, turns, visits] = await Promise.all([servicesOverview(), listTurns(), listVisits()]);
    if (!isCurrent()) return;
    data = { services, turns, visits };
    render();
  }

  await load();
  // Seen: stops the repeated pushes of the turns for me.
  markAlertsRead('#/turns').catch(() => {});
  keepFresh(ctx, load);
  tickCountdowns(ctx);
}

// ---- New turn ------------------------------------------------------------------------------

export async function newTurnView(ctx) {
  const { el, query } = ctx;
  const me = state.me.user;
  const services = (await servicesOverview()).filter((s) => s.active);
  if (!services.length) {
    el.innerHTML = String(html`<div class="card">${empty('pulse', 'No hay servicios', 'La dirección todavía no activó Enfermería ni Trabajo Social.')}</div>`);
    return;
  }
  let service = services.find((s) => s.id === Number(query.get('service'))) || (services.length === 1 ? services[0] : null);
  // The professional notes a student who came on their own.
  const here = query.get('here') === '1' && !!service?.serves && service.mode === 'visit';
  if (here) ctx.setTitle('Llegó sin turno');
  // Already chosen on Turnos (or the only one): don't ask again, just show it. To change it, go back.
  const chosen = !here && !!service;
  const modeText = (s) => ({ visit: 'El estudiante va a la oficina', room: 'Va al salón', support: 'Ayuda para ti o tu salón' }[s.mode]);
  const support = () => service?.mode === 'support';

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      ${here
        ? html`<p class="status-note ok">${icon('check', 16)} ${service.name}: el estudiante ya está en la oficina.</p>`
        : html`${chosen
            ? html`<section class="card stack" data-chosen>
                <h2 class="card-title">${icon(support() ? 'wrench' : 'pulse')} Turno para ${service.name}</h2>
                <p class="hint">${modeText(service)} · ${availabilityText(service)}</p>
              </section>`
            : html`<section class="card stack" data-pick-service>
                <h2 class="card-title">${icon('pulse')} ¿A qué servicio?</h2>
                <div class="choices">
                  ${services.map(
                    (s) => html`<label class="choice"><input type="radio" name="service" value="${s.id}">
                      <span><strong>${s.name}</strong><small>${modeText(s)} · ${availabilityText(s)}</small></span></label>`,
                  )}
                </div>
              </section>`}`}
      <section class="card stack" data-student>
        <h2 class="card-title">${icon('user')} ¿Para quién?</h2>
        ${studentFields()}
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('alert')} ¿Qué tan grave es?</h2>
        <div class="chips sev-chips" role="radiogroup" aria-label="Gravedad">
          ${[1, 2, 3, 4].map(
            (n) => html`<label class="chip sev-${n}"><input type="radio" name="severity" value="${n}"><span>${SEVERITY[n].label}</span></label>`,
          )}
        </div>
        <p class="hint" data-sev-hint>Urgente le llega con alarma al servicio y pasa primero en la fila.</p>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('chat')} <span data-reason-title>Motivo</span></h2>
        <div class="chips" role="radiogroup" aria-label="Motivo" data-reasons></div>
        <label class="field"><span>Nota <em class="optional">opcional</em></span>
          <textarea name="note" rows="2" maxlength="500" placeholder="Ej. Se golpeó en educación física"></textarea></label>
        <p class="hint" data-privacy></p>
      </section>
      <section class="card stack">
        <label class="field"><span data-room-label>${here ? html`Salón de donde viene <em class="optional">opcional</em>` : 'Salón donde está'}</span>
          <input name="room" maxlength="40" value="${here ? '' : me.room || ''}" placeholder="Ej. 204" autocomplete="off"></label>
      </section>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} <span data-submit-label>${here ? 'Anotar visita' : 'Pedir turno'}</span></button>
      ${here ? '' : html`<p class="hint center" data-after>Te avisamos cuando lo llamen. Si cambia de salón, a los otros maestros de su grupo también les llega el aviso.</p>`}
    </form>`);

  const form = $('[data-form]', el);
  const showService = () => {
    const reasons = service?.reasons || [];
    const box = $('[data-reasons]', el);
    box.hidden = !reasons.length;
    box.innerHTML = String(html`${reasons.map((r) => html`<label class="chip"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`)}`);
    $('[data-privacy]', el).textContent = service
      ? `El motivo y la nota solo los ven tú y ${service.name}.`
      : 'El motivo y la nota solo los ven tú y el servicio.';
    // Support (Soporte IT): no student; what's wrong and where.
    const help = support();
    $('[data-student]', el).hidden = help;
    $('[data-reason-title]', el).textContent = help ? '¿Qué pasa?' : 'Motivo';
    form.note.placeholder = help ? 'Ej. El proyector no prende' : 'Ej. Se golpeó en educación física';
    if (!here) {
      $('[data-room-label]', el).textContent = help ? '¿Dónde?' : 'Salón donde está';
      $('[data-submit-label]', el).textContent = help ? 'Pedir ayuda' : 'Pedir turno';
      $('[data-after]', el).textContent = help
        ? `Te avisamos cuando alguien de ${service.name} vaya en camino y cuando quede resuelto.`
        : 'Te avisamos cuando lo llamen. Si cambia de salón, a los otros maestros de su grupo también les llega el aviso.';
      $('[data-sev-hint]', el).textContent = help
        ? 'Urgente le llega con alarma: úsalo si no puedes dar la clase.'
        : 'Urgente le llega con alarma al servicio y pasa primero en la fila.';
    }
  };
  showService();
  for (const input of el.querySelectorAll('[name=service]')) {
    input.addEventListener('change', () => {
      service = services.find((s) => s.id === Number(input.value));
      showService();
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      if (!service) throw new Error('Elige el servicio.');
      const help = support();
      const typed = help ? null : studentFrom(form);
      const severity = Number(form.querySelector('[name=severity]:checked')?.value || 0);
      if (!severity) throw new Error('Elige qué tan grave es.');
      const reason = form.querySelector('[name=reason]:checked')?.value || '';
      if (service.reasons.length && !reason) throw new Error(help ? 'Elige qué pasa.' : 'Elige el motivo.');
      if (help && !form.room.value.trim()) throw new Error('Escribe dónde es (tu salón u oficina).');
      const student = help ? {} : await confirmStudent(typed.name, typed.group);
      if (!student) return;
      const t = await requestService({
        serviceId: service.id,
        student,
        room: form.room.value.trim(),
        severity,
        reason,
        note: form.note.value.trim(),
        here,
      });
      toast(here ? 'Visita anotada' : help ? `Pedido enviado. Le avisamos a ${service.name}.` : `Turno pedido. Le avisamos a ${service.name}.`, 'ok');
      go(`/turns/${t.id}`, { replace: true });
    });
  });
}

// ---- Detail --------------------------------------------------------------------------------

function steps(t) {
  const list =
    t.service_mode === 'visit'
      ? [
          ['Pedido', t.created_by_name, t.created_at],
          ['Lo llamaron', t.called_at ? t.handled_by_name : null, t.called_at],
          ['Salió del salón', t.sent_at ? t.teacher_name : null, t.sent_at],
          [`Llegó a ${t.service_name}`, null, t.arrived_at],
          ['Regresa al salón', null, t.returning_at],
        ]
      : [
          ['Pedido', t.created_by_name, t.created_at],
          [`${t.service_name} va ${isSupport(t) ? 'en camino' : 'al salón'}`, t.on_the_way_at ? t.handled_by_name : null, t.on_the_way_at],
        ];
  if (t.status === 'done') list.push([outcomeLabel(t), t.closed_by_name, t.closed_at]);
  if (t.status === 'cancelled') list.push(['Cancelado', t.closed_by_name, t.closed_at]);
  return html`<ol class="timeline steps">
    ${list.map(([label, name, at]) => html`<li class="${at ? 'is-done' : ''}"><strong>${label}</strong>${at ? html`${name ? ` · ${name}` : ''}<small>${timeAgo(at)}</small>` : ''}</li>`)}
  </ol>`;
}

function teacherHint(t) {
  if (isSupport(t)) {
    return t.status === 'waiting' ? `Te avisamos cuando alguien de ${t.service_name} vaya en camino. Puedes cancelarlo mientras nadie va.` : '';
  }
  if (t.status === 'waiting') return 'Te avisamos cuando lo llamen. Si cambia de salón, a los otros maestros de su grupo también les llega el aviso.';
  if (t.status === 'called') {
    return 'Le toca ahora: envíalo y toca «Ya salió». El tiempo para llegar empieza entonces. Hasta que alguien lo toque, te lo recordamos cada 3 minutos, a ti y a los maestros de su grupo.';
  }
  if (t.status === 'returning') return 'Toca «Llegó al salón» cuando llegue. Si no llega a tiempo, se avisa a Seguridad.';
  return '';
}

/** For the service: what happens while the teacher hasn't sent the student. */
function serviceHint(t) {
  if (t.status === 'called') {
    return 'Esperando que el maestro lo envíe. El aviso les llegó también a los maestros de su grupo y se les recuerda cada 3 minutos; el tiempo para llegar empieza con «Ya salió». Si llega antes, toca «Llegó».';
  }
  return '';
}

export async function turnDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;
  let history = null;

  async function load() {
    const [t, services] = await Promise.all([getTurn(id), servicesOverview()]);
    if (!isCurrent()) return;
    const service = services.find((s) => s.id === t.service_id) || { serves: false };
    if (service.serves && !isSupport(t) && !history) history = await turnHistory(t).catch(() => []);
    if (!isCurrent()) return;
    const late = isLate(t);
    const s = statusTag(t);
    const actions = turnActions(t, service, me);
    const timed = TIMED.includes(t.status) && t.due_at;
    const hint = service.serves ? serviceHint(t) : teacherHint(t);
    el.innerHTML = String(html`
      <div class="stack" data-turn="${t.id}">
        <section class="card stack alert-head ${late || (isOpen(t) && t.severity === 4) ? 'is-urgent' : ''} ${t.status === 'done' ? 'is-ok' : ''}">
          <p class="alert-kind">${icon(isSupport(t) ? 'wrench' : 'pulse', 18)} ${t.service_name} · <span class="tag ${s.cls}">${s.label}</span></p>
          ${isSupport(t)
            ? html`<h2>${supportTitle(t)}${t.room ? html` <span class="muted">· ${t.room}</span>` : ''}</h2>`
            : html`<h2>${t.student_name} <span class="muted">· ${t.group_name}</span></h2>`}
          ${timed ? html`<p class="turn-timer ${late ? 'is-late' : ''}" data-due="${t.due_at}">${countdown(t.due_at)}</p>` : ''}
          ${late ? html`<p class="status-note danger">${icon('alert', 16)} No llegó a tiempo: se avisó a ${t.service_name}, al maestro y a Seguridad.</p>` : ''}
          <div class="facts">
            ${fact('Gravedad', `${SEVERITY[t.severity].label}${t.level > t.severity ? ` · sube a ${SEVERITY[t.level].label} por la espera` : ''}`)}
            ${isSupport(t) ? '' : fact('Motivo', t.reason)}
            ${fact(isSupport(t) ? 'Detalle' : 'Nota', t.note)}
            ${fact(isSupport(t) ? 'Dónde' : 'Salón', t.room)}
            ${fact('Pidió', `${t.created_by_name} · ${fmtDateTime(t.created_at)}`)}
            ${t.teacher_name && t.teacher_id !== t.created_by ? fact('Ahora está con', t.teacher_name) : ''}
            ${fact('Atiende', t.handled_by_name)}
            ${fact('Qué se hizo', t.resolution)}
            ${service.serves && t.out_of_order ? fact('Orden', 'Se escogió antes que otros turnos de la fila') : ''}
          </div>
          ${steps(t)}
        </section>
        ${actions.map((a) => actionButton(a))}
        ${service.serves && isSupport(t) && t.status === 'done'
          ? html`<button type="button" class="btn btn-secondary btn-block" data-resolution>${icon('edit', 18)} ${t.resolution ? 'Cambiar lo que se hizo' : 'Anotar qué se hizo'}</button>`
          : ''}
        ${hint ? html`<p class="hint">${hint}</p>` : ''}
        ${service.serves && history
          ? html`<section class="section">
              <h3 class="section-title">Visitas anteriores <span class="count">${history.length}</span></h3>
              ${history.length
                ? html`<div class="list">${history.map(
                    (h) => html`<a class="item" href="#/turns/${h.id}">
                      <span class="item-main"><strong>${fmtDateTime(h.created_at)}</strong>
                        <span class="item-sub">${[h.reason, h.status === 'done' ? OUTCOMES[h.outcome] : statusTag({ ...h, service_name: t.service_name }).label]
                          .filter(Boolean)
                          .join(' · ')}</span></span>
                      ${icon('chevron', 18)}</a>`,
                  )}</div>`
                : html`<p class="hint">Es su primera visita del año.</p>`}
            </section>`
          : ''}
        <a class="btn btn-ghost btn-block" href="#/turns">${icon('back', 18)} Todos los turnos</a>
      </div>`);
    bindSteps(el, [t], load);
    $('[data-resolution]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const v = await askResolution(t, t.resolution || '');
        if (!v) return;
        await noteTurnResolution(t.id, v.resolution.trim());
        toast('Guardado', 'ok');
        await load();
      }),
    );
  }

  await load();
  markAlertsRead(`#/turns/${id}`).catch(() => {});
  keepFresh(ctx, load);
  tickCountdowns(ctx);
}

// ---- Services (set up) ---------------------------------------------------------------------

const roleName = (key) => getSchoolRoles().find((r) => r.key === key)?.name || key;

export async function servicesView({ el }) {
  const services = await servicesOverview();
  el.innerHTML = String(html`
    <div class="stack">
      <p class="hint">Cada servicio tiene su fila de turnos. Elige qué roles lo atienden: solo esas personas ven la fila,
        el motivo y el historial con nombres.</p>
      ${services.length
        ? html`<div class="list">${services.map(
            (s) => html`<a class="item ${s.active ? '' : 'is-muted'}" href="#/services/${s.id}">
              <span class="item-icon">${icon(s.mode === 'support' ? 'wrench' : 'pulse')}</span>
              <span class="item-main">
                <strong>${s.name}</strong>
                <span class="item-sub">${{ visit: `El estudiante va · ${s.arrive_minutes} min para llegar`, room: 'El profesional va al salón', support: 'Ayuda al personal' }[s.mode]}
                  · ${s.roles.map(roleName).join(', ')}</span>
                <span class="item-tags">
                  ${s.active ? '' : html`<span class="tag">Desactivado</span>`}
                  ${s.staff.length
                    ? html`<span class="tag">${plural(s.staff.length, 'persona', 'personas')}</span>`
                    : html`<span class="tag tag-warn">Nadie tiene ese rol</span>`}
                </span>
              </span>
              ${icon('chevron', 18)}
            </a>`,
          )}</div>`
        : html`<div class="card">${empty('pulse', 'No hay servicios', 'Añade Enfermería, Trabajo Social u otro.')}</div>`}
      <a class="btn btn-secondary btn-block" href="#/services/new">${icon('plus')} Añadir servicio</a>
    </div>`);
}

export async function serviceFormView(ctx) {
  const { el, params } = ctx;
  const isNew = params[0] === 'new';
  const services = await servicesOverview();
  const s = isNew
    ? { name: '', mode: 'visit', arrive_minutes: 5, roles: [], reasons: ['Otro'], active: true }
    : services.find((x) => x.id === Number(params[0]));
  if (!s) throw new Error('No se encontró el servicio.');
  ctx.setTitle(isNew ? 'Nuevo servicio' : s.name);
  const roles = getSchoolRoles();

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <label class="field"><span>Nombre</span>
          <input name="name" required maxlength="40" value="${s.name}" placeholder="Ej. Orientación" autocomplete="off"></label>
        <div class="choices">
          <label class="choice"><input type="radio" name="mode" value="visit" ${s.mode === 'visit' ? 'checked' : ''}>
            <span><strong>El estudiante va a la oficina</strong><small>Como Enfermería: lo llaman, el maestro lo envía y corre el tiempo para llegar.</small></span></label>
          <label class="choice"><input type="radio" name="mode" value="room" ${s.mode === 'room' ? 'checked' : ''}>
            <span><strong>El profesional va al salón</strong><small>Como Trabajo Social: «Voy en camino» y luego «Atendido».</small></span></label>
          <label class="choice"><input type="radio" name="mode" value="support" ${s.mode === 'support' ? 'checked' : ''}>
            <span><strong>Ayuda al personal</strong><small>Como Soporte IT: sin estudiante; el maestro pide ayuda para su salón, «Voy en camino» y luego «Resuelto».</small></span></label>
        </div>
        <label class="field" data-minutes ${s.mode === 'visit' ? '' : 'hidden'}><span>Minutos para llegar</span>
          <input type="number" name="minutes" min="1" max="30" value="${s.arrive_minutes}" inputmode="numeric"></label>
        <p class="hint" data-minutes ${s.mode === 'visit' ? '' : 'hidden'}>El tiempo empieza cuando el maestro toca «Ya salió». Si no llega en ese tiempo, se avisa al servicio, al maestro y a Seguridad.</p>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('users')} ¿Quién lo atiende?</h2>
        <div class="chips">
          ${roles.map(
            (r) => html`<label class="chip"><input type="checkbox" name="role" value="${r.key}" ${s.roles.includes(r.key) ? 'checked' : ''}><span>${r.name}</span></label>`,
          )}
        </div>
        <p class="hint">Solo las personas con estos roles ven la fila, el motivo y el historial con nombres. Los roles se crean en
          «Roles y permisos».</p>
      </section>
      <section class="card stack">
        <label class="field"><span>Motivos <em class="optional">uno por línea</em></span>
          <textarea name="reasons" rows="7" maxlength="900">${s.reasons.join('\n')}</textarea></label>
        <p class="hint">El maestro elige uno al pedir el turno. Los detalles van en la nota, que solo ve el servicio.</p>
      </section>
      ${isNew
        ? ''
        : html`<section class="card stack">
            <label class="toggle"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}>
              <span class="toggle-ui"></span><span>Activo: los maestros pueden pedir turnos</span></label>
          </section>`}
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('check')} Guardar</button>
    </form>`);

  const form = $('[data-form]', el);
  for (const input of el.querySelectorAll('[name=mode]')) {
    input.addEventListener('change', () => {
      for (const node of el.querySelectorAll('[data-minutes]')) node.hidden = form.mode.value !== 'visit';
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      await saveService({
        id: isNew ? null : s.id,
        name: form.querySelector('[name=name]').value.trim(),
        mode: form.mode.value,
        arriveMinutes: Number(form.minutes.value) || 5,
        roles: [...el.querySelectorAll('[name=role]:checked')].map((i) => i.value),
        reasons: form.reasons.value.split('\n').map((r) => r.trim()).filter(Boolean),
        active: isNew ? true : form.active.checked,
      });
      toast('Servicio guardado', 'ok');
      go('/services', { replace: true });
    });
  });
}
