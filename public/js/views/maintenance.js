// Mantenimiento (cleaning only): a teacher asks for what's needed (a spill, cleaning, the bathroom, trash) with the
// place, how urgent it is and an optional note or photo. Mantenimiento sees the queue (most urgent first), marks
// "Voy en camino" and "Listo", and the app suggests the next one.
import {
  advanceMaintenance,
  createMaintenanceRequest,
  getMaintenance,
  listMaintenance,
  maintenanceOverview,
  markAlertsRead,
} from '../backend.js';
import { $, busy, can, dialog, fmtDateTime, html, isStaff, SCHOOL_ICONS as SCHOOL_KIND, schoolIcon, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { empty } from './common.js';
import { fact, keepFresh } from './students.js';

export const KINDS = {
  spill: { label: 'Derrame o líquido', icon: 'drop' },
  cleaning: { label: 'Limpieza', icon: 'sparkle' },
  bathroom: { label: 'Baño', icon: 'door' },
  trash: { label: 'Basura', icon: 'trash' },
  // Mantenimiento doesn't do repairs: only for the requests made before.
  repair: { label: 'Reparación', icon: 'wrench', old: true },
  other: { label: 'Otro', icon: 'chat' },
};

export const URGENCY = {
  1: { label: 'Cuando puedan', cls: '' },
  2: { label: 'Pronto', cls: 'tag-warn' },
  3: { label: 'Urgente', cls: 'tag-danger' },
};

const isOpen = (m) => m.status === 'pending' || m.status === 'on_the_way';
const isFixer = (u) => can(u, 'maintenance');
const minutes = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 60000));
const kindOf = (m) => KINDS[m.kind] || KINDS.other;

function statusTag(m, me) {
  if (m.status === 'pending') return { label: m.position ? `Pendiente · turno ${m.position}` : 'Pendiente', cls: '' };
  if (m.status === 'on_the_way') return { label: m.taken_by === me.id ? 'Vas en camino' : `Va ${m.taken_by_name}`, cls: 'tag-warn' };
  if (m.status === 'done') return { label: 'Listo', cls: 'tag-ok' };
  return { label: 'Cancelada', cls: '' };
}

/** "Salón 204" for a room that is just a number. */
function myPlace(me) {
  const room = (me.room || '').trim();
  return /^\d/.test(room) ? `Salón ${room}` : room;
}

export function requestItem(m, me, { action = true } = {}) {
  const k = kindOf(m);
  const u = URGENCY[m.urgency];
  const s = statusTag(m, me);
  const open = isOpen(m);
  const fixer = isFixer(me);
  let button = '';
  if (action && fixer && m.status === 'pending') button = html`<button type="button" class="btn btn-primary btn-sm" data-go="${m.id}">Voy</button>`;
  if (action && fixer && m.status === 'on_the_way' && m.taken_by === me.id) {
    button = html`<button type="button" class="btn btn-primary btn-sm" data-done="${m.id}">Listo</button>`;
  }
  return html`<div class="item alert-item ${open && m.urgency === 3 ? 'is-urgent' : ''} ${open ? '' : 'is-muted'}">
    <a class="item-link" href="#/maintenance/${m.id}">
      ${m.status === 'pending' && fixer && m.position
        ? html`<span class="item-icon queue-num" title="Turno ${m.position}">${m.position}</span>`
        : schoolIcon(SCHOOL_KIND[m.kind] ? m.kind : 'maintenance', `${open && m.urgency === 3 ? 'is-danger' : ''} ${m.status === 'done' ? 'is-ok' : ''}`)}
      <span class="item-main">
        <strong>${k.label} · ${m.place}</strong>
        <span class="item-sub">${[m.note, `pidió ${m.created_by_name}`, timeAgo(m.created_at)].filter(Boolean).join(' · ')}</span>
        <span class="item-tags">
          ${open ? html`<span class="tag ${u.cls}">${u.label}</span>` : ''}
          ${m.status === 'pending' && fixer && m.position ? '' : html`<span class="tag ${s.cls}">${s.label}</span>`}
          ${m.photo_path ? html`<span class="tag">${icon('camera', 14)} Foto</span>` : ''}
        </span>
      </span>
    </a>
    ${button}
  </div>`;
}

/** Asks what was done (optional) and marks it ready. Resolves false if the person went back. */
async function markDone(id) {
  const v = await dialog({
    title: '¿Listo?',
    message: 'Se le avisa a quien lo pidió.',
    body: html`<label class="field"><span>¿Qué se hizo? <em class="optional">opcional</em></span>
      <input name="note" maxlength="300" autocomplete="off" placeholder="Ej. Se secó y se puso el letrero"></label>`,
    confirmText: 'Listo',
    cancelText: 'Volver',
    collect: true,
  });
  if (!v) return false;
  await advanceMaintenance(id, 'done', v.note.trim());
  toast('Listo. Le avisamos a quien lo pidió.', 'ok');
  return true;
}

