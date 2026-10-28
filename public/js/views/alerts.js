// Alertas: "No ha llegado" (a student who should have arrived didn't), Salidas (someone comes to pick up a
// student) and Relevo (a teacher needs someone to cover the room for a moment). Students are only kept for
// 24 hours; their names disappear from these screens after that.
import {
  advancePickup,
  cancelRelief,
  createPickup,
  createStudentAlert,
  getMissingAlert,
  getPickup,
  getRelief,
  listAlerts,
  listVisits,
  markAlertsRead,
  requestRelief,
  manageStudentAlert,
  resolveStudentAlert,
  takeRelief,
} from '../backend.js';
import { $, busy, can, dialog, fmtDateTime, fmtTime, html, isStaff, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { empty } from './common.js';
import { confirmStudent, fact, keepFresh, studentFields, studentFrom } from './students.js';
import { bindVisits, visitsSection } from './visits.js';

// A relief request nobody answered in this time is shown as expired.
const RELIEF_OPEN_MIN = 30;
// Quick choices for where the student was coming from.
const PLACES = {
  'Baño': 'Venía del baño',
  'Enfermería': 'Venía de la enfermería',
  'Oficina': 'Venía de la oficina',
  'Comedor': 'Venía del comedor',
  'Biblioteca': 'Venía de la biblioteca',
  'Otro salón': 'Venía de otro salón',
};

const PICKUP_STATUS = {
  scheduled: { label: 'Anotada', cls: '' },
  arrived: { label: 'Llegó el encargado', cls: 'tag-danger' },
  on_the_way: { label: 'Seguridad va al salón', cls: 'tag-warn' },
  delivered: { label: 'Entregado', cls: 'tag-ok' },
  cancelled: { label: 'Cancelada', cls: '' },
};

const studentLabel = (row) => `${row.student_name || 'Estudiante'} (${row.group_name})`;
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
const reliefExpired = (r) => !r.taken_at && !r.cancelled_at && Date.now() - new Date(r.created_at) > RELIEF_OPEN_MIN * 60000;
const reliefOpen = (r) => !r.taken_at && !r.cancelled_at && !reliefExpired(r);
const canAskRelief = (u) => u.role !== 'admin' && !!u.coverage;
const isSecurity = (u) => can(u, 'security');

// ---- List --------------------------------------------------------------------------------

/** Open, found, or closed at the end of the school day without anyone confirming where the student was. */
const missingState = (a) => (!a.resolved_at ? 'open' : a.unconfirmed ? 'unconfirmed' : 'found');
const MISSING_TITLE = { open: 'No ha llegado', found: 'Apareció', unconfirmed: 'Sin confirmar' };

function missingItem(a) {
  const st = missingState(a);
  const open = st === 'open';
  return html`<a class="item alert-item ${open ? 'is-urgent' : 'is-muted'}" href="#/alerts/missing/${a.id}">
    <span class="item-icon ${open ? 'is-danger' : st === 'found' ? 'is-ok' : ''}">${icon(st === 'found' ? 'check' : 'alert')}</span>
    <span class="item-main">
      <strong>${MISSING_TITLE[st]}: ${studentLabel(a)}</strong>
      <span class="item-sub">${[a.place, a.room ? `Salón ${a.room}` : null, `avisó ${a.created_by_name}`].filter(Boolean).join(' · ')}</span>
      <span class="item-tags">
        ${open
          ? html`<span class="tag tag-danger">${icon('clock', 14)} ${timeAgo(a.created_at)}</span>`
          : st === 'unconfirmed'
            ? html`<span class="tag tag-warn">Se cerró al terminar el día</span>`
            : html`<span class="tag tag-ok">${a.resolved_by_name}${a.found_place ? ` · ${a.found_place}` : ''}</span>`}
        <span class="tag">${a.audience === 'all' ? 'Todo el personal' : 'Seguridad'}</span>
      </span>
    </span>
    ${icon('chevron', 18)}
  </a>`;
}

function pickupItem(k) {
  const s = PICKUP_STATUS[k.status] || PICKUP_STATUS.scheduled;
  const done = k.status === 'delivered' || k.status === 'cancelled';
  return html`<a class="item alert-item ${k.status === 'arrived' ? 'is-urgent' : ''} ${done ? 'is-muted' : ''}" href="#/alerts/pickup/${k.id}">
    <span class="item-icon">${icon('logout')}</span>
    <span class="item-main">
      <strong>${studentLabel(k)}</strong>
      <span class="item-sub">${[k.expected_time ? `Hacia las ${fmtTime(k.expected_time)}` : null, k.room ? `Salón ${k.room}` : null, k.note]
        .filter(Boolean)
        .join(' · ')}</span>
      <span class="item-tags"><span class="tag ${s.cls}">${s.label}</span><span class="tag">Anotó ${k.created_by_name}</span></span>
    </span>
    ${icon('chevron', 18)}
  </a>`;
}

function reliefItem(r, me) {
  const mine = r.requested_by === me.id;
  const open = reliefOpen(r);
  let status;
  if (r.taken_at) status = html`<span class="tag tag-ok">${mine ? `${r.taken_by_name} va a relevarte` : `Lo releva ${r.taken_by_name}`}</span>`;
  else if (r.cancelled_at) status = html`<span class="tag">Ya no lo necesita</span>`;
  else if (!open) status = html`<span class="tag">Sin respuesta</span>`;
  else status = html`<span class="tag tag-danger">${icon('clock', 14)} ${timeAgo(r.created_at)}</span>`;
  return html`<div class="item alert-item ${open && !mine ? 'is-urgent' : ''} ${open ? '' : 'is-muted'}">
    <a class="item-link" href="#/alerts/relief/${r.id}">
      <span class="item-icon ${open ? 'is-danger' : ''}">${icon('swap')}</span>
      <span class="item-main">
        <strong>${mine ? 'Pediste relevo' : `${r.requested_by_name} pide relevo`}</strong>
        <span class="item-sub">${[r.room ? `Salón ${r.room}` : null, r.note].filter(Boolean).join(' · ') || '—'}</span>
        <span class="item-tags">${status}</span>
      </span>
    </a>
    ${open && !mine ? html`<button type="button" class="btn btn-primary btn-sm" data-take="${r.id}">Yo lo relevo</button>` : ''}
    ${open && mine ? html`<button type="button" class="btn btn-ghost btn-sm" data-cancel-relief="${r.id}">Ya no</button>` : ''}
  </div>`;
}

async function askRelief() {
  const me = state.me.user;
  return dialog({
    title: 'Pedir relevo',
    message: 'Les llega a los maestros, la dirección y la secretaría. El primero que pueda toca «Yo lo relevo».',
    body: html`<div class="stack">
      <label class="field"><span>Salón</span>
        <input name="room" maxlength="40" value="${me.room || ''}" placeholder="Ej. 204" autocomplete="off"></label>
      <label class="field"><span>Nota <em class="optional">opcional</em></span>
        <input name="note" maxlength="200" placeholder="Ej. Voy al baño" autocomplete="off"></label>
    </div>`,
    confirmText: 'Pedir relevo',
    onSubmit: (v) => requestRelief(v.room, v.note),
  });
}

function bindReliefButtons(root, reload) {
  for (const btn of root.querySelectorAll('[data-take]')) {
    btn.addEventListener('click', () =>
      busy(btn, async () => {
        await takeRelief(Number(btn.dataset.take));
        toast('Le avisamos que vas en camino', 'ok');
        await reload();
      }),
    );
  }
  for (const btn of root.querySelectorAll('[data-cancel-relief]')) {
    btn.addEventListener('click', () =>
      busy(btn, async () => {
        await cancelRelief(Number(btn.dataset.cancelRelief));
        toast('Pedido de relevo cancelado', 'ok');
        await reload();
      }),
    );
  }
}

export async function alertsView(ctx) {
  const { el, isCurrent } = ctx;
  const me = state.me.user;
  let showResolved = false;
  let data = null;

  const render = () => {
    const missingOpen = data.missing.filter((a) => !a.resolved_at);
    const missingDone = data.missing.filter((a) => a.resolved_at && isToday(a.resolved_at));
    const active = (k) => !['delivered', 'cancelled'].includes(k.status);
    const pickups = [...data.pickups.filter(active), ...data.pickups.filter((k) => !active(k) && isToday(k.created_at))];
    const order = { arrived: 0, on_the_way: 1, scheduled: 2 };
    pickups.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.expected_time || '99').localeCompare(String(b.expected_time || '99')));
    const reliefs = data.reliefs;
    const quiet = !missingOpen.length && !pickups.length && !reliefs.length;

    el.innerHTML = String(html`
      <div class="stack">
        <div class="alert-actions">
          <a class="alert-action is-danger" href="#/alerts/new/missing">${icon('alert', 26)}<strong>No ha llegado</strong><small>Un estudiante no llegó</small></a>
          <a class="alert-action" href="#/alerts/new/pickup">${icon('logout', 26)}<strong>Salida</strong><small>Lo vienen a buscar</small></a>
          ${canAskRelief(me)
            ? html`<button type="button" class="alert-action" data-ask-relief>${icon('swap', 26)}<strong>Pedir relevo</strong><small>Salgo un momento</small></button>`
            : ''}
        </div>

        ${visitsSection(data.visits, me)}

        ${missingOpen.length
          ? html`<section class="section">
              <h3 class="section-title">No han llegado <span class="count danger">${missingOpen.length}</span></h3>
              <div class="list">${missingOpen.map(missingItem)}</div>
            </section>`
          : ''}

        ${reliefs.length
          ? html`<section class="section" data-reliefs>
              <h3 class="section-title">Relevos</h3>
              <div class="list">${reliefs.map((r) => reliefItem(r, me))}</div>
            </section>`
          : ''}

        ${pickups.length
          ? html`<section class="section">
              <h3 class="section-title">Salidas de hoy</h3>
              <div class="list">${pickups.map(pickupItem)}</div>
            </section>`
          : ''}

        ${quiet ? html`<div class="card">${empty('check', 'Todo tranquilo', 'No hay alertas, salidas ni relevos por ahora.')}</div>` : ''}

        ${missingDone.length
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-resolved>${showResolved ? 'Ocultar' : 'Ver'} las cerradas hoy (${missingDone.length})</button>
            ${showResolved ? html`<div class="list">${missingDone.map(missingItem)}</div>` : ''}`
          : ''}

        <p class="hint">${isSecurity(me)
          ? 'Recibes las alertas enviadas a Seguridad y las salidas. Los nombres de los estudiantes se borran a las 24 horas.'
          : 'Ves las alertas que enviaste, las que van a todo el personal y las salidas de tus grupos. Los nombres de los estudiantes se borran a las 24 horas.'}</p>
      </div>`);

    $('[data-ask-relief]', el)?.addEventListener('click', async () => {
      const r = await askRelief();
      if (r) {
        toast('Pedido enviado. Te avisamos cuando alguien vaya.', 'ok');
        go(`/alerts/relief/${r.id}`);
      }
    });
    $('[data-resolved]', el)?.addEventListener('click', () => {
      showResolved = !showResolved;
      render();
    });
    bindReliefButtons(el, load);
    bindVisits(el, data.visits, load);
  };

  async function load() {
    const [next, visits] = await Promise.all([listAlerts(), listVisits()]);
    if (!isCurrent()) return;
    data = { ...next, visits };
    render();
  }

  await load();
  // Seen: stops the repeated pushes of these alerts, and of the visits on screen, for me.
  markAlertsRead().catch(() => {});
  for (const v of data.visits) markAlertsRead(`#/turns/visit/${v.id}`).catch(() => {});
  keepFresh(ctx, load);
}

