// Visitas: a parent (or anyone from outside) arrives and asks for someone. Whoever receives visits (Seguridad,
// Secretaría, the dirección… by the "visitors" permission) notes it in Alertas: who came, whether they have an
// appointment, whom they're looking for (a service or one person) and where they're waiting. That person answers
// "Voy en camino", "Que pase a mi oficina", "Que espere" or something else, and whoever noted it hears the answer.
import { answerVisit, closeVisit, createVisit, getVisit, markAlertsRead, visitTargets } from '../backend.js';
import { $, busy, can, dialog, fmtDateTime, fmtTime, html, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { fact, keepFresh } from './students.js';

// Where the parent usually waits; anything else can be typed.
const PLACES = ['Seguridad', 'Dirección', 'Secretaría', 'Recepción'];
// The place of whoever notes it, until they use another one.
const ROLE_PLACE = { seguridad: 'Seguridad', director: 'Dirección', secretary: 'Secretaría' };
const PLACE_KEY = 'lah:visit-place';
const WAIT_MINUTES = [5, 10, 15, 30];
// Not available: what the service's people said (Disponible otherwise).
const AWAY = { meeting: 'En reunión', lunch: 'Almuerzo', away: 'Fuera' };

const isOpen = (v) => v.status === 'waiting' || v.status === 'answered';
/** Notes visits and sees all of today's. */
export const receivesVisits = (u) => can(u, 'visitors');
/** The visit is for me, or for a service I attend. */
const isForMe = (v, me) => v.target_id === me.id || (!!v.service_id && (me.serves || []).some((s) => s.id === v.service_id));

function answerText(v) {
  return (
    {
      on_the_way: `${v.answered_by_name} va en camino`,
      come: `Que pase a ${v.answer_place}`,
      wait: `Que espere${v.answer_note ? ` ${v.answer_note}` : ' un momento'}`,
      other: `${v.answered_by_name} respondió`,
    }[v.answer] || 'Respondió'
  );
}

function visitTag(v) {
  if (v.status === 'waiting') return { label: 'Sin respuesta', cls: 'tag-warn' };
  if (v.status === 'done') return { label: 'Atendida', cls: 'tag-ok' };
  if (v.status === 'cancelled') return { label: 'Se fue', cls: '' };
  return { label: answerText(v), cls: ['wait', 'other'].includes(v.answer) ? 'tag-info' : 'tag-ok' };
}

const citado = (v) => html`<span class="tag ${v.appointment ? 'tag-info' : ''}">${v.appointment ? 'Citado' : 'Sin cita'}</span>`;

// ---- Answers -------------------------------------------------------------------------------

const ANSWER_DONE = {
  on_the_way: 'Le avisamos que vas en camino.',
  come: 'Le avisamos que pase.',
  wait: 'Le avisamos que espere.',
  other: 'Le enviamos tu respuesta.',
};

/** Asks what each answer needs (where, how long, what) and sends it. Resolves false if cancelled. */
async function sendAnswer(v, answer) {
  const me = state.me.user;
  let extra = {};
  if (answer === 'come') {
    const where = me.room || (v.service_id ? `la oficina de ${v.target_name}` : `la oficina de ${me.full_name}`);
    const r = await dialog({
      title: '¿A dónde pasa?',
      message: `Le decimos a ${v.created_by_name} que lo envíe.`,
      body: html`<label class="field"><span>Lugar</span>
        <input name="place" maxlength="60" required value="${where}" autocomplete="off"></label>`,
      confirmText: 'Que pase',
      collect: true,
    });
    if (!r) return false;
    if (!r.place.trim()) throw new Error('Escribe a dónde pasa.');
    extra = { place: r.place.trim() };
  }
  if (answer === 'wait') {
    const r = await dialog({
      title: '¿Cuánto debe esperar?',
      body: html`<div class="chips" role="radiogroup" aria-label="Cuánto debe esperar">
        ${WAIT_MINUTES.map((m, i) => html`<label class="chip"><input type="radio" name="minutes" value="${m}" ${i === 1 ? 'checked' : ''}><span>${m} min</span></label>`)}
      </div>`,
      confirmText: 'Que espere',
      collect: true,
    });
    if (!r) return false;
    extra = { note: r.minutes ? `${r.minutes} min` : '' };
  }
  if (answer === 'other') {
    const r = await dialog({
      title: 'Otra respuesta',
      message: `Le llega a ${v.created_by_name}.`,
      body: html`<label class="field"><span>Respuesta</span>
        <textarea name="note" rows="3" maxlength="200" required placeholder="Ej. Estoy en reunión: que regrese mañana a las 8"></textarea></label>`,
      confirmText: 'Enviar',
      collect: true,
    });
    if (!r) return false;
    if (!r.note.trim()) throw new Error('Escribe tu respuesta.');
    extra = { note: r.note.trim() };
  }
  await answerVisit(v.id, answer, extra);
  toast(ANSWER_DONE[answer], 'ok');
  return true;
}

async function sendClose(v, status) {
  if (status === 'cancelled') {
    const ok = await dialog({
      title: '¿Se fue?',
      message: `${v.visitor_name}. Se cierra la visita${isForMe(v, state.me.user) ? '' : ` y le avisamos a ${v.target_name} que ya no lo buscan`}.`,
      confirmText: 'Se fue',
      cancelText: 'Volver',
      danger: true,
    });
    if (!ok) return false;
  }
  await closeVisit(v.id, status);
  toast(status === 'done' ? 'Visita atendida.' : 'Visita cerrada.', 'ok');
  return true;
}

// ---- In Alertas ----------------------------------------------------------------------------

function visitItem(v, me) {
  const t = visitTag(v);
  const open = isOpen(v);
  const forMe = isForMe(v, me);
  const sub = forMe
    ? [v.student, `espera en ${v.place}`, `avisó ${v.created_by_name}`]
    : [v.student, `busca a ${v.target_name}`, `en ${v.place}`];
  return html`<div class="item alert-item ${forMe && v.status === 'waiting' ? 'is-urgent' : ''} ${open ? '' : 'is-muted'}" data-visit="${v.id}">
    <a class="item-link" href="#/alerts/visit/${v.id}">
      <span class="item-icon">${icon('door')}</span>
      <span class="item-main">
        <strong>${v.visitor_name}</strong>
        <span class="item-sub">${sub.filter(Boolean).join(' · ')}</span>
        <span class="item-tags">${citado(v)}<span class="tag ${t.cls}">${t.label}</span>
          ${v.status === 'waiting' ? html`<span class="tag">${icon('clock', 14)} ${timeAgo(v.created_at)}</span>` : ''}</span>
      </span>
    </a>
    ${forMe && v.status === 'waiting' ? html`<button type="button" class="btn btn-primary btn-sm" data-visit-answer="on_the_way">Voy</button>` : ''}
  </div>`;
}

/**
 * Alertas: "Te buscan" (open visits for me or my services) and, for whoever receives visits, today's visits and
 * the button to note a new one. Nothing for the rest.
 */
export function visitsSection(visits, me) {
  const mine = visits.filter((v) => isOpen(v) && isForMe(v, me));
  const order = (v) => ({ waiting: 0, answered: 1 }[v.status] ?? 2);
  const today = receivesVisits(me)
    ? visits.filter((v) => !mine.includes(v)).sort((a, b) => order(a) - order(b) || b.created_at.localeCompare(a.created_at))
    : [];
  const unanswered = today.filter((v) => v.status === 'waiting').length;
  return html`
    ${mine.length
      ? html`<section class="section" data-visits-mine>
          <h3 class="section-title">Te buscan <span class="count warn">${mine.length}</span></h3>
          <div class="list">${mine.map((v) => visitItem(v, me))}</div>
        </section>`
      : ''}
    ${receivesVisits(me)
      ? html`<section class="section" data-visits>
          <h3 class="section-title">Visitas ${unanswered ? html`<span class="count warn">${unanswered} sin respuesta</span>` : ''}</h3>
          <div class="alert-actions">
            <a class="alert-action" href="#/alerts/visit/new">${icon('door', 26)}<strong>Llegó una visita</strong><small>Un padre busca a alguien</small></a>
          </div>
          ${today.length ? html`<div class="list">${today.map((v) => visitItem(v, me))}</div>` : html`<p class="hint">Hoy no han llegado visitas.</p>`}
        </section>`
      : ''}`;
}

/** The "Voy" buttons of the list. */
export function bindVisits(root, visits, reload) {
  for (const btn of root.querySelectorAll('[data-visit-answer]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const v = visits.find((x) => x.id === Number(btn.closest('[data-visit]').dataset.visit));
      busy(btn, async () => {
        if (await sendAnswer(v, btn.dataset.visitAnswer)) await reload();
      });
    });
  }
}

