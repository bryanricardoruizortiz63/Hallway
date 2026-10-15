import { getMe, markAlertsRead } from './backend.js';
import { can, html, isStaff, raw, toast } from './lib.js';
import { icon } from './icons.js';
import { initPwa, syncPush } from './pwa.js';
import { go, homePath, refreshUnread, setUnread, state } from './store.js';
import { navItems } from './nav.js';
import { showAlarm, unlockAudio } from './alarm.js';
import { adoptSchoolFromUrl, changePasswordView, loginView, rememberSchool } from './views/auth.js';
import { appIcon, applyBranding, restoreBranding } from './branding.js';
import { absenceView, coverView, editAbsenceView, homeView, reportView } from './views/absences.js';
import { absencesListView, dashboardView } from './views/staff.js';
import { dataView, employeeFormView, employeesView, settingsView } from './views/admin.js';
import { accessCardsView } from './views/access.js';
import { rolesView } from './views/roles.js';
import { calendarView, groupsView } from './views/calendar.js';
import {
  alertsView,
  missingDetailView,
  newMissingView,
  newPickupView,
  pickupDetailView,
  reliefDetailView,
} from './views/alerts.js';
import { newTurnView, serviceFormView, servicesView, turnDetailView, turnsView } from './views/turns.js';
import { newVisitView, visitDetailView } from './views/visits.js';
import { maintenanceDetailView, maintenanceView, newMaintenanceView } from './views/maintenance.js';
import { bookingDetailView, bookingHistoryView, newBookingView, roomsView } from './views/rooms.js';
import {
  liveServiceView,
  liveTurnView,
  liveTvView,
  liveView,
  maintenancePanelView,
  roomsPanelView,
  servicePanelView,
} from './views/panels.js';
import { moreView, notificationsView, profileView } from './views/account.js';
import { guideView } from './views/guide.js';
import { summaryView } from './views/summary.js';
import { platformView } from './views/platform.js';
import { composeView, messageView, messagesView } from './views/messages.js';

// Who may open each screen: by the permissions of the person's role.
const PEOPLE = (u) => u.role !== 'admin';
const STAFF = (u) => isStaff(u);
const ADMIN = (u) => u.role === 'admin';
const may = (perm) => (u) => can(u, perm);