// ---- New "No ha llegado" ---------------------------------------------------------------

export async function newMissingView({ el }) {
  const me = state.me.user;
  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('alert')} ¿Quién no ha llegado?</h2>
        ${studentFields()}
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('school')} ¿De dónde venía o a dónde iba? <em class="optional">opcional</em></h2>
        <div class="quick" data-places>${Object.keys(PLACES).map((p) => html`<button type="button" class="chip-btn" data-place="${p}">${p}</button>`)}</div>
        <input name="place" maxlength="120" autocomplete="off" placeholder="Ej. Venía del baño" aria-label="De dónde venía o a dónde iba">
        <label class="field"><span>Salón donde debía llegar</span>
          <input name="room" maxlength="40" value="${me.room || ''}" placeholder="Ej. 204" autocomplete="off"></label>
      </section>
      <section class="card stack">
        <h2 class="card-title">${icon('bell')} ¿A quién avisar?</h2>
        <div class="choices">
          <label class="choice"><input type="radio" name="audience" value="security" checked>
            <span><strong>Seguridad</strong><small>Seguridad, la dirección y la secretaría.</small></span></label>
          <label class="choice"><input type="radio" name="audience" value="all">
            <span><strong>Todo el personal</strong><small>Todos los que usan la app en la escuela.</small></span></label>
        </div>
        <label class="field"><span>Nota <em class="optional">opcional</em></span>
          <textarea name="note" rows="2" maxlength="500" placeholder="Ej. Lleva sudadera roja"></textarea></label>
      </section>
      <button class="btn btn-danger btn-block btn-lg" type="submit">${icon('send')} Enviar alerta</button>
      <p class="hint center">Les llega al instante, con alarma. Quien lo encuentre toca «Apareció».</p>
    </form>`);

  const form = $('[data-form]', el);
  for (const chip of el.querySelectorAll('[data-place]')) {
    chip.addEventListener('click', () => {
      form.place.value = PLACES[chip.dataset.place];
      for (const c of el.querySelectorAll('[data-place]')) c.classList.toggle('active', c === chip);
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const typed = studentFrom(form);
      const student = await confirmStudent(typed.name, typed.group);
      if (!student) return;
      const a = await createStudentAlert({
        student,
        place: form.place.value.trim(),
        room: form.room.value.trim(),
        note: form.note.value.trim(),
        audience: form.querySelector('[name=audience]:checked').value,
      });
      toast('Alerta enviada', 'ok');
      go(`/alerts/missing/${a.id}`, { replace: true });
    });
  });
}

// ---- New pickup ---------------------------------------------------------------------------

export async function newPickupView({ el }) {
  const me = state.me.user;
  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('logout')} ¿A quién vienen a buscar?</h2>
        ${studentFields()}
      </section>
      <section class="card stack">
        <div class="grid2">
          <label class="field"><span>Hora aproximada <em class="optional">opcional</em></span>
            <input type="time" name="time"></label>
          <label class="field"><span>Salón</span>
            <input name="room" maxlength="40" value="${me.room || ''}" placeholder="Ej. 204" autocomplete="off"></label>
        </div>
        <label class="field"><span>Nota <em class="optional">opcional</em></span>
          <input name="note" maxlength="300" placeholder="Ej. Lo recoge su abuela" autocomplete="off"></label>
      </section>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} Avisar a Seguridad</button>
      <p class="hint center">Cuando llegue el encargado, tú o Seguridad lo marcan en la app y Seguridad pasa al salón a buscarlo.</p>
    </form>`);

  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const typed = studentFrom(form);
      const student = await confirmStudent(typed.name, typed.group);
      if (!student) return;
      const k = await createPickup({ student, time: form.time.value, room: form.room.value.trim(), note: form.note.value.trim() });
      toast('Salida anotada. Seguridad fue avisada.', 'ok');
      go(`/alerts/pickup/${k.id}`, { replace: true });
    });
  });
}

