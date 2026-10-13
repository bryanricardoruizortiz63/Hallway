// "Así está organizada Hallway": what's behind each tab, for whoever opens the app for the first time,
// and "Cómo usar Hallway" (from Más) with the usual tasks and where each one is.
import { $, can, html, isStaff } from '../lib.js';
import { icon } from '../icons.js';
import { fixesOnly, inTabBar, navItems } from '../nav.js';
import { state } from '../store.js';

const seenKey = (user) => `lah:guide-seen:${user.id}`;
// If this browser can't store it, at least don't show it again until the app reloads.
const dismissed = new Set();

/** "a, b y c" */
const listText = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] || '');

function moreText(user) {
  const parts = [
    can(user, 'staff') ? 'personal' : null,
    can(user, 'messages') ? 'mensajes' : null,
    can(user, 'reports') ? 'reportes' : null,
    can(user, 'settings') ? 'ajustes de la escuela' : null,
    inTabBar(user, '/turns') ? null : 'turnos',
    inTabBar(user, '/maintenance') ? null : 'mantenimiento',
    'calendario escolar',
    'avisos',
    'tu perfil',
  ].filter(Boolean);
  const text = listText(parts);
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function tabText(path, user) {
  switch (path) {
    case '/home':
      return 'Reporta que vas a faltar y mira si la dirección la recibió.';
    case '/dashboard':
      return user.role === 'admin'
        ? 'Quién falta hoy, quién lo cubre y lo que falta por confirmar. Aquí registras la ausencia de un empleado.'
        : 'Quién falta hoy, quién lo cubre y lo que falta por confirmar. Aquí también reportas las tuyas.';
    case '/alerts':
      return 'Un estudiante que no ha llegado, salidas, relevos y mantenimiento (derrame, limpieza, baño, basura).';
    case '/turns':
      return can(user, 'visitors')
        ? 'Enfermería y Trabajo Social: pide turno para un estudiante. Aquí también avisas cuando llega un padre y ves la respuesta.'
        : 'Enfermería y Trabajo Social: pide turno para un estudiante y te avisamos cuando lo llamen.';
    case '/maintenance':
      return 'Los pedidos de limpieza que te tocan.';
    case '/live':
      return 'Lo que pasa ahora en la escuela: Enfermería, Trabajo Social, alertas, mantenimiento y el salón.';
    case '/rooms':
      return can(user, 'rooms')
        ? 'El salón de conferencias: resérvalo y aprueba las reservas del personal.'
        : 'Pide el salón de conferencias para un día y hora, o mira quién lo tiene.';
    case '/more':
      return moreText(user);
    default:
      return '';
  }
}

export function guideCard(user, { dismissible = true } = {}) {
  return html`<section class="card stack guide" data-guide>
    <h2 class="card-title">${icon('sparkle')} Así está organizada Hallway</h2>
    <p class="hint">Estas son las secciones de la app y lo que encuentras en cada una.</p>
    <div class="list">
      ${navItems(user).map(
        (item) => html`<a class="item" href="#${item.path}">
          <span class="item-icon">${icon(item.icon)}</span>
          <span class="item-main"><strong>${item.label}</strong><span class="item-sub">${tabText(item.path, user)}</span></span>
        </a>`,
      )}
      <a class="item" href="#/notifications">
        <span class="item-icon">${icon('bell')}</span>
        <span class="item-main"><strong>La campana de arriba</strong><span class="item-sub">Tus avisos. Muestra un número cuando hay algo nuevo.</span></span>
      </a>
    </div>
    ${dismissible
      ? html`<div class="button-row">
          <button type="button" class="btn btn-primary btn-sm" data-guide-ok>${icon('check', 16)} Entendido</button>
          <a class="btn btn-ghost btn-sm" href="#/guide">¿Dónde está…?</a>
        </div>`
      : ''}
  </section>`;
}

/** On the first screen, until the person taps "Entendido" (once per person on each device). */
export function guideHint(slot) {
  const user = state.me?.user;
  if (!slot || !user || dismissed.has(user.id)) return;
  try {
    if (localStorage.getItem(seenKey(user))) return;
  } catch {
    /* storage unavailable: show it */
  }
  slot.innerHTML = String(guideCard(user));
  $('[data-guide-ok]', slot).addEventListener('click', () => {
    dismissed.add(user.id);
    try {
      localStorage.setItem(seenKey(user), '1');
    } catch {
      /* storage unavailable */
    }
    slot.innerHTML = '';
  });
}

/** The usual tasks, each with where it is ("Alertas › No ha llegado") and a link straight to it. */
function tasks(user) {
  const admin = user.role === 'admin';
  const tab = (path) => navItems(user).find((i) => i.path === path)?.label;
  const where = (path, label, then) => `${tab(path) || `Más › ${label}`}${then ? ` › ${then}` : ''}`;
  const absences = tab(isStaff(user) ? '/dashboard' : '/home');
  return [
    admin
      ? ['#/report', 'plus', 'Registrar la ausencia de un empleado', `${absences} › Registrar ausencia de un empleado`]
      : ['#/report', 'plus', 'Avisar que voy a faltar', `${absences} › ${can(user, 'register') ? 'Registrar una ausencia' : isStaff(user) ? 'Reportar mi ausencia' : 'Reportar ausencia'}`],
    can(user, 'register') && !admin
      ? ['#/report', 'plus', 'Registrar la ausencia de otro empleado', `${absences} › Registrar una ausencia › ¿Quién va a faltar?`]
      : null,
    isStaff(user) && !admin ? ['#/home', 'calendar', 'Ver mis ausencias', 'Más › Mis ausencias'] : null,
    isStaff(user) ? ['#/absences', 'list', 'Buscar o exportar las ausencias del personal', `${absences} › Ver todas`] : null,
    ['#/rooms', 'room', 'Pedir el salón de conferencias', `${where('/rooms', 'Salón de conferencias')} › Reservar el salón`],
    ['#/rooms/history', 'list', 'Ver las reservas canceladas y su historial', `${where('/rooms', 'Salón de conferencias')} › Historial y canceladas`],
    ['#/turns', 'pulse', 'Mandar un estudiante a Enfermería o Trabajo Social', `${where('/turns', 'Turnos')} › Pedir turno`],
    can(user, 'visitors') ? ['#/turns/visit/new', 'door', 'Avisar que llegó un padre', `${where('/turns', 'Turnos')} › Llegó una visita`] : null,
    ['#/alerts/new/missing', 'alert', 'Avisar que un estudiante no ha llegado', 'Alertas › No ha llegado'],
    ['#/alerts/new/pickup', 'logout', 'Avisar que vienen a buscar a un estudiante', 'Alertas › Salida'],
    fixesOnly(user)
      ? ['#/maintenance', 'wrench', 'Ver los pedidos de limpieza', 'Pedidos']
      : ['#/maintenance/new', 'wrench', 'Pedir limpieza', 'Alertas › Mantenimiento'],
    ['#/calendar', 'calendar', 'Ver el horario y los días sin clases', 'Más › Calendario escolar'],
    ['#/notifications', 'bell', 'Ver mis avisos', 'La campana de arriba'],
    ['#/profile', 'user', 'Activar notificaciones o cambiar mi contraseña', 'Más › Mi perfil'],
    can(user, 'staff') ? ['#/employees', 'users', 'Añadir personal o enviarle su acceso', 'Más › Personal'] : null,
    can(user, 'messages') ? ['#/messages/new', 'mail', 'Escribirle al personal', 'Más › Mensajes'] : null,
    can(user, 'live') ? ['#/live', 'live', 'Ver lo que pasa ahora en la escuela', where('/live', 'En vivo')] : null,
  ].filter(Boolean);
}

export async function guideView({ el }) {
  const user = state.me.user;
  el.innerHTML = String(html`
    <div class="stack">
      <section class="section guide-tasks">
        <h3 class="section-title">¿Dónde está…?</h3>
        <div class="list">${tasks(user).map(
          ([href, ic, title, path]) => html`<a class="item" href="${href}">
            <span class="item-icon">${icon(ic)}</span>
            <span class="item-main"><strong>${title}</strong><span class="item-sub">${path}</span></span>
            ${icon('chevron', 18)}
          </a>`,
        )}</div>
      </section>
      ${guideCard(user, { dismissible: false })}
    </div>`);
}
