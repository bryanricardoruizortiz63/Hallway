// Mensajes: the dirección writes to everyone, a role or specific people. Each person gets an in-app
// notice and a push notification, and optionally an email.
import { getMessage, getSchool, listEmployees, listMessages, previewEmail, sendMessage } from '../backend.js';
import { $, busy, can, fmtDateTime, formValues, getSchoolRoles, html, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { avatar, empty, showEmailPreview } from './common.js';

const isEmail = (s) => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function emailSummary(m) {
  if (!m.email_requested) return 'Solo en la app';
  const parts = [`${m.emailed} por correo`];
  if (m.email_failed) parts.push(`${m.email_failed} con error`);
  return parts.join(' · ');
}

export async function messagesView({ el }) {
  const messages = await listMessages();
  el.innerHTML = String(html`
    <div class="toolbar">
      <p class="muted grow">Avisos que la dirección envió al personal.</p>
      <a class="btn btn-primary" href="#/messages/new">${icon('plus', 18)} Nuevo</a>
    </div>
    ${messages.length
      ? html`<div class="list">${messages.map(
          (m) => html`<a class="item" href="#/message/${m.id}">
            <span class="item-icon">${icon('mail')}</span>
            <span class="item-main">
              <strong>${m.subject}</strong>
              <span class="item-sub">Para: ${m.audience} · ${m.sender_name}</span>
              <span class="item-tags">
                <span class="tag">${icon('users', 14)} ${m.recipients}</span>
                <span class="tag ${m.email_failed ? 'tag-warn' : ''}">${emailSummary(m)}</span>
              </span>
              <span class="item-time">${timeAgo(m.created_at)}</span>
            </span>
            ${icon('chevron', 18)}
          </a>`,
        )}</div>`
      : html`<div class="card">${empty('mail', 'Aún no has enviado mensajes', 'Escribe al personal: les llega como aviso en la app y, si quieres, por correo.')}</div>`}`);
}

export async function composeView({ el, query }) {
  const me = state.me.user;
  const [allEmployees, school] = await Promise.all([listEmployees(), getSchool(state.me.school.id)]);
  const people = allEmployees.filter((e) => e.active && e.id !== me.id);
  const preselected = new Set(query.get('to') ? [query.get('to')] : []);
  const emailReady = !!school.email_provider;
  const inGroup = (g) => (g === 'all' ? people : people.filter((p) => p.role === g || p.extra_roles?.includes(g)));
  // Everyone, each role that has someone, or specific people.
  const groups = [
    ['all', 'Todo el personal'],
    ...getSchoolRoles().filter((r) => inGroup(r.key).length).map((r) => [r.key, r.name]),
    ['people', 'Elegir personas'],
  ];

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('users')} Para</h2>
        <div class="choices">
          ${groups.map(
            ([value, label]) => html`<label class="choice">
              <input type="radio" name="group" value="${value}" ${(preselected.size ? value === 'people' : value === 'all') ? 'checked' : ''}>
              <span>${label}${value === 'people' ? '' : html`<small>${inGroup(value).length} persona(s)</small>`}</span></label>`,
          )}
        </div>
        <div class="stack" data-people hidden>
          <label class="search">${icon('search', 18)}<input type="search" placeholder="Buscar…" data-q></label>
          <div class="people-list">${people.map(
            (p) => html`<label class="person" data-name="${`${p.full_name} ${p.position || ''}`.toLowerCase()}">
              <input type="checkbox" value="${p.id}" ${preselected.has(p.id) ? 'checked' : ''}>
              ${avatar(p.full_name)}
              <span class="grow"><strong>${p.full_name}</strong><small>${p.position || p.role_label}${p.email ? '' : ' · sin correo'}</small></span>
            </label>`,
          )}</div>
        </div>
      </section>

      <section class="card stack">
        <label class="field"><span>Asunto</span><input name="subject" maxlength="150" required placeholder="Ej. Reunión de facultad el viernes"></label>
        <label class="field"><span>Mensaje</span><textarea name="body" rows="8" maxlength="5000" required></textarea></label>
      </section>

      <section class="card stack">
        <label class="toggle"><input type="checkbox" name="email" ${emailReady ? '' : 'disabled'}>
          <span class="toggle-ui"></span><span>También enviar por correo electrónico</span></label>
        <p class="hint" data-email-hint></p>
        ${emailReady ? html`<button type="button" class="btn btn-ghost btn-sm" data-preview-email>${icon('mail', 16)} Ver cómo llega el correo</button>` : ''}
      </section>

      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} Enviar mensaje</button>
      <p class="hint center">Les llega como aviso en la app y como notificación en el teléfono.</p>
    </form>`);

  const form = $('[data-form]', el);
  const peopleBox = $('[data-people]', el);
  const group = () => form.querySelector('[name=group]:checked').value;
  const chosen = () =>
    group() === 'people'
      ? [...peopleBox.querySelectorAll('input[type=checkbox]:checked')].map((c) => people.find((p) => p.id === c.value))
      : inGroup(group());

  function update() {
    peopleBox.hidden = group() !== 'people';
    const list = chosen();
    const withEmail = list.filter((p) => isEmail(p.email)).length;
    $('[data-email-hint]', el).textContent = !emailReady
      ? 'Para usar esta opción, conecta una cuenta en Más → Escuela y Teams → Correo electrónico.'
      : `${list.length} persona(s) · ${withEmail} con correo registrado.`;
    form.querySelector('[type=submit]').innerHTML = String(
      html`${icon('send')} Enviar a ${list.length} persona${list.length === 1 ? '' : 's'}`,
    );
  }
  for (const r of form.querySelectorAll('[name=group]')) r.addEventListener('change', update);
  peopleBox.addEventListener('change', update);
  $('[data-q]', el).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const row of peopleBox.querySelectorAll('.person')) row.hidden = !!q && !row.dataset.name.includes(q);
  });
  update();

  $('[data-preview-email]', el)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const v = formValues(form);
      if (!v.subject.trim() || !v.body.trim()) throw new Error('Escribe el asunto y el mensaje para ver la vista previa.');
      const { subject, html: page } = await previewEmail('message', v.subject, v.body);
      showEmailPreview(subject, page);
    }),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      const list = chosen();
      if (!list.length) throw new Error('Elige al menos una persona.');
      if (!v.subject.trim()) throw new Error('Escribe el asunto.');
      if (!v.body.trim()) throw new Error('Escribe el mensaje.');
      const res = await sendMessage({
        to: group() === 'people' ? list.map((p) => p.id) : group(),
        subject: v.subject,
        body: v.body,
        email: !!v.email,
      });
      const extra = v.email
        ? ` · ${res.emailed} por correo${res.email_failed ? `, ${res.email_failed} con error` : ''}${res.no_email ? `, ${res.no_email} sin correo` : ''}`
        : '';
      toast(`Mensaje enviado a ${res.recipients} persona(s)${extra}.`, res.email_failed ? 'error' : 'ok');
      go(`/message/${res.id}`, { replace: true });
    });
  });
}

const STATUS_LABEL = (s) =>
  !s ? null : s === 'sent' ? ['ok', 'Correo enviado'] : s === 'no_email' ? ['', 'Sin correo'] : ['warn', s.replace(/^error: /, 'Error: ')];

export async function messageView({ el, params }) {
  const { message: m, recipients } = await getMessage(params[0]);
  const manager = can(state.me.user, 'messages');
  el.innerHTML = String(html`
    <div class="stack">
      <section class="card stack">
        <div class="row">${avatar(m.sender_name)}
          <div class="grow"><strong>${m.sender_name}</strong><p class="muted">${fmtDateTime(m.created_at)}${manager ? ` · Para: ${m.audience}` : ''}</p></div>
        </div>
        <h2>${m.subject}</h2>
        <p class="pre message-body">${m.body}</p>
      </section>
      ${manager
        ? html`<section class="card stack">
            <h3 class="card-title">${icon('users')} Destinatarios <span class="count">${recipients.length}</span></h3>
            <p class="muted">${emailSummary(m)}</p>
            <div class="list compact">${recipients.map((r) => {
              const status = STATUS_LABEL(r.email_status);
              return html`<div class="item">
                ${avatar(r.profile?.full_name || '?')}
                <span class="item-main"><strong>${r.profile?.full_name || 'Empleado eliminado'}</strong>
                  ${r.profile?.email ? html`<span class="item-sub">${r.profile.email}</span>` : ''}</span>
                ${status ? html`<span class="tag ${status[0] ? `tag-${status[0]}` : ''}">${status[1]}</span>` : ''}
              </div>`;
            })}</div>
          </section>`
        : ''}
    </div>`);
}