// ---- Details ------------------------------------------------------------------------------

function detailShell(ctx, load, link) {
  markAlertsRead(link).catch(() => {});
  keepFresh(ctx, load);
}

export async function missingDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const a = await getMissingAlert(id);
    if (!isCurrent()) return;
    const st = missingState(a);
    const open = st === 'open';
    // A turn's alert (the student didn't get to Enfermería in time) has no "Ya llegó al salón".
    const mine = a.created_by === me.id && !a.turn_id;
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${open ? 'is-urgent' : st === 'found' ? 'is-ok' : ''}">
          <p class="alert-kind">${icon(st === 'found' ? 'check' : 'alert', 18)} ${MISSING_TITLE[st]}</p>
          <h2>${a.student_name || 'Estudiante'} <span class="muted">· ${a.group_name}</span></h2>
          ${a.student_name ? '' : html`<p class="hint">El nombre se borró: los estudiantes se guardan solo 24 horas.</p>`}
          <div class="facts">
            ${fact(a.turn_id ? 'Salió del salón' : 'Debía llegar al salón', a.room)}
            ${fact('Venía de / iba a', a.place)}
            ${fact('Avisó', `${a.created_by_name} · ${timeAgo(a.created_at)}`)}
            ${fact('Se avisó a', a.audience === 'all' ? 'Todo el personal' : 'Seguridad, dirección y secretaría')}
            ${fact('Nota', a.note)}
            ${st === 'found' ? fact('Lo confirmó', `${a.resolved_by_name} · tardó ${minutesBetween(a.created_at, a.resolved_at)} min`) : ''}
            ${st === 'found' ? fact('Dónde estaba', a.found_place) : ''}
            ${st === 'unconfirmed' ? fact('Se cerró', a.resolved_by_name && a.resolved_by_name !== 'Hallway'
              ? `${a.resolved_by_name} la dejó sin confirmar, ${fmtDateTime(a.resolved_at)}.`
              : `Al terminar el día escolar, ${fmtDateTime(a.resolved_at)}. Nadie confirmó dónde estaba.`) : ''}
            ${a.edited_at ? fact('Último cambio', `${a.edited_by_name} · ${fmtDateTime(a.edited_at)}`) : ''}
          </div>
        </section>
        ${open
          ? html`<button type="button" class="btn btn-primary btn-block btn-lg" data-found>${icon('check')} ${mine ? 'Ya llegó al salón' : 'Apareció / está conmigo'}</button>
              ${mine ? html`<button type="button" class="btn btn-secondary btn-block" data-found-elsewhere>Apareció en otro lugar</button>` : ''}`
          : ''}
        ${a.turn_id && a.created_by === me.id
          ? html`<a class="btn btn-secondary btn-block" href="#/turns/${a.turn_id}">${icon('pulse', 18)} Ver el turno</a>`
          : a.turn_id && can(me, 'live')
            ? html`<a class="btn btn-secondary btn-block" href="#/live/turn/${a.turn_id}">${icon('pulse', 18)} Ver el turno completo</a>`
            : ''}
        ${can(me, 'settings')
          ? html`<section class="card stack" data-manage>
              <h3 class="card-title">${icon('shield')} Administrar esta alerta</h3>
              <div class="button-row wrap">
                ${st !== 'found' ? html`<button type="button" class="btn btn-secondary btn-sm" data-manage-found>${icon('check', 16)} Apareció</button>` : html`<button type="button" class="btn btn-secondary btn-sm" data-manage-found>${icon('edit', 16)} Cambiar dónde estaba</button>`}
                ${st !== 'unconfirmed' ? html`<button type="button" class="btn btn-secondary btn-sm" data-manage-unconfirmed>Sin confirmar</button>` : ''}
                ${st !== 'open' ? html`<button type="button" class="btn btn-secondary btn-sm" data-manage-reopen>Reabrir</button>` : ''}
                <button type="button" class="btn btn-secondary btn-sm" data-manage-edit>${icon('edit', 16)} Corregir datos</button>
              </div>
              <button type="button" class="btn btn-ghost-danger btn-block" data-manage-delete>Borrar alerta</button>
              <p class="hint">Solo la dirección ve esto. Cada cambio queda anotado con tu nombre.</p>
            </section>`
          : ''}
        <a class="btn btn-ghost btn-block" href="#/alerts">${icon('back', 18)} Todas las alertas</a>
      </div>`);

    const resolve = (btn, askPlace) =>
      busy(btn, async () => {
        let place = mine && !askPlace ? 'Llegó al salón' : '';
        if (askPlace || !mine) {
          const v = await dialog({
            title: '¿Dónde estaba?',
            body: html`<label class="field"><span>Lugar <em class="optional">opcional</em></span>
              <input name="found" maxlength="120" autocomplete="off" placeholder="Ej. En la biblioteca, conmigo"></label>`,
            confirmText: 'Avisar que apareció',
            collect: true,
            onOpen: (dlg) => dlg.querySelector('[name=found]').focus(),
          });
          if (!v) return;
          place = v.found.trim();
        }
        await resolveStudentAlert(id, place);
        toast('Listo. Se avisó que apareció.', 'ok');
        await load();
      });
    $('[data-found]', el)?.addEventListener('click', (e) => resolve(e.currentTarget, false));
    bindManage(a);
    $('[data-found-elsewhere]', el)?.addEventListener('click', (e) => resolve(e.currentTarget, true));
  }

  /** The dirección's tools: change the state, correct the data or delete an alert put by mistake. */
  function bindManage(a) {
    const run = (btn, fn, done) =>
      busy(btn, async () => {
        if ((await fn()) === false) return;
        toast(done, 'ok');
        await load();
      });
    $('[data-manage-found]', el)?.addEventListener('click', (e) =>
      run(e.currentTarget, async () => {
        const v = await dialog({
          title: '¿Dónde estaba?',
          body: html`<label class="field"><span>Lugar <em class="optional">opcional</em></span>
            <input name="found" maxlength="120" autocomplete="off" value="${a.found_place || ''}" placeholder="Ej. En la biblioteca"></label>`,
          confirmText: 'Guardar',
          collect: true,
        });
        if (!v) return false;
        await manageStudentAlert(id, 'found', { found: v.found.trim() });
      }, 'Guardado: apareció.'));
    $('[data-manage-unconfirmed]', el)?.addEventListener('click', (e) =>
      run(e.currentTarget, () => manageStudentAlert(id, 'unconfirmed'), 'Quedó sin confirmar.'));
    $('[data-manage-reopen]', el)?.addEventListener('click', (e) =>
      run(e.currentTarget, async () => {
        const ok = await dialog({ title: '¿Reabrir esta alerta?', message: 'Vuelve a quedar como «No ha llegado». Solo se puede con alertas de hoy, antes de la hora de salida.', confirmText: 'Reabrir' });
        if (!ok) return false;
        await manageStudentAlert(id, 'reopen');
      }, 'Alerta abierta otra vez.'));
    $('[data-manage-edit]', el)?.addEventListener('click', (e) =>
      run(e.currentTarget, async () => {
        const v = await dialog({
          title: 'Corregir datos',
          body: html`<label class="field"><span>De dónde venía / a dónde iba</span>
              <input name="place" maxlength="120" value="${a.place || ''}"></label>
            <label class="field"><span>Salón</span><input name="room" maxlength="40" value="${a.room || ''}"></label>
            <label class="field"><span>Nota</span><textarea name="note" rows="3" maxlength="500">${a.note || ''}</textarea></label>`,
          confirmText: 'Guardar',
          collect: true,
        });
        if (!v) return false;
        await manageStudentAlert(id, 'edit', { place: v.place.trim(), room: v.room.trim(), note: v.note.trim() });
      }, 'Datos corregidos.'));
    $('[data-manage-delete]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const ok = await dialog({
          title: '¿Borrar esta alerta?',
          message: 'Úsalo solo si se puso por error: desaparece de las listas y no cuenta en los reportes. No se puede deshacer.',
          confirmText: 'Borrar',
          danger: true,
        });
        if (!ok) return;
        await manageStudentAlert(id, 'delete');
        toast('Alerta borrada.', 'ok');
        go('/alerts', { replace: true });
      }));
  }

  await load();
  detailShell(ctx, load, `#/alerts/missing/${id}`);
}

