// The bottom bar (side bar on wide screens): the same places for everyone, named for what's in them.
// "Más" lists whatever doesn't fit here (see moreView); Avisos are on the bell at the top.
import { can, isManager, isStaff } from './lib.js';

export const anyManager = (u) => isStaff(u) || isManager(u);

/** Mantenimiento staff without a management role: their queue gets the place of Turnos. */
export const fixesOnly = (u) => can(u, 'maintenance') && !anyManager(u);

export function navItems(user) {
  // Their own absences, or everyone's for whoever confirms them (with theirs one tap away).
  const absences = isStaff(user)
    ? { path: '/dashboard', icon: 'calendar', label: 'Ausencias', match: ['/dashboard', '/absences', '/absence', '/report', '/cover'] }
    : { path: '/home', icon: 'calendar', label: 'Ausencias', match: ['/home', '/absence', '/report', '/cover'] };
  const fixes = fixesOnly(user);
  const alerts = { path: '/alerts', icon: 'alert', label: 'Alertas', match: ['/alerts'] };
  // The rest ask for maintenance from Turnos, like the other services.
  const turns = { path: '/turns', icon: 'pulse', label: 'Turnos', match: ['/turns', '/maintenance'] };
  // "Mantenimiento" doesn't fit in the bar.
  const maintenance = { path: '/maintenance', icon: 'wrench', label: 'Pedidos', match: ['/maintenance'] };
  // The conference room ("Salón" alone reads as the classroom).
  const rooms = { path: '/rooms', icon: 'room', label: 'Reservas', match: ['/rooms'] };
  // The live board (dirección and Secretaría), one tap away.
  const live = { path: '/live', icon: 'live', label: 'En vivo', match: ['/live'] };
  const items = [absences, ...(can(user, 'live') ? [live] : []), ...(fixes ? [maintenance, alerts] : [alerts, turns]), rooms];
  const moreMatch = [
    '/more', '/guide', '/notifications', '/message/', '/profile', '/calendar', '/employees', '/settings', '/roles',
    '/services', '/data', '/messages', '/home', '/turns', '/maintenance', '/live',
  ].filter((p) => !items.some((i) => i.match.includes(p)));
  items.push({ path: '/more', icon: 'menu', label: 'Más', match: moreMatch });
  return items;
}

/** Whether this path is already a tab, so "Más" doesn't repeat it. */
export const inTabBar = (user, path) => navItems(user).some((i) => i.path === path);