// ---- New visit -----------------------------------------------------------------------------

function availability(service) {
  const staff = service.staff || [];
  if (!staff.length) return { text: 'Nadie lo atiende', ok: false };
  if (staff.some((p) => p.status === 'available')) return { text: 'Disponible', ok: true };
  const next = [...staff].sort((a, b) => String(a.until || '~').localeCompare(String(b.until || '~')))[0];
  return { text: `${AWAY[next.status] || 'No disponible'}${next.until ? ` hasta ${fmtTime(new Date(next.until))}` : ''}`, ok: false };
}

function lastPlace(me) {
  try {
    const saved = localStorage.getItem(PLACE_KEY);
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  return ROLE_PLACE[me.role] || '';
}

function rememberPlace(place) {
  try {
    localStorage.setItem(PLACE_KEY, place);
  } catch {
    /* storage unavailable */
  }
}

export async function newVisitView({ el }) {
  const me = state.me.user;
  const { services, people } = await visitTargets();
  const place = lastPlace(me);
  const onlyPeople = !services.length;

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('door')} ¿Quién llegó?</h2>
        <label class="field"><span>Nombre</span>
          <input name="visitor" required maxlength="100" autocomplete="off" autocapitalize="words" placeholder="Ej. Ana Ruiz, mamá"></label>
        <label class="field"><span>¿De qué estudiante? <em class="optional">opcional</em></span>
          <input name="student" maxlength="120" autocomplete="off" autocapitalize="words" placeholder="Ej. José Pérez, 5-B"></label>
        <div class="field"><span>¿Está citado?</span>
          <div class="chips" role="radiogroup" aria-label="¿Está citado?">
            <label class="chip"><input type="radio" name="appointment" value="yes"><span>Sí, tiene cita</span></label>
            <label class="chip"><input type="radio" name="appointment" value="no"><span>No tiene cita</span></label>
          </div>
        </div>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('user')} ¿A quién busca?</h2>
        <div class="choices" ${onlyPeople ? 'hidden' : ''}>
          ${services.map((s) => {
            const a = availability(s);
            return html`<label class="choice"><input type="radio" name="to" value="service:${s.id}" ${s.staff.length ? '' : 'disabled'}>
              <span><strong>${s.name}</strong><small class="${a.ok ? '' : 'is-off'}">${a.text}</small></span></label>`;
          })}
          <label class="choice"><input type="radio" name="to" value="person" ${onlyPeople ? 'checked' : ''}>
            <span><strong>Otra persona</strong><small>Un maestro, la dirección…</small></span></label>
        </div>
        <label class="field" data-person ${onlyPeople ? '' : 'hidden'}><span>Persona</span>
          <select name="person">
            <option value="" selected disabled>Elige a la persona…</option>
            ${people.map((p) => html`<option value="${p.id}">${p.name}${p.position || p.role ? ` · ${p.position || p.role}` : ''}</option>`)}
          </select></label>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('school')} ¿Dónde espera?</h2>
        <div class="quick" data-places>${PLACES.map(
          (p) => html`<button type="button" class="chip-btn ${p === place ? 'active' : ''}" data-place="${p}">${p}</button>`,
        )}</div>
        <input name="place" maxlength="60" required value="${place}" autocomplete="off" placeholder="Ej. Seguridad" aria-label="Dónde espera">
        <label class="field"><span>Asunto <em class="optional">opcional</em></span>
          <textarea name="note" rows="2" maxlength="300" placeholder="Ej. Viene por la cita de las 10"></textarea></label>
      </section>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} Avisar</button>
      <p class="hint center">Le llega al instante, con alarma. Su respuesta te llega aquí y como aviso.</p>
    </form>`);

  const form = $('[data-form]', el);
  for (const input of el.querySelectorAll('[name=to]')) {
    input.addEventListener('change', () => {
      $('[data-person]', el).hidden = form.querySelector('[name=to]:checked')?.value !== 'person';
    });
  }
  for (const chip of el.querySelectorAll('[data-place]')) {
    chip.addEventListener('click', () => {
      form.place.value = chip.dataset.place;
      for (const c of el.querySelectorAll('[data-place]')) c.classList.toggle('active', c === chip);
    });
  }
  form.place.addEventListener('input', () => {
    for (const c of el.querySelectorAll('[data-place]')) c.classList.toggle('active', c.dataset.place === form.place.value.trim());
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const visitor = form.visitor.value.trim().replace(/\s+/g, ' ');
      if (visitor.length < 2) throw new Error('Escribe quién llegó.');
      const appointment = form.querySelector('[name=appointment]:checked')?.value;
      if (!appointment) throw new Error('Elige si está citado.');
      const to = form.querySelector('[name=to]:checked')?.value;
      if (!to) throw new Error('Elige a quién busca.');
      if (to === 'person' && !form.person.value) throw new Error('Elige a la persona que busca.');
      const where = form.place.value.trim().replace(/\s+/g, ' ');
      if (!where) throw new Error('Escribe dónde espera.');
      const v = await createVisit({
        visitor,
        student: form.student.value.trim(),
        to: to === 'person' ? { personId: form.person.value } : { serviceId: Number(to.split(':')[1]) },
        appointment: appointment === 'yes',
        place: where,
        note: form.note.value.trim(),
      });
      rememberPlace(where);
      toast(`Avisado. Te llega aquí la respuesta de ${v.target_name}.`, 'ok');
      go(`/alerts/visit/${v.id}`, { replace: true });
    });
  });
}

// ---- Detail --------------------------------------------------------------------------------

function steps(v) {
  const list = [
    ['Llegó', v.created_by_name, v.created_at],
    [v.answer ? answerText(v) : 'Respuesta', v.answer && v.answer !== 'on_the_way' ? v.answered_by_name : null, v.answered_at],
  ];
  if (v.status === 'done') list.push(['Atendida', v.closed_by_name, v.closed_at]);
  if (v.status === 'cancelled') list.push(['Se fue', v.closed_by_name, v.closed_at]);
  return html`<ol class="timeline steps">
    ${list.map(([label, name, at]) => html`<li class="${at ? 'is-done' : ''}"><strong>${label}</strong>${at ? html`${name ? ` · ${name}` : ''}<small>${timeAgo(at)}</small>` : ''}</li>`)}
  </ol>`;
}

function hintFor(v, forMe) {
  if (!isOpen(v)) return '';
  if (forMe) {
    return v.status === 'waiting'
      ? `Te espera en ${v.place}. Tu respuesta le llega al instante a ${v.created_by_name}.`
      : 'Puedes cambiar tu respuesta. Cuando termines, toca «Atendida».';
  }
  if (v.status === 'waiting') return `Le avisamos a ${v.target_name}. Su respuesta te llega aquí y como aviso.`;
  if (v.answer === 'come') return `Indícale que pase a ${v.answer_place}.`;
  if (v.answer === 'on_the_way') return `Que espere en ${v.place}: ${v.answered_by_name} va en camino.`;
  if (v.answer === 'wait') return `Que espere en ${v.place}.`;
  return '';
}

export async function visitDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const v = await getVisit(id);
    if (!isCurrent()) return;
    const forMe = isForMe(v, me);
    const open = isOpen(v);
    const t = visitTag(v);
    const canClose = open && (forMe || receivesVisits(me) || v.created_by === me.id);
    const hint = hintFor(v, forMe);
    el.innerHTML = String(html`
      <div class="stack" data-visit="${v.id}">
        <section class="card stack alert-head ${forMe && v.status === 'waiting' ? 'is-urgent' : ''} ${v.status === 'done' ? 'is-ok' : ''}">
          <p class="alert-kind">${icon('door', 18)} Visita · <span class="tag ${t.cls}">${t.label}</span></p>
          <h2>${v.visitor_name}</h2>
          <div class="facts">
            ${fact('Estudiante', v.student)}
            ${fact('Busca a', v.target_name)}
            ${fact('Cita', v.appointment ? 'Está citado' : 'Sin cita')}
            ${fact('Espera en', v.place)}
            ${fact('Asunto', v.note)}
            ${fact('Avisó', `${v.created_by_name} · ${fmtDateTime(v.created_at)}`)}
            ${v.answer === 'other' ? fact('Respuesta', `«${v.answer_note}»`) : ''}
          </div>
          ${steps(v)}
        </section>
        ${forMe && open
          ? html`<button type="button" class="btn ${v.status === 'waiting' ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-answer="on_the_way">${icon('send')} Voy en camino</button>
              <button type="button" class="btn btn-secondary btn-block" data-answer="come">${icon('door')} Que pase a mi oficina</button>
              <button type="button" class="btn btn-secondary btn-block" data-answer="wait">${icon('clock')} Que espere</button>
              <button type="button" class="btn btn-secondary btn-block" data-answer="other">${icon('chat')} Otra respuesta</button>`
          : ''}
        ${canClose
          ? html`<button type="button" class="btn ${v.status === 'answered' ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-close="done">${icon('check')} Atendida</button>
              <button type="button" class="btn btn-ghost-danger btn-block" data-close="cancelled">Se fue</button>`
          : ''}
        ${hint ? html`<p class="hint">${hint}</p>` : ''}
        <a class="btn btn-ghost btn-block" href="#/turns">${icon('back', 18)} Todos los turnos</a>
      </div>`);

    for (const btn of el.querySelectorAll('[data-answer]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          if (await sendAnswer(v, btn.dataset.answer)) await load();
        }),
      );
    }
    for (const btn of el.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          if (await sendClose(v, btn.dataset.close)) await load();
        }),
      );
    }
  }

  await load();
  // Seen: stops the repeated pushes of this visit for me.
  markAlertsRead(`#/turns/visit/${id}`).catch(() => {});
  keepFresh(ctx, load);
}