const ROUTES = [
  { re: /^\/login$/, view: loginView, public: true, bare: true },
  { re: /^\/platform$/, view: platformView, public: true, bare: true },
  { re: /^\/change-password$/, view: changePasswordView, bare: true },
  { re: /^\/home$/, view: homeView, title: 'Mis ausencias', allow: PEOPLE },
  { re: /^\/report$/, view: reportView, title: 'Reportar ausencia', back: true },
  { re: /^\/absence\/(\d+)$/, view: absenceView, title: 'Ausencia', back: true },
  { re: /^\/absence\/(\d+)\/edit$/, view: editAbsenceView, title: 'Modificar ausencia', back: true },
  { re: /^\/cover\/(\d+)$/, view: coverView, title: 'Cobertura', back: true },
  { re: /^\/dashboard$/, view: dashboardView, title: 'Ausencias', allow: STAFF },
  { re: /^\/absences$/, view: absencesListView, title: 'Todas las ausencias', allow: STAFF, back: true },
  { re: /^\/employees$/, view: employeesView, title: 'Personal', allow: may('staff') },
  { re: /^\/employees\/accesos$/, view: accessCardsView, title: 'Accesos para repartir', allow: may('staff'), back: true },
  // Employee ids are Supabase Auth UUIDs.
  { re: /^\/employees\/(new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, view: employeeFormView, title: 'Empleado', allow: may('staff'), back: true },
  { re: /^\/settings$/, view: settingsView, title: 'Escuela y Teams', allow: may('settings'), back: true },
  { re: /^\/roles$/, view: rolesView, title: 'Roles y permisos', allow: ADMIN, back: true },
  { re: /^\/calendar$/, view: calendarView, title: 'Calendario escolar', back: true },
  { re: /^\/groups$/, view: groupsView, title: 'Grados y grupos', allow: may('calendar'), back: true },
  { re: /^\/alerts$/, view: alertsView, title: 'Alertas' },
  { re: /^\/alerts\/new\/missing$/, view: newMissingView, title: 'No ha llegado', back: true },
  { re: /^\/alerts\/new\/pickup$/, view: newPickupView, title: 'Salida', back: true },
  { re: /^\/alerts\/missing\/(\d+)$/, view: missingDetailView, title: 'No ha llegado', back: true },
  { re: /^\/alerts\/pickup\/(\d+)$/, view: pickupDetailView, title: 'Salida', back: true },
  { re: /^\/alerts\/relief\/(\d+)$/, view: reliefDetailView, title: 'Relevo', back: true },
  { re: /^\/turns$/, view: turnsView, title: 'Turnos' },
  { re: /^\/turns\/new$/, view: newTurnView, title: 'Pedir turno', back: true },
  { re: /^\/turns\/(\d+)$/, view: turnDetailView, title: 'Turno', back: true },
  { re: /^\/turns\/visit\/new$/, view: newVisitView, title: 'Llegó una visita', allow: may('visitors'), back: true },
  { re: /^\/turns\/visit\/(\d+)$/, view: visitDetailView, title: 'Visita', back: true },
  // Only whoever attends the service (checked in the view and by the database).
  { re: /^\/turns\/panel\/(\d+)$/, view: servicePanelView, title: 'Panel del servicio', back: true },
  { re: /^\/services$/, view: servicesView, title: 'Servicios', allow: may('services'), back: true },
  { re: /^\/services\/(new|\d+)$/, view: serviceFormView, title: 'Servicio', allow: may('services'), back: true },
  { re: /^\/maintenance$/, view: maintenanceView, title: 'Mantenimiento' },
  { re: /^\/maintenance\/new$/, view: newMaintenanceView, title: 'Pedir mantenimiento', back: true },
  { re: /^\/maintenance\/(\d+)$/, view: maintenanceDetailView, title: 'Mantenimiento', back: true },
  { re: /^\/maintenance\/panel$/, view: maintenancePanelView, title: 'Panel de mantenimiento', allow: (u) => can(u, 'maintenance') || isStaff(u), back: true },
  { re: /^\/rooms$/, view: roomsView, title: 'Salón de conferencias' },
  { re: /^\/rooms\/new$/, view: newBookingView, title: 'Reservar el salón', back: true },
  { re: /^\/rooms\/history$/, view: bookingHistoryView, title: 'Historial de reservas', back: true },
  { re: /^\/rooms\/(\d+)$/, view: bookingDetailView, title: 'Reserva del salón', back: true },
  { re: /^\/rooms\/panel$/, view: roomsPanelView, title: 'Uso del salón', allow: may('rooms'), back: true },
  { re: /^\/live$/, view: liveView, title: 'En vivo', allow: may('live') },
  { re: /^\/live\/service\/(\d+)$/, view: liveServiceView, title: 'En vivo', allow: may('live'), back: true },
  { re: /^\/live\/turn\/(\d+)$/, view: liveTurnView, title: 'Turno', allow: may('live'), back: true },
  // For a TV in the office: without the app's bars.
  { re: /^\/live\/tv$/, view: liveTvView, title: 'En vivo', allow: may('live'), bare: true },
  { re: /^\/summary(?:\/(\d{4}-\d{2}-\d{2}))?$/, view: summaryView, title: 'Resumen del día', allow: may('summary'), back: true },
  // Enfermería, Trabajo Social…: only their own service's panel.
  { re: /^\/data$/, view: dataView, title: 'Datos y reportes', allow: (u) => can(u, 'reports') || !!u.serves?.length, back: true },
  { re: /^\/messages$/, view: messagesView, title: 'Mensajes', allow: may('messages'), back: true },
  { re: /^\/messages\/new$/, view: composeView, title: 'Nuevo mensaje', allow: may('messages'), back: true },
  { re: /^\/message\/(\d+)$/, view: messageView, title: 'Mensaje', back: true },
  { re: /^\/notifications$/, view: notificationsView, title: 'Avisos', back: true },
  { re: /^\/profile$/, view: profileView, title: 'Mi perfil', back: true },
  { re: /^\/more$/, view: moreView, title: 'Más' },
  { re: /^\/guide$/, view: guideView, title: 'Cómo usar Hallway', back: true },
];

const appRoot = document.getElementById('app');
let shellKey = null;
let navSeq = 0;
let cleanups = [];

function renderShell(route, path) {
  const { user, school } = state.me;
  const key = `${user.id}:${user.role}:${(user.permissions || []).join()}`;
  if (shellKey !== key || !document.getElementById('view')) {
    shellKey = key;
    appRoot.innerHTML = String(html`
      <div class="shell">
        <nav class="tabbar" aria-label="Navegación principal">
          <div class="side-brand">
            <img src="${appIcon()}" alt="" width="36" height="36" data-app-icon>
            <div><strong>Hallway</strong><small>${school.name}</small></div>
          </div>
          ${navItems(user).map(
            (item) => html`<a class="tab" href="#${item.path}" data-path="${item.path}"
                data-match="${(item.match || [item.path]).join(',')}">
                <span class="tab-icon">${icon(item.icon, 22)}${item.badge ? raw('<b class="dot" data-unread hidden></b>') : ''}</span>
                <span>${item.label}</span></a>`,
          )}
        </nav>
        <div class="main-col">
          <header class="topbar">
            <button class="icon-btn" data-back aria-label="Volver">${icon('back', 22)}</button>
            <img class="topbar-logo" src="${appIcon()}" alt="" width="30" height="30" data-app-icon>
            <div class="topbar-title"><h1 id="page-title"></h1><small>${school.name}</small></div>
            <a class="icon-btn" href="#/notifications" aria-label="Avisos">${icon('bell', 22)}<b class="dot" data-unread hidden></b></a>
          </header>
          <main id="view" class="view"></main>
        </div>
      </div>`);
    appRoot.querySelector('[data-back]').addEventListener('click', () => {
      if (history.length > 1) history.back();
      else go(homePath());
    });
    setUnread(state.unread);
  }
  document.body.classList.remove('bare');
  document.getElementById('page-title').textContent = route.title || '';
  document.title = `${route.title ? `${route.title} · ` : ''}Hallway`;
  appRoot.querySelector('.topbar').classList.toggle('has-back', !!route.back);
  for (const tab of appRoot.querySelectorAll('.tab')) {
    const active = tab.dataset.match.split(',').some((m) => path === m || path.startsWith(m.endsWith('/') ? m : `${m}/`));
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

async function router() {
  const [rawPath, queryString = ''] = location.hash.replace(/^#/, '').split('?');
  const path = rawPath || '/';
  const query = new URLSearchParams(queryString);

  for (const fn of cleanups) fn();
  cleanups = [];

  let match = null;
  const route = ROUTES.find((r) => (match = path.match(r.re)));
  const user = state.me?.user;

  if (!route) return go(homePath(), { replace: true });
  if (!route.public && !user) {
    // Remember where they were going (e.g. a link from Teams) to continue there after signing in.
    state.nextPath = `${path}${queryString ? `?${queryString}` : ''}`;
    return go('/login', { replace: true });
  }
  if (user?.must_change_password && path !== '/change-password') return go('/change-password', { replace: true });
  if (path === '/login' && user) return go(homePath(), { replace: true });
  if (route.allow && !route.allow(user)) return go(homePath(), { replace: true });

  const seq = ++navSeq;
  const el = document.createElement('div');
  el.className = 'view-inner';
  el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

  if (route.bare) {
    shellKey = null;
    document.body.classList.add('bare');
    document.title = 'Hallway';
    appRoot.replaceChildren(el);
  } else {
    renderShell(route, path);
    document.getElementById('view').replaceChildren(el);
  }
  window.scrollTo(0, 0);

  const ctx = {
    el,
    params: match.slice(1),
    query,
    state,
    isCurrent: () => seq === navSeq,
    onLeave: (fn) => cleanups.push(fn),
    setTitle: (t) => {
      const h = document.getElementById('page-title');
      if (h) h.textContent = t;
    },
    reload: () => router(),
  };

  try {
    await route.view(ctx);
  } catch (err) {
    if (seq !== navSeq) return;
    el.innerHTML = String(html`
      <div class="empty">
        ${icon('alert', 40)}
        <h3>No se pudo cargar</h3>
        <p>${err.message}</p>
        <button class="btn btn-secondary" data-retry>${icon('refresh')} Reintentar</button>
      </div>`);
    el.querySelector('[data-retry]').addEventListener('click', () => router());
  }
  if (user && !route.bare) refreshUnread();
}

/** An urgent notice while the app is open: alarm on screen (the screen already showing it just refreshes). */
function onPush(e) {
  refreshUnread();
  const notice = e.detail;
  if (!notice?.urgent || !state.me || document.visibilityState !== 'visible') return;
  if (notice.link && location.hash === notice.link) return;
  showAlarm(notice, {
    onOpen: () => {
      if (notice.link) location.hash = notice.link;
    },
    // Closing it counts as seen: no more repeats of that notice.
    onClose: () => notice.link && markAlertsRead(notice.link).catch(() => {}),
  });
}

function sessionEnded() {
  if (!state.me) return;
  state.me = null;
  toast('Tu sesión expiró. Vuelve a entrar.', 'error');
  go('/login', { replace: true });
}

async function boot() {
  initPwa();
  unlockAudio();
  restoreBranding();
  adoptSchoolFromUrl();
  try {
    state.me = await getMe();
  } catch (err) {
    toast(err.message, 'error');
  }
  if (state.me) {
    // The school may have changed its code or icon since this device last saw it.
    rememberSchool(state.me.school);
    applyBranding(state.me.school);
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('lah:unauthorized', sessionEnded);
  window.addEventListener('lah:signed-out', sessionEnded);
  window.addEventListener('lah:push', onPush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUnread();
  });
  setInterval(refreshUnread, 60000);

  if (state.me) syncPush();
  if (!location.hash || location.hash === '#' || location.hash === '#/') go(homePath(), { replace: true });
  else router();
}

// Every module loaded: boot.js doesn't need to offer «Actualizar».
window.hallwayStarted?.();
boot();
