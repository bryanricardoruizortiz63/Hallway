import { CATEGORIES, STATUS, colorIndex, coversOn, dialog, fmtRange, html, initials, roleNeedsCoverage, scheduleText, todayStr, $ } from '../lib.js';
import { appIcon } from '../branding.js';
import { icon } from '../icons.js';
import { canPromptInstall, isIos, isStandalone, promptInstall } from '../pwa.js';

export function avatar(name, size = '') {
  return html`<span class="avatar c${colorIndex(name)} ${size}" aria-hidden="true">${initials(name)}</span>`;
}

export function statusBadge(status) {
  const s = STATUS[status] || STATUS.pending;
  return html`<span class="badge ${s.cls}">${s.label}</span>`;
}

export function empty(iconName, title, text = '', action = '') {
  return html`<div class="empty">${icon(iconName, 40)}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action}</div>`;
}

function dateChip(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return html`<span class="date-chip"><b>${d.getDate()}</b><small>${d.toLocaleDateString('es', { month: 'short' }).replace('.', '')}</small></span>`;
}

/** One absence row. showName=false is used for the employee's own list; on: who covers that day (today's list). */
export function absenceItem(a, { showName = true, on = null } = {}) {
  const cancelled = a.status === 'cancelled';
  const sub = [
    showName ? fmtRange(a.start_date, a.end_date) : null,
    scheduleText(a),
    a.category ? CATEGORIES[a.category] : null,
  ].filter(Boolean);
  let coverage = '';
  const that = on ? coversOn(a, on) : [];
  const covering = on ? [...new Set(that.map((c) => c.name))].join(', ') : a.substitute;
  if (!cancelled && covering) coverage = html`<span class="tag tag-ok">${icon('check', 14)} ${covering}</span>`;
  else if (!cancelled && showName && roleNeedsCoverage(a.employee_role)) coverage = html`<span class="tag tag-warn">Sin cubrir</span>`;
  // That day's list: whoever covers is on the way, or hasn't confirmed the notice yet (rows that ask for it).
  let answer = '';
  if (!cancelled && that.some((c) => c.on_the_way_at && todayStr(new Date(c.on_the_way_at)) === on)) {
    answer = html`<span class="tag tag-ok">${icon('send', 14)} En camino</span>`;
  } else if (!cancelled && that.some((c) => c.substitute_id && c.set_by && !c.received_at)) {
    answer = html`<span class="tag tag-info">Sin confirmar</span>`;
  }

  return html`
    <a class="item ${cancelled ? 'is-muted' : ''}" href="#/absence/${a.id}">
      ${showName ? avatar(a.employee_name) : dateChip(a.start_date)}
      <span class="item-main">
        <strong>${showName ? a.employee_name : fmtRange(a.start_date, a.end_date)}</strong>
        <span class="item-sub">${sub.join(' · ')}</span>
        <span class="item-tags">
          ${coverage}
          ${answer}
          ${a.attachment_count ? html`<span class="tag">${icon('clip', 14)} ${a.attachment_count}</span>` : ''}
          ${a.comment_count ? html`<span class="tag">${icon('chat', 14)} ${a.comment_count}</span>` : ''}
        </span>
      </span>
      ${statusBadge(a.status)}
    </a>`;
}

export function absenceList(items, opts) {
  return html`<div class="list">${items.map((a) => absenceItem(a, opts))}</div>`;
}

/** Renders an "add to home screen" hint into slot when the app is not installed yet. */
export function installHint(slot, { dismissible = true } = {}) {
  if (!slot || isStandalone()) return;
  const KEY = 'lah:install-dismissed';
  try {
    if (dismissible && localStorage.getItem(KEY)) return;
  } catch {
    /* storage unavailable */
  }

  const render = () => {
    let bodyHtml;
    if (isIos()) {
      bodyHtml = html`<p>En Safari toca ${icon('share', 16)} <b>Compartir</b> y luego <b>“Añadir a pantalla de inicio”</b>.
        Así la abres como una app y recibes notificaciones.</p>`;
    } else if (canPromptInstall()) {
      bodyHtml = html`<p>Instálala en tu teléfono para abrirla con un toque y recibir notificaciones.</p>
        <button class="btn btn-primary btn-sm" data-install>${icon('download', 16)} Instalar app</button>`;
    } else {
      bodyHtml = html`<p>Desde el menú del navegador elige <b>“Instalar app”</b> o <b>“Añadir a pantalla de inicio”</b>.</p>`;
    }
    slot.innerHTML = String(html`
      <div class="install card">
        <span class="install-icon">${icon('phone', 22)}</span>
        <div class="install-body"><strong>Añade la app a tu pantalla de inicio</strong>${bodyHtml}</div>
        ${dismissible ? html`<button class="icon-btn" data-dismiss aria-label="Cerrar">${icon('x', 18)}</button>` : ''}
      </div>`);
    $('[data-install]', slot)?.addEventListener('click', async () => {
      if (await promptInstall()) slot.innerHTML = '';
    });
    $('[data-dismiss]', slot)?.addEventListener('click', () => {
      try {
        localStorage.setItem(KEY, '1');
      } catch {
        /* ignore */
      }
      slot.innerHTML = '';
    });
  };
  render();
  const onInstallable = () => slot.isConnected && render();
  window.addEventListener('lah:installable', onInstallable, { once: true });
}

/** The email exactly as it will arrive (HTML from the server), in a sandboxed frame. */
export function showEmailPreview(subject, page) {
  const logo = new URL(appIcon(), location.href).href;
  dialog({
    title: 'Vista previa del correo',
    body: html`<p class="hint"><b>Asunto:</b> ${subject}</p>
      <iframe class="email-preview" sandbox title="Vista previa del correo"></iframe>`,
    confirmText: 'Cerrar',
    cancelText: '',
    onOpen(dlg) {
      dlg.querySelector('iframe').srcdoc = page.replaceAll('cid:leap-logo', logo);
    },
  });
}