async function goTo(id) {
  await advanceMaintenance(id, 'go');
  toast('Le avisamos que vas en camino.', 'ok');
}

function bindQuickButtons(root, reload) {
  for (const btn of root.querySelectorAll('[data-go]')) {
    btn.addEventListener('click', () => busy(btn, async () => {
      await goTo(Number(btn.dataset.go));
      await reload();
    }));
  }
  for (const btn of root.querySelectorAll('[data-done]')) {
    btn.addEventListener('click', () => busy(btn, async () => {
      if (await markDone(Number(btn.dataset.done))) await reload();
    }));
  }
}

// ---- List ----------------------------------------------------------------------------------

export async function maintenanceView(ctx) {
  const { el, isCurrent } = ctx;
  const me = state.me.user;
  let data = null;
  let showDone = false;

  const render = () => {
    const { list, overview } = data;
    const fixer = isFixer(me);
    const open = list.filter(isOpen);
    const done = list.filter((m) => !isOpen(m)).reverse();
    const mineFirst = (a, b) => (b.taken_by === me.id) - (a.taken_by === me.id);
    const onTheWay = open.filter((m) => m.status === 'on_the_way').sort(mineFirst);
    const pending = open.filter((m) => m.status === 'pending').sort((a, b) => (a.position || 99) - (b.position || 99));
    const nobody = !overview.staff.length;

    el.innerHTML = String(html`
      <div class="stack">
        ${fixer
          ? ''
          : html`<a class="btn btn-primary btn-block btn-lg" href="#/maintenance/new">${icon('wrench')} Pedir mantenimiento</a>
            ${nobody ? html`<p class="status-note warn">${icon('alert', 16)} Nadie tiene el rol de Mantenimiento todavía. Avísale a la dirección.</p>` : ''}`}

        ${onTheWay.length
          ? html`<section class="section">
              <h3 class="section-title">En camino</h3>
              <div class="list">${onTheWay.map((m) => requestItem(m, me))}</div>
            </section>`
          : ''}

        <section class="section">
          <h3 class="section-title">${fixer ? 'Pendientes' : 'Abiertas'} <span class="count ${pending.length ? 'warn' : ''}">${pending.length}</span></h3>
          ${pending.length
            ? html`<div class="list">${pending.map((m) => requestItem(m, me))}</div>`
            : html`<div class="card">${empty('check', 'Todo al día', fixer ? 'No hay solicitudes pendientes.' : 'No hay solicitudes abiertas.')}</div>`}
        </section>

        ${done.length
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-done-list>${showDone ? 'Ocultar' : 'Ver'} las de hoy que terminaron (${done.length})</button>
            ${showDone ? html`<div class="list">${done.map((m) => requestItem(m, me, { action: false }))}</div>` : ''}`
          : ''}

        <p class="hint">${fixer
          ? 'Van por urgencia y, dentro de cada una, por orden de llegada. «Voy en camino» le avisa a quien lo pidió y al resto de Mantenimiento.'
          : 'Te avisamos cuando Mantenimiento vaya en camino y cuando esté listo.'}</p>
        ${fixer || isStaff(me) ? html`<a class="btn btn-ghost btn-block" href="#/maintenance/panel">${icon('chart', 18)} Panel y Excel</a>` : ''}
      </div>`);

    $('[data-done-list]', el)?.addEventListener('click', () => {
      showDone = !showDone;
      render();
    });
    bindQuickButtons(el, load);
  };

  async function load() {
    const [list, overview] = await Promise.all([listMaintenance(), maintenanceOverview()]);
    if (!isCurrent()) return;
    data = { list, overview };
    render();
  }

  await load();
  markAlertsRead('#/maintenance').catch(() => {});
  keepFresh(ctx, load);
}

// ---- New request ---------------------------------------------------------------------------

export async function newMaintenanceView({ el }) {
  const me = state.me.user;
  const overview = await maintenanceOverview();
  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('wrench')} ¿Qué hace falta?</h2>
        <div class="kind-grid" role="radiogroup" aria-label="Qué hace falta">
          ${Object.entries(KINDS).filter(([, k]) => !k.old).map(
            ([key, k]) => html`<label class="kind"><input type="radio" name="kind" value="${key}"><span>${icon(k.icon, 24)}${k.label}</span></label>`,
          )}
        </div>
      </section>
      <section class="card stack">
        <label class="field"><span>¿Dónde?</span>
          <input name="place" required maxlength="80" value="${myPlace(me)}" autocomplete="off" placeholder="Ej. Salón 204, baño de niñas, comedor"></label>
        <span class="field-label">¿Qué tan urgente?</span>
        <div class="chips sev-chips" role="radiogroup" aria-label="Urgencia">
          ${[1, 2, 3].map(
            (n) => html`<label class="chip sev-${n + 1}"><input type="radio" name="urgency" value="${n}"><span>${URGENCY[n].label}</span></label>`,
          )}
        </div>
        <p class="hint">«Pronto» y «Urgente» le llegan a Mantenimiento con alarma.</p>
        <label class="field"><span>Nota <em class="optional" data-note-optional>opcional</em></span>
          <textarea name="note" rows="2" maxlength="500" placeholder="Ej. Se rompió un frasco de pintura"></textarea></label>
        <div class="photo-pick">
          <label class="btn btn-secondary btn-sm file-btn">${icon('camera', 18)} <span data-photo-label>Añadir foto</span>
            <input type="file" name="photo" accept="image/*" capture="environment" hidden></label>
          <img class="photo-preview" data-photo-preview alt="Foto de la solicitud" hidden>
          <button type="button" class="btn btn-ghost btn-sm" data-photo-clear hidden>Quitar foto</button>
        </div>
      </section>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} Enviar a Mantenimiento</button>
      <p class="hint center">${overview.staff.length
        ? `Le llega a ${overview.staff.map((p) => p.name).join(', ')}. Te avisamos cuando vaya en camino y cuando esté listo.`
        : 'Nadie tiene el rol de Mantenimiento todavía: la solicitud queda guardada, pero avísale a la dirección.'}</p>
    </form>`);

  const form = $('[data-form]', el);
  const fileInput = form.querySelector('[name=photo]');
  const preview = $('[data-photo-preview]', el);
  let photo = null;
  let previewUrl = null;
  const showPhoto = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = photo ? URL.createObjectURL(photo) : null;
    preview.hidden = !photo;
    if (photo) preview.src = previewUrl;
    else preview.removeAttribute('src');
    $('[data-photo-clear]', el).hidden = !photo;
    $('[data-photo-label]', el).textContent = photo ? 'Cambiar foto' : 'Añadir foto';
  };
  fileInput.addEventListener('change', () => {
    photo = fileInput.files[0] || null;
    showPhoto();
  });
  $('[data-photo-clear]', el).addEventListener('click', () => {
    photo = null;
    fileInput.value = '';
    showPhoto();
  });
  for (const input of form.querySelectorAll('[name=kind]')) {
    input.addEventListener('change', () => {
      // "Otro" needs a note saying what.
      $('[data-note-optional]', el).hidden = form.kind.value === 'other';
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const kind = form.kind.value;
      if (!kind) throw new Error('Elige qué hace falta.');
      const place = form.place.value.trim().replace(/\s+/g, ' ');
      if (!place) throw new Error('Escribe dónde es.');
      const urgency = Number(form.urgency.value || 0);
      if (!urgency) throw new Error('Elige qué tan urgente es.');
      const note = form.note.value.trim();
      if (kind === 'other' && !note) throw new Error('Escribe qué hace falta.');
      const m = await createMaintenanceRequest(state.me, { kind, place, urgency, note, photo });
      toast('Enviado a Mantenimiento', 'ok');
      go(`/maintenance/${m.id}`, { replace: true });
    });
  });
}

