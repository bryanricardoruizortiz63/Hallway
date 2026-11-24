// Turnos: Enfermería, Trabajo Social and other services. A teacher asks for a turn for a student and follows it;
// the service sees its queue (most serious first), calls the student or goes to the room and marks each step.
// Teachers see the turns of their groups for 24 hours, without the reason; the service keeps its own history.
import {
  advanceTurn,
  getTurn,
  listTurns,
  markAlertsRead,
  myOpenMaintenance,
  noteTurnResolution,
  sendTurnMessage,
  saveTurnForm,
  setServiceForm,
  turnForm,
  turnMessages,
  receiveSupportRequest,
  requestService,
  returningStudents,
  saveService,
  setServiceHours,
  setServiceKeepOpen,
  servicesOverview,
  setMyServiceStatus,
  turnEvents,
  turnHistory,
} from '../backend.js';
import { $, busy, can, dialog, moduleOn, schoolIcon, serviceOn, fmtDate, fmtDateTime, fmtTime, getSchoolRoles, html, timeAgo, toast, todayStr } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { empty } from './common.js';
import { confirmStudent, fact, keepFresh, studentFields, studentFrom } from './students.js';
import { requestItem } from './maintenance.js';

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
  expired: 'Cerrado al terminar el horario escolar',
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
export const placeText = (room) => (room ? (/^\d/.test(room) ? `Salón ${room}` : room) : null);
/** How a closed turn ended, with who closed it: «Cancelado por Ana Torres», «Cerrado por el sistema». */
export const closedText = (t) =>
  t.status === 'cancelled'
    ? t.outcome === 'expired'
      ? 'Cerrado por el sistema: terminó el horario escolar'
      : `Cancelado${t.closed_by_name && t.closed_by_name !== 'Sistema' ? ` por ${t.closed_by_name}` : ''}`
    : t.status === 'done' && t.closed_by_name
      ? `${outcomeLabel(t)} · cerró ${t.closed_by_name}`
      : outcomeLabel(t);

/** «Quién hizo cada cambio»: every change of the turn with who made it and when. */
export function changesSection(events) {
  if (!events?.length) return '';
  return html`<section class="card stack" data-changes>
    <h2 class="card-title">${icon('users')} Quién hizo cada cambio</h2>
    <ol class="timeline">${events.map((e) => html`<li class="is-done ${e.actor_name === 'Sistema' ? 't-system' : ''}">
      <strong>${e.what}</strong> · ${e.actor_name}<small>${fmtDateTime(e.at)}</small></li>`)}</ol>
    <p class="hint">«Sistema» quiere decir que lo hizo Hallway solo: terminó el horario escolar y el turno no se tomó.</p>
  </section>`;
}

export const outcomeLabel = (t) => (isSupport(t) && SUPPORT_OUTCOMES[t.outcome]) || OUTCOMES[t.outcome] || 'Terminado';
const who = (t) => (isSupport(t) ? `${supportTitle(t)}${t.room ? ` (${t.room})` : ''}` : `${t.student_name} (${t.group_name})`);
// The group doesn't break at its hyphen.
const whoHtml = (t) => (isSupport(t) ? html`${supportTitle(t)}` : html`${t.student_name} <span class="nowrap">(${t.group_name})</span>`);
const timeOf = (iso) => fmtTime(new Date(iso));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// With a time to get there: to the service (it starts with «Ya salió»), or back to class.
export const TIMED = ['sent', 'returning'];
const pastDue = (t) => !!t.due_at && Date.now() > new Date(t.due_at);

/**
 * Past the time to get to the service, or back to class. On the way back, only once it's confirmed: when the time
 * is up the teachers are asked «¿Ya llegó?» first (askedBack), since the student may be in another class.
 */
export const isLate = (t) =>
  (['called', 'sent'].includes(t.status) && (!!t.late_at || pastDue(t))) || (t.status === 'returning' && !!t.return_late_at);

/** Time's up on the way back and nobody confirmed yet: «¿Ya llegó?». */
export const askedBack = (t) => t.status === 'returning' && !t.return_late_at && (!!t.return_check_at || pastDue(t));

/** The teacher who asked, has the student now, or teaches the group. */
const teacherSide = (t, me) => t.created_by === me.id || t.teacher_id === me.id || (me.groups || []).includes(t.group_name);

export function statusTag(t) {
  if (askedBack(t)) return { label: '¿Ya llegó?', cls: 'tag-warn' };
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
  if (t.status === 'cancelled') return { label: t.outcome === 'expired' ? 'Cerrado por el sistema' : 'Cancelado', cls: '' };
  if (t.outcome === 'unconfirmed') return { label: OUTCOMES.unconfirmed, cls: 'tag-warn' };
  if (isSupport(t) && t.outcome === 'referred') return { label: outcomeLabel(t), cls: 'tag-warn' };
  return { label: outcomeLabel(t), cls: t.outcome === 'expired' ? '' : 'tag-ok' };
}

