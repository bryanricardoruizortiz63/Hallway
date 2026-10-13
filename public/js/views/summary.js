// Resumen del día: what happened in the school on a school day, for whoever has the permission «Resumen del día»
// (the dirección). It arrives as a notice when classes end; here it opens for any of the last 60 days. The staff's
// absences with who covered them (never the reason), the services' turns, alerts and visits only in numbers.
import { dailySummary } from '../backend.js';
import { CATEGORIES, NO_COVER, addDays, fmtLongDate, fmtTime, html, scheduleText, todayStr } from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { avatar, statusBadge } from './common.js';

const tile = (value, label, cls = '') => html`<div class="stat ${cls}"><strong>${value}</strong><span>${label}</span></div>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Who covered that day, «Nadie cubrirá» and why, or «Sin cubrir» (only roles whose absences need coverage). */
function coverTag(a) {
  if (a.covers.length) return html`<span class="tag tag-ok">${icon('check', 14)} ${a.covers.join(', ')}</span>`;
  if (NO_COVER[a.no_cover]) return html`<span class="tag">${NO_COVER[a.no_cover].tag}</span>`;
  return a.needs_cover ? html`<span class="tag tag-warn">Sin cubrir</span>` : '';
}

const isUncovered = (a) => a.needs_cover && !a.covers.length && !a.no_cover;

function absenceRow(a) {
  return html`<a class="item" href="#/absence/${a.id}" data-summary-absence="${a.id}">
    ${avatar(a.name)}
    <span class="item-main">
      <strong>${a.name}</strong>
      <span class="item-sub">${[a.role, scheduleText(a), CATEGORIES[a.category]].filter(Boolean).join(' · ')}</span>
      <span class="item-tags">
        ${coverTag(a)}
        ${a.unconfirmed.length ? html`<span class="tag tag-info">Sin confirmar: ${a.unconfirmed.join(', ')}</span>` : ''}
      </span>
    </span>
    ${statusBadge(a.status)}
  </a>`;
}

/** "7 pedidos · 5 atendidos · 1 no llegó a tiempo · espera promedio 6 min". */
function serviceLine(s) {
  if (!s.requested) return 'Sin pedidos';
  const support = s.mode === 'support';
  return [
    plural(s.requested, 'pedido', 'pedidos'),
    support ? plural(s.done, 'resuelto', 'resueltos') : plural(s.done, 'atendido', 'atendidos'),
    s.cancelled ? plural(s.cancelled, 'cancelado', 'cancelados') : null,
    s.late ? `${s.late} no ${s.late === 1 ? 'llegó' : 'llegaron'} a tiempo` : null,
    s.return_late ? `${s.return_late} ${s.return_late === 1 ? 'tardó' : 'tardaron'} en regresar` : null,
    s.referred ? (support ? `${s.referred} con seguimiento` : plural(s.referred, 'referido', 'referidos')) : null,
    s.picked_up ? plural(s.picked_up, 'recogido', 'recogidos') : null,
    s.wait !== null ? `espera promedio ${s.wait} min` : null,
    s.open ? `${s.open} sin terminar` : null,
  ].filter(Boolean).join(' · ');
}

const countRow = (iconName, label, value, sub = '') => html`<div class="item">
    <span class="item-icon">${icon(iconName)}</span>
    <span class="item-main"><strong>${label}</strong>${sub ? html`<span class="item-sub">${sub}</span>` : ''}</span>
    <span class="count ${value ? 'warn' : ''}">${value}</span>
  </div>`;

/** Resumen del día, of today or of a day of the last 60 (#/summary/2026-10-13). */
export async function summaryView({ el, params }) {
  const today = todayStr();
  const asked = params[0] || today;
  const s = await dailySummary(asked === today ? null : asked);
  const { day } = s;
  const uncovered = s.absences.filter(isUncovered).length;
  const turns = s.services.reduce((n, x) => n + x.requested, 0);
  const late = s.services.reduce((n, x) => n + x.late, 0);
  const m = s.maintenance;
  const nextLabel = s.next_day ? (s.next_day === addDays(day, 1) ? `Mañana, ${fmtLongDate(s.next_day)}` : cap(fmtLongDate(s.next_day))) : '';
  const older = addDays(day, -1);

  el.innerHTML = String(html`<div class="stack summary">
    <div class="summary-nav">
      ${older >= addDays(today, -60) ? html`<a class="icon-btn" href="#/summary/${older}" aria-label="Día anterior" data-summary-prev>${icon('back', 20)}</a>` : html`<span></span>`}
      <h2 class="capitalize" data-summary-day>${fmtLongDate(day)}</h2>
      ${day < today ? html`<a class="icon-btn" href="#/summary/${addDays(day, 1)}" aria-label="Día siguiente" data-summary-next>${icon('chevron', 20)}</a>` : html`<span></span>`}
    </div>
    ${s.school_day ? '' : html`<p class="status-note muted" data-summary-closed>${icon('calendar', 16)} ${s.closure ? `No hubo clases: ${s.closure}.` : 'No es día de clases.'}</p>`}
    <div class="stats">
      ${tile(s.absences.length, s.absences.length === 1 ? 'Ausencia' : 'Ausencias')}
      ${tile(uncovered, 'Sin cubrir', uncovered ? 'stat-danger' : '')}
      ${tile(turns, late ? `Turnos · ${late} no ${late === 1 ? 'llegó' : 'llegaron'} a tiempo` : 'Turnos', late ? 'stat-warn' : '')}
      ${tile(m.open, 'Mantenimiento pendiente', m.urgent ? 'stat-warn' : '')}
    </div>

    <section class="section" data-summary-absences>
      <h3 class="section-title">Ausencias del personal <span class="count ${uncovered ? 'danger' : ''}">${s.absences.length}</span></h3>
      ${s.absences.length ? html`<div class="list">${s.absences.map(absenceRow)}</div>` : html`<p class="muted pad">Nadie del personal faltó.</p>`}
    </section>

    ${s.services.length
      ? html`<section class="section" data-summary-services>
          <h3 class="section-title">Turnos <span class="count">${turns}</span></h3>
          <div class="list">${s.services.map((x) => html`<div class="item" data-summary-service="${x.id}">
              <span class="item-icon">${icon(x.mode === 'support' ? 'wrench' : 'pulse')}</span>
              <span class="item-main"><strong>${x.name}</strong><span class="item-sub">${serviceLine(x)}</span></span>
            </div>`)}</div>
        </section>`
      : ''}

    <section class="section" data-summary-security>
      <h3 class="section-title">Alertas y visitas</h3>
      <div class="list">
        ${countRow('alert', 'No ha llegado', s.alerts.missing, s.alerts.unresolved ? `${s.alerts.unresolved} sin resolver` : '')}
        ${countRow('user', 'Salidas entregadas', s.pickups)}
        ${countRow('users', 'Relevos pedidos', s.relief)}
        ${countRow('door', 'Visitas', s.visits)}
      </div>
    </section>

    <section class="section" data-summary-maintenance>
      <h3 class="section-title">Mantenimiento</h3>
      <div class="list">
        ${countRow('wrench', 'Pedidos', m.requested, m.done ? plural(m.done, 'resuelto', 'resueltos') : '')}
        ${countRow('clock', 'Pendientes', m.open, m.urgent ? plural(m.urgent, 'urgente', 'urgentes') : '')}
      </div>
    </section>

    ${s.next_day
      ? html`<section class="section" data-summary-next>
          <h3 class="section-title">Próximo día de clases</h3>
          <div class="card stack">
            <h2 class="card-title">${icon('calendar')} ${nextLabel}</h2>
            ${s.next_absences.length
              ? html`<div class="list flat">${s.next_absences.map(absenceRow)}</div>`
              : html`<p class="muted">No hay ausencias reportadas.</p>`}
            <p class="hint">${[
              s.next_rooms ? `Salón de conferencias: ${plural(s.next_rooms, 'reserva', 'reservas')}.` : 'El salón de conferencias está libre.',
              s.rooms_pending ? `${s.rooms_pending} ${s.rooms_pending === 1 ? 'reserva espera' : 'reservas esperan'} aprobación.` : '',
            ].filter(Boolean).join(' ')}</p>
          </div>
        </section>`
      : ''}

    <p class="hint">${state.me.user.role === 'admin'
      ? 'A quienes tienen el permiso «Resumen del día» les llega un aviso con este resumen al terminar las clases. '
      : `Te llega un aviso con este resumen al terminar las clases (${fmtTime(s.day_end)}). `}Las ausencias dicen quién cubrió, nunca el motivo; los turnos, las alertas y las visitas van solo en números.</p>
  </div>`);
}