// ---- Detail --------------------------------------------------------------------------------

export async function maintenanceDetailView(ctx) {
  const { el, params, isCurrent } = ctx;
  const id = Number(params[0]);
  const me = state.me.user;

  async function load() {
    const m = await getMaintenance(id);
    // After finishing one, Mantenimiento sees which comes next.
    const next = isFixer(me) && !isOpen(m)
      ? (await listMaintenance()).filter((x) => x.status === 'pending').sort((a, b) => (a.position || 99) - (b.position || 99))[0]
      : null;
    if (!isCurrent()) return;
    const k = kindOf(m);
    const s = statusTag(m, me);
    const fixer = isFixer(me);
    const open = isOpen(m);
    const buttons = [];
    if (open && fixer) {
      if (m.status === 'pending') buttons.push(html`<button type="button" class="btn btn-primary btn-block btn-lg" data-step="go">${icon('send')} Voy en camino</button>`);
      buttons.push(html`<button type="button" class="btn ${m.status === 'on_the_way' && m.taken_by === me.id ? 'btn-primary btn-lg' : 'btn-secondary'} btn-block" data-step="done">${icon('check')} Listo</button>`);
      if (m.status === 'on_the_way' && m.taken_by === me.id) buttons.push(html`<button type="button" class="btn btn-secondary btn-block" data-step="release">Ya no puedo ir</button>`);
    }
    if (open && (fixer || m.created_by === me.id)) buttons.push(html`<button type="button" class="btn btn-ghost-danger btn-block" data-step="cancel">Cancelar solicitud</button>`);

    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack alert-head ${open && m.urgency === 3 ? 'is-urgent' : ''} ${m.status === 'done' ? 'is-ok' : ''}">
          <p class="alert-kind">${icon(k.icon, 18)} ${k.label} · <span class="tag ${s.cls}">${s.label}</span></p>
          <h2>${m.place}</h2>
          ${m.photo_url ? html`<a href="${m.photo_url}" target="_blank" rel="noopener"><img class="photo-full" src="${m.photo_url}" alt="Foto de la solicitud"></a>` : ''}
          <div class="facts">
            ${fact('Urgencia', URGENCY[m.urgency].label)}
            ${fact('Nota', m.note)}
            ${fact('Pidió', `${m.created_by_name} · ${fmtDateTime(m.created_at)}`)}
            ${m.status === 'pending' && m.position ? fact('En la fila', `Turno ${m.position}`) : ''}
            ${fact('Atiende', m.taken_by_name)}
            ${m.status === 'done' ? fact('Se resolvió en', `${minutes(m.created_at, m.done_at)} min`) : ''}
            ${fact(m.status === 'cancelled' ? 'Por qué se canceló' : 'Qué se hizo', m.close_note)}
          </div>
          <ol class="timeline steps">
            <li class="is-done"><strong>Pedida</strong> · ${m.created_by_name}<small>${timeAgo(m.created_at)}</small></li>
            <li class="${m.on_the_way_at ? 'is-done' : ''}"><strong>En camino</strong>${m.on_the_way_at ? html` · ${m.taken_by_name}<small>${timeAgo(m.on_the_way_at)}</small>` : ''}</li>
            ${m.status === 'cancelled'
              ? html`<li class="is-done"><strong>Cancelada</strong> · ${m.closed_by_name}<small>${timeAgo(m.cancelled_at)}</small></li>`
              : html`<li class="${m.done_at ? 'is-done' : ''}"><strong>Listo</strong>${m.done_at ? html` · ${m.closed_by_name}<small>${timeAgo(m.done_at)}</small>` : ''}</li>`}
          </ol>
        </section>
        ${buttons}
        ${next
          ? html`<section class="card stack">
              <h2 class="card-title">${icon('chevron')} Sigue en la fila</h2>
              <a class="item-link" href="#/maintenance/${next.id}"><strong>${kindOf(next).label} · ${next.place}</strong></a>
              <p class="hint">${URGENCY[next.urgency].label} · pidió ${next.created_by_name} ${timeAgo(next.created_at)}</p>
              <button type="button" class="btn btn-primary btn-block" data-next="${next.id}">${icon('send')} Voy en camino</button>
            </section>`
          : ''}
        ${open && !fixer ? html`<p class="hint">Te avisamos cuando Mantenimiento vaya en camino y cuando esté listo.</p>` : ''}
        <a class="btn btn-ghost btn-block" href="#/maintenance">${icon('back', 18)} Todas las solicitudes</a>
      </div>`);

    for (const btn of el.querySelectorAll('[data-step]')) {
      btn.addEventListener('click', () =>
        busy(btn, async () => {
          const step = btn.dataset.step;
          if (step === 'go') await goTo(id);
          if (step === 'done' && !(await markDone(id))) return;
          if (step === 'release') {
            await advanceMaintenance(id, 'release');
            toast('Sigue pendiente. Le avisamos al resto de Mantenimiento.', 'ok');
          }
          if (step === 'cancel') {
            const v = await dialog({
              title: '¿Cancelar esta solicitud?',
              message: `${k.label} · ${m.place}`,
              body: fixer && m.created_by !== me.id
                ? html`<label class="field"><span>¿Por qué? <em class="optional">opcional</em></span>
                    <input name="note" maxlength="300" autocomplete="off" placeholder="Ej. Ya estaba resuelto"></label>`
                : '',
              confirmText: 'Cancelar solicitud',
              cancelText: 'Volver',
              danger: true,
              collect: true,
            });
            if (!v) return;
            await advanceMaintenance(id, 'cancel', (v.note || '').trim());
            toast('Solicitud cancelada', 'ok');
          }
          await load();
        }),
      );
    }
    $('[data-next]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await goTo(next.id);
        go(`/maintenance/${next.id}`);
      }),
    );
  }

  await load();
  markAlertsRead(`#/maintenance/${id}`).catch(() => {});
  keepFresh(ctx, load);
}
