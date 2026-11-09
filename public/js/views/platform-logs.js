// Platform panel: what people say (Comentarios y problemas), the error history and the failed sign-ins. Each card
// loads when it is opened. The errors and the failed sign-ins last 30 days.
import { $, busy, dialog, fmtDateTime, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { empty } from './common.js';

const KIND = { idea: 'Idea', problem: 'Problema', other: 'Otra cosa' };
const STATUS = { new: ['Nuevo', 'tag-warn'], seen: ['Visto', ''], done: ['Resuelto', 'tag-ok'] };
const SOURCE = { app: 'App', server: 'Servidor', database: 'Base de datos' };
const REASON = {
  school: 'Código de escuela no existe', username: 'Usuario no existe', password: 'Contraseña incorrecta',
  inactive: 'Cuenta desactivada', other: 'Otro',
};

/** «iPhone · Safari», «Windows · Chrome». */
export function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || 'Desconocido';
}

function feedbackList(list) {
  if (!list.length) return empty('chat', 'No hay mensajes', 'Lo que la gente envíe desde Más › Comentarios y problemas aparece aquí.');
  return html`<div class="list">${list.map((f) => html`<div class="item log-item">
    <span class="item-main">
      <strong>${KIND[f.kind] || f.kind} · ${f.user_name}${f.school_name ? ` · ${f.school_name}` : ''}
        <span class="tag ${STATUS[f.status]?.[1] || ''}">${STATUS[f.status]?.[0] || f.status}</span></strong>
      <span class="item-sub pre">${f.message}</span>
      <span class="item-sub">${fmtDateTime(f.created_at)} · ${deviceName(f.device || '')}${f.route ? ` · ${f.route}` : ''}</span>
      ${f.reply ? html`<span class="feedback-reply"><b>Tu respuesta</b> · ${fmtDateTime(f.replied_at)}<br>${f.reply}</span>` : ''}
      <span class="button-row wrap">
        <button type="button" class="btn btn-secondary btn-sm" data-answer="${f.id}">${icon('send', 14)} ${f.reply ? 'Cambiar respuesta' : 'Responder'}</button>
        ${f.status !== 'done' ? html`<button type="button" class="btn btn-ghost btn-sm" data-done="${f.id}">${icon('check', 14)} Resuelto</button>` : ''}
        ${f.status === 'new' ? html`<button type="button" class="btn btn-ghost btn-sm" data-seen="${f.id}">Visto</button>` : ''}
      </span>
    </span>
  </div>`)}</div>`;
}

function errorList(list) {
  if (!list.length) return empty('check', 'Sin errores', 'No hubo errores en los últimos 30 días.');
  return html`<div class="list">${list.map((e) => html`<details class="item log-item">
    <summary class="item-main">
      <strong>${e.message}</strong>
      <span class="item-sub">${fmtDateTime(e.at)} · ${SOURCE[e.source] || e.source}${e.status ? ` · ${e.status}` : ''}${e.kind ? ` · ${e.kind}` : ''}</span>
      <span class="item-sub">${[e.user_name || 'Sin sesión', e.school_name, e.route].filter(Boolean).join(' · ')}</span>
    </summary>
    <pre class="log-detail">${[
      `Fecha: ${fmtDateTime(e.at)}`,
      `Persona: ${e.user_name || '—'}`,
      `Escuela: ${e.school_name || '—'}`,
      `Dónde: ${e.route || '—'}`,
      `Dispositivo: ${deviceName(e.device || '')} — ${e.device || '—'}`,
      e.ip ? `IP: ${e.ip}` : null,
      e.app_version ? `Versión: ${e.app_version}` : null,
      '',
      e.detail || 'Sin más detalles.',
    ].filter((x) => x !== null).join('\n')}</pre>
  </details>`)}</div>`;
}

function failureList(list) {
  if (!list.length) return empty('shield', 'Sin intentos fallidos', 'Nadie falló al entrar en los últimos 30 días.');
  return html`<div class="list">${list.map((f) => html`<div class="item log-item">
    <span class="item-main">
      <strong>${f.username || '—'}${f.user_name ? ` (${f.user_name})` : ''} · ${f.school_name || f.school_code || '—'}
        ${f.alerted ? html`<span class="tag tag-danger">Se te avisó por correo</span>` : ''}</strong>
      <span class="item-sub">${REASON[f.reason] || f.reason} · código «${f.school_code || '—'}»</span>
      <span class="item-sub">${fmtDateTime(f.at)} · IP ${f.ip || '—'} · ${deviceName(f.device || '')}</span>
    </span>
  </div>`)}</div>`;
}