// Each step of a pickup: label, and who did it and when.
const STEPS = [
  ['Anotada', (k) => [k.created_by_name, k.created_at]],
  ['Llegó el encargado', (k) => [k.arrived_by_name, k.arrived_at]],
  ['Seguridad va al salón', (k) => [k.on_the_way_by_name, k.on_the_way_at]],
  ['Entregado', (k) => [k.delivered_by_name, k.delivered_at]],
];

export async function pickupDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const k = await getPickup(id);
    if (!isCurrent()) return;
    const security = isSecurity(me);
    const teacher = k.created_by === me.id || (me.groups || []).includes(k.group_name);
    const done = k.status === 'delivered' || k.status === 'cancelled';
    const s = PICKUP_STATUS[k.status];
    const buttons = [];
    if (!done) {
      if (k.status === 'scheduled' && (teacher || security)) {
        buttons.push(html`<button type="button" class="btn btn-primary btn-block btn-lg" data-step="arrived">${icon('bell')} Llegó el encargado</button>`);
      }
      if (security && (k.status === 'scheduled' || k.status === 'arrived')) {
        buttons.push(html`<button type="button" class="btn ${k.status === 'arrived' ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-step="on_the_way">${icon('send')} Voy al salón</button>`);
      }
      if (security) {
        buttons.push(html`<button type="button" class="btn ${k.status === 'on_the_way' ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-step="delivered">${icon('check')} Entregado</button>`);
      }
      if (security || k.created_by === me.id) {
        buttons.push(html`<button type="button" class="btn btn-ghost-danger btn-block" data-step="cancelled">Cancelar salida</button>`);
      }
    }
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${k.status === 'arrived' ? 'is-urgent' : ''} ${k.status === 'delivered' ? 'is-ok' : ''}">
          <p class="alert-kind">${icon('logout', 18)} Salida · <span class="tag ${s.cls}">${s.label}</span></p>
          <h2>${k.student_name || 'Estudiante'} <span class="muted">· ${k.group_name}</span></h2>
          ${k.student_name ? '' : html`<p class="hint">El nombre se borró: los estudiantes se guardan solo 24 horas.</p>`}
          <div class="facts">
            ${fact('Hora aproximada', k.expected_time ? fmtTime(k.expected_time) : '')}
            ${fact('Salón', k.room)}
            ${fact('Nota', k.note)}
            ${fact('Lo recogió', k.picked_up_by)}
          </div>
          <ol class="timeline steps">
            ${STEPS.map(([label, who]) => {
              const [name, at] = who(k);
              return html`<li class="${at ? 'is-done' : ''}"><strong>${label}</strong>${at ? html` · ${name}<small>${timeAgo(at)}</small>` : ''}</li>`;
            })}
            ${k.status === 'cancelled' ? html`<li class="is-done"><strong>Cancelada</strong> · ${k.cancelled_by_name}<small>${timeAgo(k.cancelled_at)}</small></li>` : ''}
          </ol>
        </section>
        ${buttons}
        <p class="hint">${security
          ? 'Cuando llegue el encargado, márcalo para avisar al maestro. Luego «Voy al salón» y «Entregado».'
          : 'Si el encargado te avisa a ti, toca «Llegó el encargado» y Seguridad pasa a buscarlo.'}</p>
        <a class="btn btn-ghost btn-block" href="#/alerts">${icon('back', 18)} Todas las alertas</a>
      </div>`);

    for (const btn of el.querySelectorAll('[data-step]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          const step = btn.dataset.step;
          let pickedUpBy = null;
          if (step === 'delivered') {
            const v = await dialog({
              title: 'Entregar',
              body: html`<label class="field"><span>¿Quién lo recogió? <em class="optional">opcional</em></span>
                <input name="who" maxlength="120" autocomplete="off" placeholder="Ej. Su mamá, Ana Ruiz"></label>`,
              confirmText: 'Entregado',
              collect: true,
            });
            if (!v) return;
            pickedUpBy = v.who.trim();
          }
          if (step === 'cancelled') {
            const ok = await dialog({ title: '¿Cancelar esta salida?', message: studentLabel(k), confirmText: 'Cancelar salida', cancelText: 'Volver', danger: true });
            if (!ok) return;
          }
          await advancePickup(id, step, pickedUpBy);
          toast(
            { arrived: 'Avisado', on_the_way: 'El maestro sabe que vas', delivered: 'Entrega registrada', cancelled: 'Salida cancelada' }[step],
            'ok',
          );
          await load();
        }),
      );
    }
  }

  await load();
  detailShell(ctx, load, `#/alerts/pickup/${id}`);
}