/** "Quedan 3:12" or "Atrasado 2 min". */
export function countdown(dueAt) {
  const secs = Math.round((new Date(dueAt) - Date.now()) / 1000);
  if (secs <= 0) return `Atrasado ${Math.max(1, Math.round(-secs / 60))} min`;
  return `Quedan ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** "Esperando 12 min", "Esperando 1 h 5 min" (since it was asked). */
function waitingText(t) {
  const m = Math.max(0, Math.round((Date.now() - new Date(t.created_at)) / 60000));
  return `Esperando ${m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`}`;
}

/** The countdowns on screen tick every second. */
export function tickCountdowns(ctx) {
  const timer = setInterval(() => {
    for (const el of ctx.el.querySelectorAll('[data-due]')) {
      el.textContent = countdown(el.dataset.due);
      el.classList.toggle('is-late', new Date(el.dataset.due) < Date.now());
    }
  }, 1000);
  ctx.onLeave(() => clearInterval(timer));
}

/** "HH:MM:SS" of this phone's clock. */
const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * The absence that has this person out right now (the phone's date and time), as «hoy», «hasta la 1:00 p. m.» or
 * «hasta el vie 7 nov»; null when they're in.
 */
export function absentNow(person, now = new Date()) {
  const day = todayStr(now);
  const time = clock(now);
  const a = (person.absences || []).find((x) => x.start_date <= day && day <= x.end_date
    && (!x.partial || ((x.start_time || '00:00') <= time && (!x.end_time || time < x.end_time))));
  if (!a) return null;
  if (a.partial && a.end_time) return { until: `hasta la${Number(a.end_time.slice(0, 2)) % 12 === 1 ? '' : 's'} ${fmtTime(a.end_time)}` };
  return { until: a.end_date > day ? `hasta el ${fmtDate(a.end_date)}` : 'hoy' };
}

/** A sentence ends with one period, also after «p. m.». */
const end = (text) => (text.endsWith('.') ? text : `${text}.`);

/** «Ana» · «Ana y Luis» · «Ana, Luis y Marta». */
const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list.at(-1)}` : list[0] || '');

/**
 * Whether someone of the service is available, or when they're back. closed: everyone who attends it is absent (no
 * turns); absent: those who are out while the rest attend.
 */
function availability(service) {
  // Outside its hours (or a day without classes) nobody asks for a turn; whoever attends it can still note one.
  // The server also closes it when all its staff is absent: then the app's own notice says who and until when.
  if (service.closed_reason && !/se encuentra ausente/.test(service.closed_reason)) {
    return { text: 'Fuera de horario', ok: false, closed: true, hours: service.closed_reason, absent: [] };
  }
  const staff = service.staff || [];
  if (!staff.length) return { text: 'Nadie asignado', ok: false };
  const out = staff.map((p) => ({ ...p, absent: absentNow(p) }));
  const absent = out.filter((p) => p.absent);
  const present = out.filter((p) => !p.absent);
  if (!present.length) return { text: 'No disponible en este momento', ok: false, closed: true, absent };
  // Attending a turn (the student in their office, or on their way to a classroom) isn't «Disponible».
  if (present.some((p) => p.status === 'available' && !p.busy)) return { text: 'Disponible', ok: true, absent };
  if (present.some((p) => p.status === 'available' && p.busy)) return { text: 'Atendiendo un turno', ok: false, busy: true, absent };
  const next = [...present].sort((a, b) => String(a.until || '~').localeCompare(String(b.until || '~')))[0];
  return { text: `${STAFF_STATUS[next.status] || 'No disponible'}${next.until ? ` hasta ${timeOf(next.until)}` : ''}`, ok: false, absent };
}

/** What whoever asks for a turn should know when part (or all) of the service's staff is absent. */
function absenceNotice(service) {
  const a = availability(service);
  if (a.hours) return html`<p class="status-note warn" data-absence-notice>${icon('clock', 16)} <span>${a.hours}</span></p>`;
  if (!a.absent?.length) return '';
  if (a.closed) {
    const who = a.absent.length === 1
      ? `${a.absent[0].name} se encuentra ausente ${a.absent[0].absent.until}`
      : 'El personal del servicio se encuentra ausente';
    return html`<p class="status-note warn" data-absence-notice>${icon('alert', 16)} <span>${service.name} no está disponible en este
      momento. ${end(who)} Para una situación urgente, comunícate con la oficina.</span></p>`;
  }
  // «Luis Torres no está disponible hasta las 2:00 p. m.» · «Luis Torres (hasta las 2:00 p. m.) y Ana Rivera (hoy) no están…».
  const who = a.absent.length === 1
    ? `${a.absent[0].name} no está disponible ${a.absent[0].absent.until}`
    : `${names(a.absent.map((p) => `${p.name} (${p.absent.until})`))} no están disponibles`;
  return html`<p class="status-note warn" data-absence-notice>${icon('clock', 16)} <span>${end(who)} ${service.name} cuenta con menos
    personal en este momento, por lo que el tiempo de atención podría ser mayor.</span></p>`;
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
  back: 'Listo. Le avisamos a quien lo envió.',
  missing: 'Se avisó a Seguridad, al servicio y a los maestros de su grupo.',
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
const SUPPORT_DONE = { received: 'Le avisamos que lo recibiste.', go: 'Le avisamos que vas en camino.', finish: 'Pedido cerrado.', cancel: 'Pedido cancelado.' };

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
  if (step === 'received') {
    await receiveSupportRequest(t.id);
    toast(SUPPORT_DONE.received, 'ok');
    return true;
  }
  let note = '';
  if (step === 'call' && !isSupport(t)) {
    // An optional note for the teacher with the call («Que traiga su inhalador»); it stays in the turn's chat.
    const v = await dialog({
      title: `¿Llamar a ${t.student_name}?`,
      message: t.position > 1 ? `Hay ${plural(t.position - 1, 'turno', 'turnos')} antes en la fila. Se anota que lo escogiste antes.` : '',
      body: html`<label class="field"><span>Nota para el maestro <em class="optional">opcional</em></span>
        <textarea name="note" rows="2" maxlength="500" placeholder="Ej. Que traiga su inhalador o su merienda"></textarea></label>`,
      confirmText: 'Llamar',
      cancelText: 'Volver',
      collect: true,
    });
    if (!v) return false;
    note = v.note.trim();
  } else if ((step === 'call' || step === 'go') && t.position > 1) {
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
    const v = await dialog({
      title: `¿Cancelar este ${what}?`,
      message: who(t),
      body: html`<label class="field"><span>¿Por qué? <em class="optional">opcional</em></span>
        <textarea name="note" rows="2" maxlength="500" placeholder="${isSupport(t) ? 'Ej. Ya se resolvió solo' : 'Ej. Ya se siente mejor; si sigue igual, vuelva a pedirlo'}"></textarea></label>
        <p class="hint">Lo verá ${t.created_by === state.me.user.id ? t.service_name : 'quien lo pidió'} y queda en el chat del ${what}.</p>`,
      confirmText: `Cancelar ${what}`,
      cancelText: 'Volver',
      danger: true,
      collect: true,
    });
    if (!v) return false;
    note = v.note.trim();
  }
  if (step === 'missing') {
    const ok = await dialog({
      title: `¿${t.student_name} no ha llegado?`,
      message: 'Se avisa ahora a Seguridad, al servicio y a los maestros de su grupo. Si después llega, toca «Está en mi clase».',
      confirmText: 'No ha llegado',
      cancelText: 'Volver',
      danger: true,
    });
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
  // The note goes with the call or the cancellation: in the turn's chat and in the teacher's notice.
  if (note) await sendTurnMessage(t.id, note, step === 'call' ? 'call' : 'cancel').catch(() => toast('El turno se guardó, pero la nota no se pudo enviar. Escríbela en el chat del turno.', 'error'));
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
  // «Decide quien atiende»: until someone chooses, both ways (call to the office, or go to the room).
  const either = t.service_mode === 'either';
  if (service.serves && either && t.status === 'waiting') {
    add('call', 'Llamar a la oficina', 'primary');
    add('go', 'Voy al salón', 'primary');
    add('arrived', 'Ya está aquí');
    add('finish', 'Ya lo atendí', 'secondary', 'attended');
  }
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
    // «Recibido» first: the teacher knows someone has it, before anyone is on the way.
    if (t.status === 'waiting' && !t.received_at) add('received', 'Recibido', 'primary');
    if (t.status === 'waiting') add('go', 'Voy en camino', 'primary');
    if (t.status === 'on_the_way') add('finish', 'Resuelto', 'primary', 'attended');
    if (t.status === 'waiting') add('finish', 'Ya lo resolví', 'secondary', 'attended');
    add('finish', 'Necesita seguimiento', 'secondary', 'referred');
  }
  if (teacher && !isSupport(t)) {
    if (t.status === 'called') add('sent', 'Ya salió', 'primary');
    if (askedBack(t)) {
      add('back', 'Está en mi clase', 'primary');
      add('missing', 'No ha llegado', 'ghost-danger');
    } else if (t.status === 'returning') add('back', 'Llegó al salón', 'primary');
    if (['waiting', 'called', 'on_the_way', 'returning'].includes(t.status) && t.teacher_id !== me.id && !service.serves) add('take', 'Está conmigo');
  }
  if (service.serves && t.status === 'returning') add('back', 'Llegó al salón');
  const mine = t.created_by === me.id || t.teacher_id === me.id;
  if (service.serves || (mine && ['waiting', 'called'].includes(t.status))) add('cancel', isSupport(t) ? 'Cancelar pedido' : 'Cancelar turno', 'ghost-danger');
  return out;
}

const ICONS = { received: 'check', call: 'bell', go: 'send', sent: 'send', arrived: 'check', return: 'back', back: 'check', missing: 'alert', finish: 'check', take: 'user' };
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
        : schoolIcon(t.service_mode, late ? 'is-danger' : '')}
      <span class="item-main">
        <strong>${whoHtml(t)}</strong>
        <span class="item-sub">${(isSupport(t)
          ? [placeText(t.room), `pidió ${t.created_by_name}`, t.note]
          : [t.reason, t.room ? `Salón ${t.room}` : null, `pidió ${t.created_by_name}`]
        ).filter(Boolean).join(' · ')}</span>
        <span class="item-tags">
          <span class="tag ${sev.cls}">${sev.label}</span>
          ${t.status === 'waiting'
            ? html`<span class="tag">${icon('clock', 14)} ${waitingText(t)}</span>
                ${t.received_at ? html`<span class="tag tag-ok">Recibido · ${t.received_by_name}</span>` : ''}
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
      ${schoolIcon(t.service_mode, late ? 'is-danger' : '')}
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

/**
 * «Regresando a clase»: the students coming back from a service right now that aren't in my lists. The class may
 * have changed meanwhile, so any teacher who has one can say so. Only the name and the group, never the service.
 */
function returningSection(list) {
  if (!list.length) return '';
  return html`<section class="section" data-returning>
    <h3 class="section-title">Regresando a clase <span class="count">${list.length}</span></h3>
    <div class="list">${list.map((x) => html`<div class="item" data-back-id="${x.id}">
      <a class="item-link" href="#/turns/back/${x.id}">
        ${schoolIcon('returning')}
        <span class="item-main">
          <strong>${x.student_name} (${x.group_name})</strong>
          <span class="item-tags">${x.asked
            ? html`<span class="tag tag-warn">¿Ya llegó?</span>`
            : html`<span class="tag">${icon('clock', 14)} salió ${timeAgo(x.returning_at)}</span>`}</span>
        </span>
      </a>
      <button type="button" class="btn btn-primary btn-sm" data-in-class>${icon('check', 16)} Está en mi clase</button>
    </div>`)}</div>
    <p class="hint">Si uno de ellos llega a tu clase, toca «Está en mi clase» y le avisamos a quien lo envió. Así no se avisa a Seguridad por error.</p>
  </section>`;
}

function bindReturning(root, list, reload) {
  for (const btn of root.querySelectorAll('[data-in-class]')) {
    btn.addEventListener('click', () => {
      const x = list.find((r) => r.id === Number(btn.closest('[data-back-id]').dataset.backId));
      busy(btn, async () => {
        const ok = await dialog({
          title: `¿${x.student_name} está en tu clase?`,
          message: `${x.student_name} (${x.group_name}) regresaba a clase. Le avisamos a quien lo envió que ya llegó.`,
          confirmText: 'Está en mi clase',
          cancelText: 'Volver',
        });
        if (!ok) return;
        await advanceTurn(x.id, 'back');
        toast(STEP_DONE.back, 'ok');
        await reload();
      });
    });
  }
}

/** A support request (Soporte IT): what, where and how it's going; for whoever asked, or in the service's list. */
function supportItem(t, { serving = false } = {}) {
  const s = statusTag(t);
  const sub = [placeText(t.room), serving ? `pidió ${t.created_by_name}` : null,
    t.handled_by_name && t.status !== 'waiting' ? `atiende ${t.handled_by_name}` : null];
  const waiting = t.status === 'waiting';
  return html`<div class="item alert-item ${isOpen(t) ? '' : 'is-muted'}" data-turn="${t.id}">
    <a class="item-link" href="#/turns/${t.id}">
      ${waiting && t.position
        ? html`<span class="item-icon queue-num" title="Turno ${t.position}">${t.position}</span>`
        : schoolIcon('support')}
      <span class="item-main">
        <strong>${serving ? supportTitle(t) : `${t.service_name}: ${supportTitle(t)}`}</strong>
        <span class="item-sub">${sub.filter(Boolean).join(' · ')}</span>
        <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span>
          ${waiting ? html`<span class="tag">${icon('clock', 14)} ${waitingText(t)}</span>` : ''}
          ${waiting && t.received_at ? html`<span class="tag tag-ok">${icon('check', 14)} Recibido</span>` : ''}</span>
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
    const { services, turns, maintenance, returning } = data;
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
              ${['visit', 'either'].includes(service.mode)
                ? html`<a class="btn btn-ghost btn-sm" href="#/turns/new?service=${service.id}&here=1">${icon('plus', 18)} Llegó sin turno</a>`
                : ''}
              <a class="btn btn-ghost btn-sm" href="#/turns/panel/${service.id}">${icon('chart', 18)} Panel y Excel</a>
            </div>
          </section>`;
        })}

        ${returningSection(returning.filter((x) => !turns.some((t) => t.id === x.id)))}

        <section class="section">
              <h3 class="section-title">Pedir turno</h3>
              <div class="alert-actions service-rows">
                ${toRequest.map((s) => {
                  const a = availability(s);
                  const why = a.closed
                    ? a.absent.length === 1 ? `${a.absent[0].name} se encuentra ausente ${a.absent[0].absent.until}` : 'Personal ausente'
                    : a.absent.length ? `Personal reducido: el tiempo de atención podría ser mayor` : '';
                  const inner = html`<span class="service-icon">${icon(s.mode === 'support' ? 'wrench' : 'pulse', 22)}</span>
                    <span class="service-text"><strong>${s.name}</strong>
                      <small class="${a.ok ? '' : 'is-off'}"><i class="service-dot" aria-hidden="true"></i>${availabilityText(s)}</small>
                      ${why ? html`<small class="service-why">${why}</small>` : ''}</span>`;
                  // Nobody to attend it: no turns until someone is back.
                  return a.closed
                    ? html`<div class="alert-action is-disabled" aria-disabled="true">${inner}</div>`
                    : html`<a class="alert-action" href="#/turns/new?service=${s.id}">${inner}${icon('chevron', 18)}</a>`;
                })}
                ${moduleOn(state.me.school, 'maintenance') ? html`<a class="alert-action" href="#/maintenance/new">
                  <span class="service-icon">${icon('wrench', 22)}</span>
                  <span class="service-text"><strong>Mantenimiento</strong>
                    <small>Derrame, limpieza, baño, basura</small></span>
                  ${icon('chevron', 18)}</a>` : ''}
              </div>
            </section>

        ${maintenance.length
          ? html`<section class="section" data-my-maintenance>
              <h3 class="section-title">Tus solicitudes de mantenimiento</h3>
              <div class="list">${maintenance.map((m) => requestItem(m, me, { action: false }))}</div>
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
          : 'El motivo y la nota solo los ven tú, el servicio y la dirección. Los otros maestros del grupo ven cómo va el turno. Los nombres se borran de tu lista a las 24 horas.'}</p>
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
    bindReturning(el, returning, load);
  };

  async function load() {
    const [services, turns, maintenance, returning] = await Promise.all([
      servicesOverview(), listTurns(), myOpenMaintenance(me.id), returningStudents().then((x) => x || [], () => []),
    ]);
    if (!isCurrent()) return;
    // Services whose module the platform turned off (Soporte IT, Enfermería…) don't show.
    data = { services: services.filter((s) => serviceOn(state.me.school, s)), turns, maintenance, returning };
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
  const services = (await servicesOverview()).filter((s) => s.active && serviceOn(state.me.school, s));
  if (!services.length) {
    el.innerHTML = String(html`<div class="card">${empty('pulse', 'No hay servicios', 'La dirección todavía no activó Enfermería ni Trabajo Social.')}</div>`);
    return;
  }
  let service = services.find((s) => s.id === Number(query.get('service'))) || (services.length === 1 ? services[0] : null);
  // The professional notes a student who came on their own.
  const here = query.get('here') === '1' && !!service?.serves && ['visit', 'either'].includes(service.mode);
  if (here) ctx.setTitle('Llegó sin turno');
  // Already chosen on Turnos (or the only one): don't ask again, just show it. To change it, go back.
  const chosen = !here && !!service;
  const modeText = (s) => ({
    visit: 'El estudiante va a la oficina',
    room: 'Va al salón',
    either: 'El servicio decide si lo llama a la oficina o va al salón',
    support: 'Ayuda para ti o tu salón',
  }[s.mode]);
  const support = () => service?.mode === 'support';

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      ${here
        ? html`<p class="status-note ok">${icon('check', 16)} ${service.name}: el estudiante ya está en la oficina.</p>`
        : html`${chosen
            ? html`<section class="card stack" data-chosen>
                <h2 class="card-title">${icon(support() ? 'wrench' : 'pulse')} Turno para ${service.name}</h2>
                <p class="hint">${modeText(service)} · ${availabilityText(service)}</p>
                ${service.serves ? '' : absenceNotice(service)}
              </section>`
            : html`<section class="card stack" data-pick-service>
                <h2 class="card-title">${icon('pulse')} ¿A qué servicio?</h2>
                <div class="choices">
                  ${services.map(
                    (s) => html`<label class="choice ${availability(s).closed && !s.serves ? 'is-disabled' : ''}">
                      <input type="radio" name="service" value="${s.id}" ${availability(s).closed && !s.serves ? 'disabled' : ''}>
                      <span><strong>${s.name}</strong><small>${modeText(s)} · ${availabilityText(s)}</small></span></label>`,
                  )}
                </div>
                <div data-service-notice></div>
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
  // Everyone who attends it is absent: the form stays, but it can't be sent.
  const closed = () => !!service && !service.serves && !!availability(service).closed;
  const showService = () => {
    const notice = $('[data-service-notice]', el);
    if (notice) notice.innerHTML = service && !service.serves ? String(absenceNotice(service)) : '';
    form.querySelector('[type=submit]').disabled = closed();
    const reasons = service?.reasons || [];
    const box = $('[data-reasons]', el);
    box.hidden = !reasons.length;
    box.innerHTML = String(html`${reasons.map((r) => html`<label class="chip"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`)}`);
    $('[data-privacy]', el).textContent = service
      ? `El motivo y la nota solo los ven tú, ${service.name} y la dirección.`
      : 'El motivo y la nota solo los ven tú, el servicio y la dirección.';
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
      if (closed() && availability(service).hours) throw new Error(availability(service).hours);
      if (closed()) throw new Error(`${service.name} no está disponible en este momento: el personal del servicio se encuentra ausente.`);
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
      : t.service_mode === 'either'
        ? [['Pedido', t.created_by_name, t.created_at]]
        : [
            ['Pedido', t.created_by_name, t.created_at],
            [`${t.service_name} va ${isSupport(t) ? 'en camino' : 'al salón'}`, t.on_the_way_at ? t.handled_by_name : null, t.on_the_way_at],
          ];
  if (t.status === 'done') list.push([outcomeLabel(t), t.closed_by_name, t.closed_at]);
  if (t.status === 'cancelled') list.push(t.outcome === 'expired' ? ['Lo cerró el sistema: terminó el horario escolar y no se tomó el turno', null, t.closed_at] : ['Cancelado', t.closed_by_name, t.closed_at]);
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
  if (askedBack(t)) return 'Se acabó el tiempo para llegar. Si está en tu clase, toca «Está en mi clase»; si no, «No ha llegado». Si nadie responde en 3 minutos, se avisa a Seguridad.';
  if (t.status === 'returning') {
    return 'Toca «Llegó al salón» cuando llegue. Puede llegar a otra clase: cualquier maestro lo puede marcar. Si se acaba el tiempo, primero te preguntamos a ti y a los maestros de su grupo; si nadie responde en 3 minutos, se avisa a Seguridad.';
  }
  return '';
}

/** For the service: what happens while the teacher hasn't sent the student. */
function serviceHint(t) {
  if (t.status === 'called') {
    return 'Esperando que el maestro lo envíe. El aviso les llegó también a los maestros de su grupo y se les recuerda cada 3 minutos; el tiempo para llegar empieza con «Ya salió». Si llega antes, toca «Llegó».';
  }
  return '';
}

// ---- The turn's form (Enfermería: symptoms, vital signs…): never required -------------------------------------------

/** A value of the form in words: «118/76 mmHg», «100.4 °F», «Fiebre, Mareo», «Sí». '' when it's empty. */
export function formValueText(f, v) {
  if (v === undefined || v === null) return '';
  const unit = f.unit ? ` ${f.unit}` : '';
  switch (f.type) {
    case 'check_number': return v.value !== undefined && v.value !== null && v.value !== '' ? `${v.value}${unit}` : 'Se tomó (sin número)';
    case 'pressure': return v.sys || v.dia ? `${v.sys || '—'}/${v.dia || '—'}${unit}` : 'Se tomó (sin número)';
    case 'choices': return v.join(', ');
    case 'yesno': return v ? 'Sí' : 'No';
    case 'number': return `${v}${unit}`;
    default: return String(v);
  }
}

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
/** «97–100.3 °F» */
const rangeText = (low, high, unit) =>
  low !== undefined && high !== undefined ? `${low}–${high}${unit ? ` ${unit}` : ''}`
    : low !== undefined ? `desde ${low}${unit ? ` ${unit}` : ''}` : `hasta ${high}${unit ? ` ${unit}` : ''}`;

/**
 * Whether a measure is outside its normal range (set by the Admin): 'alta', 'baja' or null. The value is always
 * accepted; this only tells. For the pressure, either number out counts.
 */
export function outOfRange(f, v) {
  if (!v) return null;
  const check = (x, low, high) => {
    const n = num(x);
    if (n === null || Number.isNaN(n)) return null;
    if (high !== undefined && n > high) return 'alta';
    if (low !== undefined && n < low) return 'baja';
    return null;
  };
  if (f.type === 'number') return check(v, f.low, f.high);
  if (f.type === 'check_number') return check(v.value, f.low, f.high);
  if (f.type === 'pressure') return check(v.sys, f.low, f.high) || check(v.dia, f.low2, f.high2);
  return null;
}

/** «Alta: lo normal es 97–100.3 °F» (for the pressure, both ranges). */
function rangeHint(f, which) {
  if (!which) return '';
  const normal = f.type === 'pressure'
    ? [f.low !== undefined || f.high !== undefined ? rangeText(f.low, f.high) : null,
      f.low2 !== undefined || f.high2 !== undefined ? rangeText(f.low2, f.high2) : null].filter(Boolean).join(' / ') + (f.unit ? ` ${f.unit}` : '')
    : rangeText(f.low, f.high, f.unit);
  return `${f.label} ${which}: lo normal es ${normal}.`;
}

/** On the turn: the form's summary, and filling or correcting it (only whoever attends the service). */
function formSection(t, service, form) {
  const fields = form?.fields || service.form_fields || [];
  if (!fields.length || (!service.serves && !form)) return '';
  const filled = fields.filter((f) => formValueText(f, form?.data?.[f.key]));
  return html`<section class="card stack turn-form-card" data-form-card>
    <h2 class="card-title">${icon('file')} Formulario de ${t.service_name}</h2>
    ${form
      ? html`<div class="facts">${filled.map((f) => {
          const off = outOfRange(f, form.data[f.key]);
          return fact(f.label, `${formValueText(f, form.data[f.key])}${off ? ` · ${off === 'alta' ? '⚠ Alta' : '⚠ Baja'}` : ''}`);
        })}</div>
        <p class="hint">${form.updated_at
          ? `Lo llenó ${form.filled_by_name}; lo corrigió ${form.updated_by_name} · ${fmtDateTime(form.updated_at)}`
          : `Lo llenó ${form.filled_by_name} · ${fmtDateTime(form.created_at)}`}</p>
        ${filled.length < fields.length ? html`<p class="hint">${plural(fields.length - filled.length, 'campo quedó', 'campos quedaron')} sin llenar.</p>` : ''}`
      : html`<p class="hint">Síntomas, signos vitales y lo que se hizo. Es opcional: llena lo que haga falta.</p>`}
    ${service.serves
      ? html`<a class="btn btn-secondary btn-block" href="#/turns/${t.id}/form">${icon('edit', 18)} ${form ? 'Corregir el formulario' : 'Llenar el formulario'}</a>`
      : ''}
    <p class="hint">Solo lo ven ${t.service_name} y quien tiene «Ver el detalle de los turnos»; el maestro no.</p>
  </section>`;
}

/** One field of the form, with what it has now. */
function formInput(f, v) {
  const name = `f-${f.key}`;
  switch (f.type) {
    case 'long':
      return html`<label class="field"><span>${f.label}</span><textarea name="${name}" rows="3" maxlength="2000">${v || ''}</textarea></label>`;
    case 'text':
      return html`<label class="field"><span>${f.label}</span><input name="${name}" maxlength="200" value="${v || ''}" autocomplete="off"></label>`;
    case 'number':
      return html`<div class="form-measure" data-measure="${f.key}"><label class="field"><span>${f.label}${f.unit ? html` <em class="optional">${f.unit}</em>` : ''}</span>
        <input name="${name}" type="number" step="any" inputmode="decimal" value="${v ?? ''}"></label>
        <p class="range-hint" data-range-hint hidden></p></div>`;
    case 'check_number':
      return html`<div class="form-check" data-check="${f.key}">
        <label class="toggle"><input type="checkbox" name="${name}-taken" ${v ? 'checked' : ''}><span class="toggle-ui"></span>
          <span>Se tomó: ${f.label}</span></label>
        <label class="form-check-value" ${v ? '' : 'hidden'}><input name="${name}-value" type="number" step="any" inputmode="decimal"
          value="${v?.value ?? ''}" aria-label="${f.label}" placeholder="Número">${f.unit ? html`<span>${f.unit}</span>` : ''}</label>
        <p class="range-hint" data-range-hint hidden></p>
      </div>`;
    case 'pressure':
      return html`<div class="form-check" data-check="${f.key}">
        <label class="toggle"><input type="checkbox" name="${name}-taken" ${v ? 'checked' : ''}><span class="toggle-ui"></span>
          <span>Se tomó: ${f.label}</span></label>
        <div class="form-check-value" ${v ? '' : 'hidden'}>
          <input name="${name}-sys" type="number" inputmode="numeric" value="${v?.sys ?? ''}" aria-label="Sistólica" placeholder="120">
          <span class="form-slash">/</span>
          <input name="${name}-dia" type="number" inputmode="numeric" value="${v?.dia ?? ''}" aria-label="Diastólica" placeholder="80">
          ${f.unit ? html`<span>${f.unit}</span>` : ''}
        </div>
        <p class="range-hint" data-range-hint hidden></p>
      </div>`;
    case 'choices':
      return html`<div class="field"><span>${f.label}</span>
        <div class="chips">${f.options.map((o) => html`<label class="chip"><input type="checkbox" name="${name}" value="${o}"
          ${v?.includes(o) ? 'checked' : ''}><span>${o}</span></label>`)}</div></div>`;
    case 'yesno':
      return html`<div class="field"><span>${f.label}</span>
        <div class="segmented">
          ${[['yes', 'Sí', v === true], ['no', 'No', v === false], ['', 'Sin anotar', v !== true && v !== false]].map(
            ([val, label, on]) => html`<label class="seg ${on ? 'active' : ''}"><input type="radio" name="${name}" value="${val}" ${on ? 'checked' : ''}><span>${label}</span></label>`,
          )}
        </div></div>`;
    default:
      return '';
  }
}

/** What the form says now: { key: value } (empty fields left out) and the labels of the empty ones. */
function readForm(form, fields) {
  const data = {};
  const empty = [];
  const val = (n) => form.elements[n]?.value?.trim() ?? '';
  for (const f of fields) {
    const name = `f-${f.key}`;
    let v = null;
    if (f.type === 'text' || f.type === 'long' || f.type === 'number') v = val(name) || null;
    else if (f.type === 'check_number') v = form.elements[`${name}-taken`].checked ? { taken: true, value: val(`${name}-value`) } : null;
    else if (f.type === 'pressure') v = form.elements[`${name}-taken`].checked ? { taken: true, sys: val(`${name}-sys`), dia: val(`${name}-dia`) } : null;
    else if (f.type === 'choices') {
      const list = [...form.querySelectorAll(`[name="${name}"]:checked`)].map((c) => c.value);
      v = list.length ? list : null;
    } else if (f.type === 'yesno') {
      const pick = form.querySelector(`[name="${name}"]:checked`)?.value;
      v = pick === 'yes' ? true : pick === 'no' ? false : null;
    }
    // A measure marked as taken without its number is still empty.
    const missing = v === null || (f.type === 'check_number' && !v.value) || (f.type === 'pressure' && (!v.sys || !v.dia));
    if (missing) empty.push(f.label);
    if (v !== null) data[f.key] = v;
  }
  return { data, empty };
}

/** #/turns/:id/form — the service fills (or corrects) the turn's form. Nothing is required. */
export async function turnFormView(ctx) {
  const { el, params, setTitle } = ctx;
  const id = Number(params[0]);
  const [t, services, saved] = await Promise.all([getTurn(id), servicesOverview(), turnForm(id).catch(() => null)]);
  const service = services.find((x) => x.id === t.service_id) || {};
  if (!service.serves) throw new Error(`Solo ${t.service_name} llena este formulario.`);
  const fields = service.form_fields || [];
  if (!fields.length) throw new Error(`${t.service_name} no tiene formulario. Se configura en Servicios.`);
  setTitle(`Formulario · ${t.student_name || t.service_name}`);
  el.innerHTML = String(html`<form class="stack turn-form" data-turn-form novalidate>
    <section class="card stack">
      <p class="alert-kind">${icon('pulse', 18)} ${t.service_name}</p>
      <h2>${t.student_name} <span class="muted">· ${t.group_name}</span></h2>
      ${t.reason ? html`<p class="hint">Motivo: ${t.reason}${t.note ? ` · ${t.note}` : ''}</p>` : ''}
      <p class="hint">Todo es opcional: llena lo que haga falta. Al guardar te decimos qué quedó vacío.</p>
    </section>
    <section class="card stack">${fields.map((f) => formInput(f, saved?.data?.[f.key]))}</section>
    <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('check')} Guardar formulario</button>
    <a class="btn btn-ghost btn-block" href="#/turns/${id}">${icon('back', 18)} Volver al turno</a>
  </form>`);
  const form = $('[data-turn-form]', el);
  // «Se tomó»: the number appears when it's marked.
  for (const box of form.querySelectorAll('[data-check]')) {
    const check = box.querySelector('[type=checkbox]');
    check.addEventListener('change', () => {
      const value = box.querySelector('.form-check-value');
      value.hidden = !check.checked;
      if (check.checked) value.querySelector('input')?.focus();
    });
  }
  // A value outside the normal range: accepted, with a small notice under it.
  const showRange = (key) => {
    const f = fields.find((x) => x.key === key);
    const box = form.querySelector(`[data-check="${key}"], [data-measure="${key}"]`);
    const hint = box && $('[data-range-hint]', box);
    if (!f || !hint) return;
    const { data } = readForm(form, [f]);
    const text = rangeHint(f, outOfRange(f, data[f.key]));
    hint.textContent = text ? `⚠ ${text}` : '';
    hint.hidden = !text;
  };
  for (const box of form.querySelectorAll('[data-check], [data-measure]')) {
    const key = box.dataset.check || box.dataset.measure;
    box.addEventListener('input', () => showRange(key));
    box.addEventListener('change', () => showRange(key));
    showRange(key);
  }
  for (const seg of form.querySelectorAll('.segmented')) {
    seg.addEventListener('change', () => {
      for (const l of seg.querySelectorAll('.seg')) l.classList.toggle('active', l.querySelector('input').checked);
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { data, empty } = readForm(form, fields);
    busy(form.querySelector('[type=submit]'), async () => {
      // Never required: it only tells what is empty and asks.
      if (empty.length) {
        const ok = await dialog({
          title: empty.length === fields.length ? '¿Guardar el formulario vacío?' : '¿Guardar con campos vacíos?',
          message: `${empty.length === fields.length ? 'No llenaste ningún campo.' : `Quedaron sin llenar: ${empty.join(', ')}.`} ¿Deseas guardar así?`,
          confirmText: 'Guardar así',
          cancelText: 'Seguir llenando',
        });
        if (!ok) return;
      }
      await saveTurnForm(id, data);
      toast('Formulario guardado', 'ok');
      go(`/turns/${id}`, { replace: true });
    });
  });
}

// ---- A service's form fields (whoever has «Configurar Turnos») ----------------------------------------------------

const FIELD_TYPES = [
  ['text', 'Texto corto'],
  ['long', 'Texto largo'],
  ['number', 'Número'],
  ['check_number', '«Se tomó» y un número'],
  ['pressure', '«Se tomó» y presión (dos números)'],
  ['choices', 'Opciones para marcar'],
  ['yesno', 'Sí o no'],
];

const UNITS = ['°F', '°C', 'mmHg', 'mg/dL', 'mmol/L', 'lpm', '%', 'lb', 'kg', 'in', 'cm', 'rpm'];
const round1 = (n) => Math.round(n * 10) / 10;
/** How to turn a number from one unit into the other (null when they aren't a known pair). */
function convertUnit(from, to) {
  const k = `${from.toLowerCase()}>${to.toLowerCase()}`;
  return {
    '°f>°c': (n) => round1(((n - 32) * 5) / 9),
    '°c>°f': (n) => round1((n * 9) / 5 + 32),
    'mg/dl>mmol/l': (n) => round1(n / 18),
    'mmol/l>mg/dl': (n) => Math.round(n * 18),
    'lb>kg': (n) => round1(n / 2.2046),
    'kg>lb': (n) => round1(n * 2.2046),
    'in>cm': (n) => round1(n * 2.54),
    'cm>in': (n) => round1(n / 2.54),
  }[k] || null;
}

function fieldEditor(f, i, total) {
  const numeric = ['number', 'check_number', 'pressure'].includes(f.type);
  return html`<li class="card stack field-edit" data-field="${i}" data-key="${f.key || ''}">
    <div class="field-edit-head">
      <strong>${i + 1}.</strong>
      <span class="field-edit-moves">
        <button type="button" class="icon-btn" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('chevron', 18)}</button>
        <button type="button" class="icon-btn" data-move="1" ${i === total - 1 ? 'disabled' : ''} aria-label="Bajar">${icon('chevron', 18)}</button>
        <button type="button" class="icon-btn" data-remove aria-label="Quitar">${icon('trash', 18)}</button>
      </span>
    </div>
    <label class="field"><span>Nombre del campo</span><input data-label maxlength="60" value="${f.label || ''}" placeholder="Ej. Peso"></label>
    <label class="field"><span>Tipo</span><select data-type>${FIELD_TYPES.map(([v, l]) => html`<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`)}</select></label>
    <label class="field" ${numeric ? '' : 'hidden'} data-unit-field><span>Unidad <em class="optional">opcional</em></span>
      <input data-unit maxlength="12" value="${f.unit || ''}" placeholder="Ej. °F, °C, mg/dL" list="units" autocomplete="off"></label>
    <div class="field" ${numeric ? '' : 'hidden'} data-range-field>
      <span>Lo normal <em class="optional">opcional</em></span>
      <div class="range-row"><span data-range-label>${f.type === 'pressure' ? 'Sistólica' : 'De'}</span>
        <input data-low type="number" step="any" value="${f.low ?? ''}" aria-label="Desde"><span>a</span>
        <input data-high type="number" step="any" value="${f.high ?? ''}" aria-label="Hasta"></div>
      <div class="range-row" ${f.type === 'pressure' ? '' : 'hidden'} data-range2><span>Diastólica</span>
        <input data-low2 type="number" step="any" value="${f.low2 ?? ''}" aria-label="Diastólica desde"><span>a</span>
        <input data-high2 type="number" step="any" value="${f.high2 ?? ''}" aria-label="Diastólica hasta"></div>
      <p class="hint">Si un valor sale de aquí, al anotarlo sale un aviso de «alta» o «baja». Se acepta igual.</p>
    </div>
    <label class="field" ${f.type === 'choices' ? '' : 'hidden'} data-options-field><span>Opciones <em class="optional">una por línea</em></span>
      <textarea data-options rows="4" maxlength="900">${(f.options || []).join('\n')}</textarea></label>
  </li>`;
}

/** #/services/:id/form — the fields of a service's form: add, change, order or remove them at any time. */
export async function serviceFormFieldsView(ctx) {
  const { el, params, setTitle } = ctx;
  const id = Number(params[0]);
  const s = (await servicesOverview()).find((x) => x.id === id);
  if (!s) throw new Error('No se encontró el servicio.');
  setTitle(`Formulario · ${s.name}`);
  let fields = (s.form_fields || []).map((f) => ({ ...f }));

  // What the screen says now, before redrawing it.
  const collect = () => {
    fields = [...el.querySelectorAll('[data-field]')].map((li) => {
      const type = $('[data-type]', li).value;
      return {
        key: li.dataset.key || undefined,
        label: $('[data-label]', li).value.trim(),
        type,
        unit: $('[data-unit]', li).value.trim() || undefined,
        ...Object.fromEntries(['low', 'high', 'low2', 'high2']
          .map((k) => [k, $(`[data-${k}]`, li).value.trim()])
          .filter(([k, x]) => x !== '' && (type === 'pressure' || !k.endsWith('2')))
          .map(([k, x]) => [k, Number(x)])),
        options: type === 'choices' ? $('[data-options]', li).value.split('\n').map((x) => x.trim()).filter(Boolean) : undefined,
      };
    });
  };
  const render = () => {
    el.innerHTML = String(html`<div class="stack">
      <p class="hint">Lo que ${s.name} anota en cada turno. Nunca es obligatorio: al guardar se le dice qué quedó vacío. Los
        cambios valen para los turnos nuevos; lo que ya se anotó se queda como estaba.</p>
      ${fields.length
        ? html`<ol class="stack field-list">${fields.map((f, i) => fieldEditor(f, i, fields.length))}</ol>`
        : html`<div class="card">${empty('file', 'Sin formulario', `${s.name} no anota nada aparte del turno. Añade un campo para empezar.`)}</div>`}
      <datalist id="units">${UNITS.map((u) => html`<option value="${u}"></option>`)}</datalist>
      <button type="button" class="btn btn-secondary btn-block" data-add>${icon('plus', 18)} Añadir un campo</button>
      <button type="button" class="btn btn-primary btn-block btn-lg" data-save>${icon('check')} Guardar formulario</button>
      <a class="btn btn-ghost btn-block" href="#/services/${id}">${icon('back', 18)} Volver al servicio</a>
    </div>`);
    for (const li of el.querySelectorAll('[data-field]')) {
      const i = Number(li.dataset.field);
      $('[data-type]', li).addEventListener('change', (e) => {
        const type = e.target.value;
        const numeric = ['number', 'check_number', 'pressure'].includes(type);
        $('[data-unit-field]', li).hidden = !numeric;
        $('[data-range-field]', li).hidden = !numeric;
        $('[data-range2]', li).hidden = type !== 'pressure';
        $('[data-range-label]', li).textContent = type === 'pressure' ? 'Sistólica' : 'De';
        $('[data-options-field]', li).hidden = type !== 'choices';
      });
      // °F ⇄ °C and mg/dL ⇄ mmol/L: the normal range follows the unit.
      const unit = $('[data-unit]', li);
      let unitBefore = unit.value.trim();
      unit.addEventListener('change', () => {
        const conv = convertUnit(unitBefore, unit.value.trim());
        if (conv) {
          for (const k of ['low', 'high', 'low2', 'high2']) {
            const input = $(`[data-${k}]`, li);
            if (input.value !== '') input.value = conv(Number(input.value));
          }
        }
        unitBefore = unit.value.trim();
      });
      for (const b of li.querySelectorAll('[data-move]')) {
        b.addEventListener('click', () => {
          collect();
          const j = i + Number(b.dataset.move);
          [fields[i], fields[j]] = [fields[j], fields[i]];
          render();
        });
      }
      $('[data-remove]', li).addEventListener('click', async () => {
        collect();
        const ok = await dialog({
          title: `¿Quitar «${fields[i].label || 'este campo'}»?`,
          message: 'Deja de salir en los turnos nuevos. Lo que ya se anotó en turnos anteriores se queda.',
          confirmText: 'Quitar',
          danger: true,
        });
        if (!ok) return;
        fields.splice(i, 1);
        render();
      });
    }
    $('[data-add]', el).addEventListener('click', () => {
      collect();
      fields.push({ label: '', type: 'text' });
      render();
      el.querySelector(`[data-field="${fields.length - 1}"] [data-label]`)?.focus();
    });
    $('[data-save]', el).addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        collect();
        fields = await setServiceForm(id, fields);
        toast('Formulario guardado', 'ok');
        render();
      }));
  };
  render();
}

// ---- The turn's chat: private to the service and whoever asked; nothing in it can be changed or deleted ----------------

/** What is being written, so the screen updating every few seconds doesn't wipe it. */
const chatDrafts = new Map();

const CHAT_KIND = { call: 'Nota al llamar', cancel: 'Por qué se canceló' };

function chatSection(t, service, messages) {
  if (messages === null) return '';
  const me = state.me.user;
  const canWrite = service.serves || t.created_by === me.id || t.teacher_id === me.id;
  if (!messages.length && !canWrite) return '';
  const other = service.serves ? (t.teacher_name || t.created_by_name) : t.service_name;
  return html`<section class="card stack turn-chat" data-chat>
    <h2 class="card-title">${icon('chat')} Mensajes del turno</h2>
    ${messages.length
      ? html`<ol class="chat-list">${messages.map((m) => html`<li class="chat-msg ${m.author_id === me.id ? 'is-mine' : ''} ${m.kind !== 'message' ? 'is-' + m.kind : ''}">
          ${CHAT_KIND[m.kind] ? html`<span class="chat-kind">${CHAT_KIND[m.kind]}</span>` : ''}
          <p>${m.body}</p>
          <small>${m.author_id === me.id ? 'Tú' : m.author_name} · ${fmtDateTime(m.created_at)}</small>
        </li>`)}</ol>`
      : html`<p class="hint">Escríbele a ${other} sobre este turno. Solo lo ven quien atiende el servicio y quien lo pidió.</p>`}
    ${canWrite
      ? html`<form class="chat-form" data-chat-form>
          <textarea name="body" rows="2" maxlength="1000" placeholder="Escribe un mensaje…" aria-label="Mensaje" data-chat-body></textarea>
          <button class="btn btn-primary" type="submit" aria-label="Enviar">${icon('send', 18)}</button>
        </form>
        <p class="hint">Los mensajes quedan guardados en el turno: no se pueden cambiar ni borrar.</p>`
      : ''}
  </section>`;
}

function bindChat(el, t, reload) {
  const form = $('[data-chat-form]', el);
  if (!form) return;
  const box = $('[data-chat-body]', form);
  const focused = chatDrafts.has(`focus-${t.id}`);
  box.value = chatDrafts.get(t.id) || '';
  if (focused) {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
  box.addEventListener('input', () => chatDrafts.set(t.id, box.value));
  box.addEventListener('focus', () => chatDrafts.set(`focus-${t.id}`, true));
  box.addEventListener('blur', () => chatDrafts.delete(`focus-${t.id}`));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = box.value.trim();
    if (!body) return;
    busy(form.querySelector('[type=submit]'), async () => {
      await sendTurnMessage(t.id, body);
      chatDrafts.delete(t.id);
      await reload();
    });
  });
}

export async function turnDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;
  let history = null;

  async function load() {
    const [t, services, events, messages, form] = await Promise.all([
      getTurn(id), servicesOverview(), turnEvents(id).catch(() => []), turnMessages(id).catch(() => null),
      turnForm(id).catch(() => null),
    ]);
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
            ${t.status === 'waiting' && t.position ? fact('Turno', `#${t.position} en la fila`) : ''}
            ${t.status === 'waiting' ? fact('Tiempo', waitingText(t)) : ''}
            ${t.received_at ? fact('Recibido', `${t.received_by_name} · ${timeOf(t.received_at)}`) : ''}
            ${t.teacher_name && t.teacher_id !== t.created_by ? fact('Ahora está con', t.teacher_name) : ''}
            ${fact('Atiende', t.handled_by_name)}
            ${fact('Qué se hizo', t.resolution)}
            ${service.serves && t.out_of_order ? fact('Orden', 'Se escogió antes que otros turnos de la fila') : ''}
          </div>
          ${steps(t)}
        </section>
        ${actions.map((a) => actionButton(a))}
        ${formSection(t, service, form)}
        ${chatSection(t, service, messages)}
        ${changesSection(events)}
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
    bindChat(el, t, load);
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
                <span class="item-sub">${{ visit: `El estudiante va · ${s.arrive_minutes} min para llegar`, room: 'El profesional va al salón', either: `Decide quien atiende · ${s.arrive_minutes} min para llegar`, support: 'Ayuda al personal' }[s.mode]}
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
    ? { name: '', mode: 'visit', arrive_minutes: 5, roles: [], reasons: ['Otro'], active: true, keep_open: false }
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
          <label class="choice"><input type="radio" name="mode" value="either" ${s.mode === 'either' ? 'checked' : ''}>
            <span><strong>Decide quien atiende, en cada turno</strong><small>Al recibir el turno, el profesional elige: «Llamar a la oficina» (como Enfermería) o «Voy al salón» (como Trabajo Social).</small></span></label>
          <label class="choice"><input type="radio" name="mode" value="support" ${s.mode === 'support' ? 'checked' : ''}>
            <span><strong>Ayuda al personal</strong><small>Como Soporte IT: sin estudiante; el maestro pide ayuda para su salón, «Voy en camino» y luego «Resuelto».</small></span></label>
        </div>
        <label class="field" data-minutes ${['visit', 'either'].includes(s.mode) ? '' : 'hidden'}><span>Minutos para llegar</span>
          <input type="number" name="minutes" min="1" max="30" value="${s.arrive_minutes}" inputmode="numeric"></label>
        <p class="hint" data-minutes ${['visit', 'either'].includes(s.mode) ? '' : 'hidden'}>El tiempo empieza cuando el maestro toca «Ya salió». Si no llega en ese tiempo, se avisa al servicio, al maestro y a Seguridad.</p>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('clock')} ¿Cuánto duran los turnos?</h2>
        <div class="choices">
          <label class="choice"><input type="radio" name="life" value="day" ${s.keep_open ? '' : 'checked'}>
            <span><strong>Se cierran al final del día</strong><small>Como Enfermería: lo que nadie atendió se cierra solo a la hora de salida y no pasa al día siguiente.</small></span></label>
          <label class="choice"><input type="radio" name="life" value="open" ${s.keep_open ? 'checked' : ''}>
            <span><strong>Siguen abiertos hasta que alguien los cierre</strong><small>Como Soporte IT o Trabajo Social: pasan al día siguiente. Al entrar, a quien atiende el servicio se le pregunta si sigue con cada uno o lo cierra.</small></span></label>
        </div>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('clock')} Horario para pedir turnos</h2>
        <div class="choices">
          <label class="choice"><input type="radio" name="hours" value="school" ${s.open_from ? '' : 'checked'}>
            <span><strong>El horario de clases</strong><small>El de «Calendario escolar»${!s.open_from && s.opens ? ` (${fmtTime(s.opens)} – ${fmtTime(s.closes)})` : ''}.</small></span></label>
          <label class="choice"><input type="radio" name="hours" value="own" ${s.open_from ? 'checked' : ''}>
            <span><strong>Un horario propio</strong><small>Por ejemplo, si el servicio llega más tarde o se va antes.</small></span></label>
        </div>
        <div class="grid2" data-own-hours ${s.open_from ? '' : 'hidden'}>
          <label class="field"><span>Desde</span><input type="time" name="open_from" value="${s.open_from || s.opens || '07:40'}"></label>
          <label class="field"><span>Hasta</span><input type="time" name="open_until" value="${s.open_until || s.closes || '15:30'}"></label>
        </div>
        <p class="hint">Fuera de este horario, y los días sin clases, nadie puede pedir turnos a este servicio. Quien lo atiende sí puede anotar una visita.</p>
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
      ${isNew
        ? ''
        : html`<a class="card link-card room-link" href="#/services/${s.id}/form">${icon('file')}<span>
            <strong>Formulario del turno</strong>
            <small>${s.form_fields?.length ? `${plural(s.form_fields.length, 'campo', 'campos')}: lo que ${s.name} anota en cada turno` : 'Sin formulario. Añade lo que se anota en cada turno (síntomas, signos vitales…)'}</small></span>${icon('chevron', 18)}</a>`}
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('check')} Guardar</button>
    </form>`);

  const form = $('[data-form]', el);
  for (const input of el.querySelectorAll('[name=mode]')) {
    input.addEventListener('change', () => {
      // Soporte IT usually carries its requests to the next day.
      if (isNew) form.querySelector(`[name=life][value=${form.mode.value === 'support' ? 'open' : 'day'}]`).checked = true;
      for (const node of el.querySelectorAll('[data-minutes]')) node.hidden = !['visit', 'either'].includes(form.mode.value);
    });
  }
  for (const input of el.querySelectorAll('[name=hours]')) {
    input.addEventListener('change', () => { $('[data-own-hours]', el).hidden = form.hours.value !== 'own'; });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const own = form.hours.value === 'own';
      const from = own ? form.open_from.value : null;
      const until = own ? form.open_until.value : null;
      if (own && (!from || !until)) throw new Error('Indica desde qué hora y hasta qué hora recibe turnos.');
      if (own && from >= until) throw new Error('La hora final debe ser después de la inicial.');
      const saved = await saveService({
        id: isNew ? null : s.id,
        name: form.querySelector('[name=name]').value.trim(),
        mode: form.mode.value,
        arriveMinutes: Number(form.minutes.value) || 5,
        roles: [...el.querySelectorAll('[name=role]:checked')].map((i) => i.value),
        reasons: form.reasons.value.split('\n').map((r) => r.trim()).filter(Boolean),
        active: isNew ? true : form.active.checked,
      });
      const keep = form.querySelector('[name=life]:checked')?.value === 'open';
      if (keep !== !!s.keep_open || isNew) await setServiceKeepOpen(saved?.id || s.id, keep);
      if (from !== (s.open_from || null) || until !== (s.open_until || null)) await setServiceHours(saved?.id || s.id, from, until);
      toast('Servicio guardado', 'ok');
      go('/services', { replace: true });
    });
  });
}

/**
 * One student on the way back to class («Regresando a clase»): any teacher can open it. Only the name, the group
 * and the time (never the service or the reason); whoever can see En vivo also gets the whole turn.
 */
export async function returningDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const list = (await returningStudents().catch(() => [])) || [];
    if (!isCurrent()) return;
    const x = list.find((r) => r.id === id);
    if (!x) {
      el.innerHTML = String(html`<div class="stack">
        <div class="card">${empty('check', 'Ya no va de regreso', 'Ya llegó a un salón o el turno se cerró.')}</div>
        <a class="btn btn-ghost btn-block" href="#/turns">${icon('back', 18)} Volver a Turnos</a>
      </div>`);
      return;
    }
    const mine = (me.groups || []).includes(x.group_name);
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${x.late || x.asked ? 'is-urgent' : ''}">
          <p class="alert-kind">${icon('back', 18)} Regresando a clase ${x.asked ? html`<span class="tag tag-warn">¿Ya llegó?</span>` : ''}</p>
          <h2>${x.student_name} <span class="muted">· ${x.group_name}</span></h2>
          ${x.due_at ? html`<p class="turn-timer ${x.late ? 'is-late' : ''}" data-due="${x.due_at}">${countdown(x.due_at)}</p>` : ''}
          <div class="facts">
            ${fact('Salió', `${timeOf(x.returning_at)} · ${timeAgo(x.returning_at)}`)}
            ${fact('Debe llegar', x.due_at ? timeOf(x.due_at) : null)}
          </div>
        </section>
        <button type="button" class="btn btn-primary btn-block btn-lg" data-in-class>${icon('check')} Está en mi clase</button>
        ${x.asked && mine ? html`<button type="button" class="btn btn-ghost-danger btn-block" data-missing>${icon('alert', 18)} No ha llegado</button>` : ''}
        ${can(me, 'live') ? html`<a class="btn btn-secondary btn-block" href="#/live/turn/${x.id}">${icon('pulse', 18)} Ver el turno completo</a>` : ''}
        <p class="hint">Si llegó a tu clase, toca «Está en mi clase» y le avisamos a quien lo envió. Así no se avisa a Seguridad por error.</p>
        <a class="btn btn-ghost btn-block" href="#/turns">${icon('back', 18)} Todos los turnos</a>
      </div>`);
    $('[data-in-class]', el).addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await advanceTurn(x.id, 'back');
        toast(STEP_DONE.back, 'ok');
        go('/turns', { replace: true });
      }));
    $('[data-missing]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const ok = await dialog({
          title: `¿${x.student_name} no ha llegado?`,
          message: 'Se avisa ahora a Seguridad, al servicio y a los maestros de su grupo. Si después llega, toca «Está en mi clase».',
          confirmText: 'No ha llegado',
          cancelText: 'Volver',
          danger: true,
        });
        if (!ok) return;
        await advanceTurn(x.id, 'missing');
        toast(STEP_DONE.missing, 'ok');
        await load();
      }));
  }

  await load();
  tickCountdowns(ctx);
  keepFresh(ctx, load);
}