export function platformLogs(slot, call) {
  slot.innerHTML = String(html`<div class="stack">
    <details class="card stack" data-card="feedback">
      <summary class="card-title">${icon('chat')} Comentarios y problemas <span class="count" data-new hidden></span></summary>
      <div class="quick">
        <button type="button" class="chip-btn active" data-filter="">Todos</button>
        <button type="button" class="chip-btn" data-filter="new">Nuevos</button>
        <button type="button" class="chip-btn" data-filter="done">Resueltos</button>
      </div>
      <div data-body></div>
    </details>
    <details class="card stack" data-card="errors">
      <summary class="card-title">${icon('alert')} Historial de errores <em class="optional">30 días</em></summary>
      <div class="quick">
        <button type="button" class="chip-btn active" data-source="">Todos</button>
        <button type="button" class="chip-btn" data-source="app">App</button>
        <button type="button" class="chip-btn" data-source="server">Servidor</button>
      </div>
      <div data-body></div>
    </details>
    <details class="card stack" data-card="failures">
      <summary class="card-title">${icon('shield')} Intentos fallidos de entrar <em class="optional">30 días</em></summary>
      <p class="hint">Después de 5 intentos fallidos con la misma cuenta, o 10 desde la misma IP, en 15 minutos, te llega un correo al de la plataforma (uno por hora como máximo).</p>
      <div data-body></div>
    </details>
  </div>`);

  const card = (name) => $(`[data-card="${name}"]`, slot);
  let filter = '';
  let source = '';

  const loadFeedback = async () => {
    const box = $('[data-body]', card('feedback'));
    const { feedback, new_count: n } = await call('list_feedback', { status: filter || null });
    const badge = $('[data-new]', card('feedback'));
    badge.hidden = !n;
    badge.textContent = n ? `${n} nuevo${n === 1 ? '' : 's'}` : '';
    box.innerHTML = String(feedbackList(feedback));
    const answer = async (id, status, reply = null) => {
      await call('answer_feedback', { id, status, reply });
      await loadFeedback();
    };
    for (const b of box.querySelectorAll('[data-done]')) b.addEventListener('click', () => busy(b, () => answer(Number(b.dataset.done), 'done')));
    for (const b of box.querySelectorAll('[data-seen]')) b.addEventListener('click', () => busy(b, () => answer(Number(b.dataset.seen), 'seen')));
    for (const b of box.querySelectorAll('[data-answer]')) {
      b.addEventListener('click', async () => {
        const f = feedback.find((x) => x.id === Number(b.dataset.answer));
        const v = await dialog({
          title: `Responder a ${f.user_name}`,
          message: 'Le llega un aviso en la app y lo ve en Más › Comentarios y problemas.',
          body: html`<label class="field"><span>Respuesta</span><textarea name="reply" rows="5" maxlength="2000">${f.reply || ''}</textarea></label>
            <label class="switch-inline"><input type="checkbox" name="done" ${f.status === 'done' ? 'checked' : ''}> Marcar como resuelto</label>`,
          confirmText: 'Enviar',
          collect: true,
        });
        if (!v) return;
        if (!String(v.reply || '').trim()) return toast('Escribe la respuesta.', 'error');
        await busy(b, async () => {
          await answer(f.id, v.done ? 'done' : 'seen', v.reply.trim());
          toast('Respuesta enviada', 'ok');
        });
      });
    }
  };
  const loadErrors = async () => {
    const { errors } = await call('list_errors', { source: source || null });
    $('[data-body]', card('errors')).innerHTML = String(errorList(errors));
  };
  const loadFailures = async () => {
    const { failures } = await call('list_login_failures');
    $('[data-body]', card('failures')).innerHTML = String(failureList(failures));
  };
  const loaders = { feedback: loadFeedback, errors: loadErrors, failures: loadFailures };

  for (const [name, load] of Object.entries(loaders)) {
    const d = card(name);
    d.addEventListener('toggle', () => {
      if (d.open) {
        $('[data-body]', d).innerHTML = '<div class="loading skeleton"><i></i><i></i></div>';
        load().catch((err) => toast(err.message, 'error'));
      }
    });
  }
  for (const b of card('feedback').querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const x of card('feedback').querySelectorAll('[data-filter]')) x.classList.toggle('active', x === b);
      loadFeedback().catch((err) => toast(err.message, 'error'));
    });
  }
  for (const b of card('errors').querySelectorAll('[data-source]')) {
    b.addEventListener('click', () => {
      source = b.dataset.source;
      for (const x of card('errors').querySelectorAll('[data-source]')) x.classList.toggle('active', x === b);
      loadErrors().catch((err) => toast(err.message, 'error'));
    });
  }
  // How many new messages, without opening the card.
  call('list_feedback', { status: 'new' })
    .then(({ new_count: n }) => {
      const badge = $('[data-new]', card('feedback'));
      badge.hidden = !n;
      badge.textContent = n ? `${n} nuevo${n === 1 ? '' : 's'}` : '';
    })
    .catch(() => {});
}