export async function reliefDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const r = await getRelief(id);
    if (!isCurrent()) return;
    const mine = r.requested_by === me.id;
    const open = reliefOpen(r);
    const canTake = open && !mine && (me.coverage || isStaff(me));
    let status;
    if (r.taken_at) status = `${mine ? `${r.taken_by_name} va a relevarte` : `Lo releva ${r.taken_by_name}`} · ${timeAgo(r.taken_at)}`;
    else if (r.cancelled_at) status = 'Ya no lo necesita';
    else if (!open) status = 'Nadie respondió';
    else status = 'Esperando a que alguien vaya';
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${open ? 'is-urgent' : ''} ${r.taken_at ? 'is-ok' : ''}">
          <p class="alert-kind">${icon('swap', 18)} Relevo</p>
          <h2>${mine ? 'Pediste relevo' : `${r.requested_by_name} pide relevo`}</h2>
          <div class="facts">
            ${fact('Salón', r.room)}
            ${fact('Nota', r.note)}
            ${fact('Pedido', timeAgo(r.created_at))}
            ${fact('Estado', status)}
          </div>
        </section>
        ${canTake ? html`<button type="button" class="btn btn-primary btn-block btn-lg" data-take="${r.id}">${icon('check')} Yo lo relevo</button>` : ''}
        ${open && mine ? html`<button type="button" class="btn btn-ghost btn-block" data-cancel-relief="${r.id}">Ya no lo necesito</button>` : ''}
        <a class="btn btn-ghost btn-block" href="#/alerts">${icon('back', 18)} Todas las alertas</a>
      </div>`);
    bindReliefButtons(el, load);
  }

  await load();
  detailShell(ctx, load, `#/alerts/relief/${id}`);
}
