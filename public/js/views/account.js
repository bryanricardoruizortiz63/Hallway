import {
  changePassword,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setMyLanguage,
  setMyNotifyOff,
  setMyRoom,
  testPush,
  updateAdminProfile,
  updateMyContact,
} from '../backend.js';
import { $, busy, can, fmtTime, formValues, html, isAdmin, isManager, isStaff, moduleOn, pathModule, raw, reportsOwn, rolesLabel, timeAgo, toast, todayStr } from '../lib.js';
import { locale } from '../i18n.js';
import { icon } from '../icons.js';
import { currentPushSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from '../pwa.js';
import { go, homePath, logout, setUnread, state } from '../store.js';
import { addAccount, authenticator, cancelCode, checkCode, codeGiven, savedAccounts, startAuthenticator, switchAccount } from '../accounts.js';

/** Under a saved account whose session Supabase closed. */
const REOPEN_HINT = 'Toca para escribir su contraseña otra vez';
import { inTabBar } from '../nav.js';
import { appIcon } from '../branding.js';
import { bindPasswordToggles } from './auth.js';
import { avatar, bindLanguageSwitch, empty, installHint, languageSwitch } from './common.js';

// ---- Push toggle card ----------------------------------------------------------

async function pushCard(slot, { compact = false } = {}) {
  if (!slot) return;
  const supported = pushSupported();
  const sub = supported ? await currentPushSubscription().catch(() => null) : null;
  const enabled = !!sub && Notification.permission === 'granted';
  if (compact && enabled) {
    slot.innerHTML = '';
    return;
  }

  let content;
  if (!supported) {
    content = isIos() && !isStandalone()
      ? html`<p class="muted">Para recibir notificaciones en iPhone, primero añade la app a tu pantalla de inicio y ábrela desde allí.</p>`
      : html`<p class="muted">Este navegador no admite notificaciones push. Verás los avisos dentro de la app.</p>`;
  } else if (enabled) {
    content = html`<p class="status-note ok">${icon('check', 16)} Activadas en este dispositivo</p>
      <div class="button-row">
        <button class="btn btn-secondary btn-sm" data-push-test>${icon('send', 16)} Probar</button>
        <button class="btn btn-ghost btn-sm" data-push-off>Desactivar</button>
      </div>`;
  } else {
    content = html`<p class="muted">Recibe un aviso en tu teléfono ${isStaff(state.me.user)
      ? 'cada vez que alguien reporte una ausencia.'
      : 'cuando la dirección reciba tu ausencia o te deje un comentario.'}</p>
      <button class="btn btn-primary btn-sm" data-push-on>${icon('bell', 16)} Activar notificaciones</button>`;
  }
  slot.innerHTML = String(html`<section class="card stack"><h2 class="card-title">${icon('bell')} Notificaciones en este teléfono</h2>${content}</section>`);

  $('[data-push-on]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await enablePush();
      toast('Notificaciones activadas', 'ok');
      await pushCard(slot, { compact });
    }),
  );
  $('[data-push-off]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await disablePush();
      toast('Notificaciones desactivadas');
      await pushCard(slot, { compact });
    }),
  );
  $('[data-push-test]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await testPush();
      toast('Enviada. Debería llegarte en unos segundos.', 'ok');
    }),
  );
}

// ---- Avisos -----------------------------------------------------------------------

/** What a notice is about, by where it leads: its section, icon and order. */
const CAUSES = [
  { key: 'absences', test: /^#\/(absence|cover|dashboard|absences|home)\b/, label: 'Ausencias', icon: 'calendar' },
  { key: 'turns', test: /^#\/turns\b/, label: 'Turnos', icon: 'pulse' },
  { key: 'alerts', test: /^#\/alerts\/(missing|new\/missing)\b/, label: 'No ha llegado', icon: 'alert' },
  { key: 'pickups', test: /^#\/alerts\/pickup\b/, label: 'Salidas', icon: 'user' },
  { key: 'relief', test: /^#\/alerts\/relief\b/, label: 'Relevos', icon: 'users' },
  { key: 'visits', test: /^#\/alerts\/visit\b/, label: 'Visitas', icon: 'door' },
  { key: 'maintenance', test: /^#\/maintenance\b/, label: 'Mantenimiento', icon: 'wrench' },
  { key: 'rooms', test: /^#\/rooms\b/, label: 'Salón de conferencias', icon: 'room' },
  { key: 'messages', test: /^#\/messages?\b/, label: 'Mensajes', icon: 'mail' },
  { key: 'summary', test: /^#\/summary\b/, label: 'Resumen del día', icon: 'chart' },
  { key: 'staff', test: /^#\/employees\b/, label: 'Personal y contraseñas', icon: 'key' },
  { key: 'other', test: /./, label: 'Otros avisos', icon: 'bell' },
];
const causeOf = (n) => CAUSES.find((c) => c.test.test(n.link || '')) || CAUSES.at(-1);

/** «Hoy», «Ayer» or «Lunes, 3 de noviembre». */
function noticeDay(iso) {
  const d = new Date(iso);
  const key = todayStr(d);
  const today = todayStr();
  if (key === today) return { key, title: 'Hoy' };
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === todayStr(y)) return { key, title: 'Ayer' };
  const s = d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  return { key, title: s.charAt(0).toUpperCase() + s.slice(1) };
}

export async function notificationsView({ el, isCurrent, onLeave }) {
  let filter = 'all';
  let list = [];
  let unreadCount = 0;
  const draw = () => {
    const shown = filter === 'all' ? list : list.filter((n) => causeOf(n).key === filter);
    // Days, newest first; in each day, one block per cause (the cause with the newest notice first).
    const days = [];
    for (const n of shown) {
      const d = noticeDay(n.created_at);
      let day = days.find((x) => x.key === d.key);
      if (!day) days.push((day = { ...d, causes: [] }));
      const c = causeOf(n);
      let block = day.causes.find((x) => x.cause.key === c.key);
      if (!block) day.causes.push((block = { cause: c, items: [] }));
      block.items.push(n);
    }
    const present = CAUSES.filter((c) => list.some((n) => causeOf(n).key === c.key));
    $('[data-notices]', el).innerHTML = String(html`
      ${present.length > 1 ? html`<div class="quick notice-filter" role="group" aria-label="Filtrar avisos">
          <button type="button" class="chip-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">Todos</button>
          ${present.map((c) => html`<button type="button" class="chip-btn ${filter === c.key ? 'active' : ''}" data-filter="${c.key}">
            ${icon(c.icon, 14)} ${c.label} <span class="count">${list.filter((n) => causeOf(n).key === c.key).length}</span></button>`)}
        </div>` : ''}
      ${days.map((d) => html`<section class="section notice-day">
          <h3 class="section-title">${d.title}</h3>
          ${d.causes.map((b) => html`<div class="notice-cause">
            <h4 class="notice-cause-title">${icon(b.cause.icon, 16)} ${b.cause.label} <span class="count">${b.items.length}</span></h4>
            <div class="list">${b.items.map(
              (n) => html`<a class="item notif ${n.read_at ? '' : 'unread'}" href="${n.link || '#/notifications'}" data-id="${n.id}">
                <span class="notif-icon">${icon(b.cause.icon, 18)}</span>
                <span class="item-main">
                  <strong>${n.title}</strong>
                  ${n.body ? html`<span class="item-sub">${n.body}</span>` : ''}
                  <span class="item-time">${fmtTime(new Date(n.created_at))} · ${timeAgo(n.created_at)}</span>
                </span>
              </a>`,
            )}</div>
          </div>`)}
        </section>`)}`);
    for (const b of el.querySelectorAll('[data-filter]')) {
      b.addEventListener('click', () => {
        filter = b.dataset.filter;
        draw();
      });
    }
    for (const a of el.querySelectorAll('.notif.unread')) {
      a.addEventListener('click', () => {
        markNotificationRead(Number(a.dataset.id)).catch(() => {});
      });
    }
  };
  const load = async () => {
    const { notifications, unread } = await listNotifications();
    if (!isCurrent()) return;
    setUnread(unread);
    list = notifications;
    unreadCount = unread;
    el.innerHTML = String(html`
      <div data-push-slot></div>
      ${list.length
        ? html`
          <div class="list-head">
            <p class="muted">${unreadCount ? `${unreadCount} sin leer` : 'Todo leído'}</p>
            ${unreadCount ? html`<button class="btn btn-ghost btn-sm" data-read-all>${icon('check', 16)} Marcar todo como leído</button>` : ''}
          </div>
          <div data-notices></div>`
        : empty('bell', 'No tienes avisos', 'Aquí aparecerán las novedades sobre las ausencias.')}`);
    pushCard($('[data-push-slot]', el), { compact: true });
    $('[data-read-all]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await markAllNotificationsRead();
        await load();
      }),
    );
    if (list.length) draw();
  };
  await load();
  const onPush = () => load().catch(() => {});
  window.addEventListener('lah:push', onPush);
  onLeave(() => window.removeEventListener('lah:push', onPush));
}

// ---- Perfil -----------------------------------------------------------------------

/** The room where I usually am (I change it) and the groups I teach (the dirección assigns them). */
function roomCard(user) {
  const groups = user.groups || [];
  return html`<form class="card stack" data-room novalidate>
    <h2 class="card-title">${icon('school')} Mi salón y grupos</h2>
    <label class="field"><span>Salón</span>
      <input name="room" maxlength="40" value="${user.room || ''}" placeholder="Ej. 204 o Biblioteca" autocomplete="off"></label>
    ${groups.length
      ? html`<div class="field"><span>Mis grupos</span>
          <div class="chips">${groups.map((g) => html`<span class="tag">${g}</span>`)}</div></div>
        <p class="hint">Tus grupos los asigna la dirección. Si falta alguno, avísale.</p>`
      : user.coverage
        ? html`<p class="hint">Aún no tienes grupos asignados. Los asigna la dirección.</p>`
        : ''}
    <button class="btn btn-secondary" type="submit">Guardar salón</button>
  </form>`;
}

// ---- Which alerts sound -----------------------------------------------------------

/** Kinds of notices each person can mute (the alert on the phone; the notice still shows in the bell). */
function muteKinds(user, school) {
  const turnsOn = moduleOn(school, 'turns') || moduleOn(school, 'support');
  return [
    { key: 'absences', label: 'Ausencias y cubiertas', hint: 'Ausencias nuevas, a quién te toca cubrir y cambios.', on: true },
    { key: 'turns', label: 'Turnos', hint: 'Turnos que pides o atiendes (Enfermería, IT…).', on: turnsOn },
    { key: 'relief', label: 'Relevos', hint: 'Cuando alguien pide un relevo o te toca darlo.', on: moduleOn(school, 'alerts') },
    { key: 'alerts', label: 'Estudiantes que no han llegado', hint: 'Alertas de estudiantes que faltan al salón.', on: moduleOn(school, 'alerts') },
    { key: 'pickups', label: 'Salidas de estudiantes', hint: 'Cuando recogen a un estudiante.', on: moduleOn(school, 'alerts') },
    { key: 'visits', label: 'Visitas', hint: 'Visitas que llegan a la escuela.', on: moduleOn(school, 'visits') },
    { key: 'maintenance', label: 'Mantenimiento', hint: 'Pedidos de mantenimiento y su estado.', on: moduleOn(school, 'maintenance') },
    { key: 'rooms', label: 'Salón de conferencias', hint: 'Reservas del salón.', on: moduleOn(school, 'rooms') },
    { key: 'messages', label: 'Mensajes', hint: 'Mensajes de la administración.', on: true },
    { key: 'summary', label: 'Resumen del día', hint: 'El resumen al terminar las clases.', on: can(user, 'summary') },
  ].filter((k) => k.on);
}

function notifyCard(user, school) {
  const off = new Set(user.notify_off || []);
  return html`<section class="card stack" data-notify>
    <h2 class="card-title">${icon('bell')} Qué avisos te llegan</h2>
    <p class="hint">Apaga los que no necesitas: ya no sonarán en tu teléfono, pero seguirán en la campana de avisos.
      Los avisos de tu cuenta y contraseña siempre llegan.</p>
    <div class="notify-list">
      ${muteKinds(user, school).map((k) => html`<label class="toggle notify-row">
          <input type="checkbox" data-kind="${k.key}" ${off.has(k.key) ? '' : 'checked'}>
          <span class="toggle-ui"></span><span class="notify-text"><span>${k.label}</span><small>${k.hint}</small></span></label>`)}
    </div>
  </section>`;
}

function bindNotifyCard(el, user) {
  const card = $('[data-notify]', el);
  card?.addEventListener('change', async (e) => {
    const box = e.target.closest('[data-kind]');
    if (!box) return;
    const before = user.notify_off || [];
    const off = [...card.querySelectorAll('[data-kind]')].filter((b) => !b.checked).map((b) => b.dataset.kind);
    box.disabled = true;
    try {
      user.notify_off = await setMyNotifyOff(off);
      toast(box.checked ? 'Avisos encendidos' : 'Avisos apagados', 'ok');
    } catch (err) {
      box.checked = !before.includes(box.dataset.kind);
      toast(err.message, 'error');
    } finally {
      box.disabled = false;
    }
  });
}

export async function profileView({ el }) {
  const { user, school } = state.me;
  el.innerHTML = String(html`
    <div class="stack">
      <section class="card profile-head">
        ${avatar(user.full_name, 'xl')}
        <h2>${user.full_name}</h2>
        <p class="muted">${user.position ? `${user.position} · ${rolesLabel(user)}` : rolesLabel(user)}</p>
        <div class="profile-meta">
          <span>${icon('school', 16)} ${school.name}</span>
          <span>${icon('key', 16)} ${school.code} · ${user.username}</span>
        </div>
      </section>

      ${reportsOwn(user) && isStaff(user)
        ? html`<a class="card link-card" href="#/home">${icon('calendar')}<span><strong>Mis ausencias</strong><small>Tus propias ausencias y su estado</small></span>${icon('chevron', 18)}</a>`
        : ''}

      <section class="card stack">
        <h2 class="card-title" translate="no">${icon('globe')} Idioma · Language</h2>
        ${languageSwitch()}
        <p class="hint">Se guarda en tu cuenta: Hallway se abre en este idioma en cualquier teléfono.</p>
      </section>

      <div data-push-slot></div>
      ${notifyCard(user, school)}
      <div data-install-slot></div>

      ${user.role !== 'admin' ? roomCard(user) : ''}
      ${isStaff(user) || isManager(user)
        ? ''
        : html`<a class="card link-card" href="#/calendar">${icon('calendar')}<span><strong>Calendario escolar</strong><small>Horario de clases y días sin clases</small></span>${icon('chevron', 18)}</a>`}

      ${user.role === 'admin'
        ? html`<form class="card stack" data-admin-profile>
            <h2 class="card-title">${icon('user')} Mis datos</h2>
            <p class="hint">La cuenta Admin de la escuela es tuya: con este nombre te ven los demás en los mensajes, las ausencias
              que registras y los avisos.</p>
            <label class="field"><span>Nombre</span><input name="full_name" required maxlength="120" value="${['Administración', 'Admin'].includes(user.full_name) ? '' : user.full_name}" placeholder="Ej. María Rivera" autocomplete="name"></label>
            <label class="field"><span>Puesto</span><input name="position" maxlength="120" value="${user.position || ''}" placeholder="Ej. Directora"></label>
            <label class="field"><span>Correo</span><input name="email" type="email" value="${user.email || ''}" autocapitalize="none"></label>
            <label class="field"><span>Teléfono</span><input name="phone" type="tel" value="${user.phone || ''}"></label>
            <button class="btn btn-secondary" type="submit">Guardar</button>
          </form>`
        : ''}

      ${user.role !== 'admin'
        ? html`<form class="card stack" data-contact>
            <h2 class="card-title">${icon('user')} Mis datos de contacto</h2>
            <label class="field"><span>Correo</span><input name="email" type="email" value="${user.email || ''}" autocapitalize="none"></label>
            <label class="field"><span>Teléfono</span><input name="phone" type="tel" value="${user.phone || ''}"></label>
            <button class="btn btn-secondary" type="submit">Guardar</button>
          </form>`
        : ''}

      <form class="card stack" data-password>
        <h2 class="card-title">${icon('key')} Cambiar contraseña</h2>
        <label class="field"><span>Contraseña actual</span>
          <span class="pw"><input name="current_password" type="password" required autocomplete="current-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <label class="field"><span>Nueva contraseña (mín. 8)</span>
          <span class="pw"><input name="new_password" type="password" required minlength="8" autocomplete="new-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <button class="btn btn-secondary" type="submit">Cambiar contraseña</button>
      </form>

      <button class="btn btn-ghost-danger btn-block" data-logout>${icon('logout', 18)} Cerrar sesión</button>
      <p class="hint center">Hallway</p>
    </div>`);

  bindPasswordToggles(el);
  bindLanguageSwitch(el, async (code) => {
    await setMyLanguage(code);
    user.language = code;
  });
  pushCard($('[data-push-slot]', el));
  bindNotifyCard(el, user);
  installHint($('[data-install-slot]', el), { dismissible: false });
  $('[data-logout]', el).addEventListener('click', logout);

  const room = $('[data-room]', el);
  room?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(room.querySelector('[type=submit]'), async () => {
      user.room = await setMyRoom(room.room.value);
      room.room.value = user.room || '';
      toast('Salón guardado', 'ok');
    });
  });

  const contact = $('[data-contact]', el);
  contact?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(contact.querySelector('[type=submit]'), async () => {
      const v = formValues(contact);
      await updateMyContact(v.email, v.phone);
      Object.assign(state.me.user, v);
      toast('Datos guardados', 'ok');
    });
  });

  const adminProfile = $('[data-admin-profile]', el);
  adminProfile?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(adminProfile.querySelector('[type=submit]'), async () => {
      const v = formValues(adminProfile);
      if (!String(v.full_name || '').trim()) throw new Error('Escribe tu nombre.');
      await updateAdminProfile(v);
      Object.assign(state.me.user, {
        full_name: v.full_name.trim(), position: v.position.trim() || null, email: v.email.trim() || null, phone: v.phone.trim() || null,
      });
      toast('Datos guardados', 'ok');
      // The name shows at the top and in the side bar too.
      window.dispatchEvent(new Event('hashchange'));
    });
  });

  const pw = $('[data-password]', el);
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(pw.querySelector('[type=submit]'), async () => {
      const v = formValues(pw);
      if (v.new_password.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres.');
      await changePassword(v.current_password, v.new_password);
      pw.reset();
      toast('Contraseña actualizada', 'ok');
    });
  });
}

// ---- Más ------------------------------------------------------------------------

/** Whether a link of Más goes to a module the school uses. */
function linkOn(href) {
  const path = href.replace(/^#/, '');
  const school = state.me.school;
  if (path === '/turns') return moduleOn(school, 'turns') || moduleOn(school, 'support') || moduleOn(school, 'maintenance');
  const mod = pathModule(path);
  return !mod || moduleOn(school, mod);
}

export async function moreView({ el }) {
  const { user } = state.me;
  const admin = isAdmin(user);
  // Whatever the bottom bar doesn't already have (see nav.js), in groups so each thing is easy to find.
  const groups = [
    ['Ausencias', [
      isStaff(user)
        ? !reportsOwn(user)
          ? can(user, 'register') ? ['#/report', 'plus', 'Registrar ausencia de un empleado', 'Si alguien no pudo reportarla o hubo un error'] : null
          : can(user, 'register')
            ? ['#/report', 'plus', 'Registrar una ausencia', 'La tuya o la de otro empleado que avisó que va a faltar']
            : ['#/report', 'plus', 'Reportar mi ausencia', 'Avisa que vas a faltar']
        : null,
      reportsOwn(user) && isStaff(user) ? ['#/home', 'calendar', 'Mis ausencias', 'Tus propias ausencias y su estado'] : null,
      isStaff(user) ? ['#/absences', 'list', 'Todas las ausencias', 'Busca por persona o fechas y exporta a Excel'] : null,
    ]],
    ['Día a día', [
      ['#/turns', 'pulse', 'Turnos', 'Enfermería, Trabajo Social y otros servicios'],
      ['#/maintenance', 'wrench', 'Mantenimiento', 'Pide limpieza y sigue las solicitudes'],
      can(user, 'rooms')
        ? ['#/rooms', 'room', 'Salón de conferencias', 'Reserva el salón y aprueba las reservas del personal']
        : ['#/rooms', 'room', 'Salón de conferencias', 'Resérvalo o mira quién lo tiene'],
      can(user, 'live') ? ['#/live', 'live', 'En vivo', 'Enfermería, Trabajo Social, alertas, mantenimiento y salón ahora mismo'] : null,
      can(user, 'summary') ? ['#/summary', 'chart', 'Resumen del día', 'Quién faltó y si se cubrió, turnos, alertas, mantenimiento y mañana'] : null,
      ['#/calendar', 'calendar', 'Calendario escolar', 'Horario de clases, horario del salón y días sin clases'],
    ]],
    ['Administración', [
      can(user, 'staff') ? ['#/employees', 'users', 'Personal', 'Empleados, contraseñas, roles, salón y grupos'] : null,
      can(user, 'calendar') ? ['#/groups', 'grid', 'Grados y grupos', 'Los grupos de la escuela (7-A, 7-B…) para el personal'] : null,
      can(user, 'messages') ? ['#/messages', 'mail', 'Mensajes', 'Escribe al personal: aviso en la app y por correo'] : null,
      can(user, 'settings') ? ['#/settings', 'teams', 'Escuela y Teams', 'Nombre, código, Teams, correo y contraseña de Admin'] : null,
      can(user, 'history') ? ['#/history', 'list', 'Historial del personal', 'Lo que hizo cada persona, con día y hora; se puede imprimir'] : null,
      admin ? ['#/roles', 'shield', 'Roles y permisos', 'Crea roles como Enfermería o Seguridad y elige qué puede hacer cada uno'] : null,
      can(user, 'services') ? ['#/services', 'sliders', 'Servicios', 'Enfermería, Trabajo Social: quién atiende, motivos y tiempo para llegar'] : null,
      can(user, 'reports')
        ? ['#/data', 'chart', 'Datos y reportes', 'Estadísticas, paneles de los servicios, exportar a Excel y respaldo']
        : user.serves?.length
          ? ['#/data', 'chart', 'Datos y reportes', `Panel de ${user.serves.map((s) => s.name).join(' y ')}: estadísticas y Excel`]
          : null,
    ]],
    ['Tu cuenta', [
      canAddAccount(user) ? ['#/accounts/add', 'plus', 'Agregar otra cuenta', 'Si tienes otra cuenta (p. ej. la de Admin de la escuela y la tuya): cambias sin salir'] : null,
      ['#/notifications', 'bell', 'Avisos', state.unread ? `${state.unread} sin leer` : 'Lo que te ha llegado: ausencias, turnos, alertas y mensajes'],
      ['#/profile', 'user', 'Mi perfil', 'Idioma, notificaciones, contraseña, tu salón e instalar la app'],
      ['#/guide', 'sparkle', 'Cómo usar Hallway', 'Dónde está cada cosa'],
    ]],
  ]
    .map(([title, links]) => [title, links.filter((link) => link && !inTabBar(user, link[0].slice(1)) && linkOn(link[0]))])
    .filter(([, links]) => links.length);

  const others = savedAccounts().filter((a) => a.id !== user.id);
  el.innerHTML = String(html`
    <div class="more-groups">
      ${others.length
        ? html`<section class="section" data-accounts>
            <h3 class="section-title">Cambiar de cuenta</h3>
            <div class="list">${others.map(
              (a) => html`<button type="button" class="item" data-switch="${a.id}">
                <span class="item-icon">${icon('user')}</span>
                <span class="item-main"><strong>${a.name}</strong><span class="item-sub">${a.expired ? REOPEN_HINT : [a.role, a.school].filter(Boolean).join(' · ')}</span></span>
                ${icon('swap', 18)}
              </button>`,
            )}</div>
          </section>`
        : ''}
      ${groups.map(
        ([title, links]) => html`<section class="section">
          <h3 class="section-title">${title}</h3>
          <div class="list">${links.map(
            ([href, ic, name, sub]) => html`<a class="item" href="${href}">
              <span class="item-icon">${icon(ic)}</span>
              <span class="item-main"><strong>${name}</strong><span class="item-sub">${sub}</span></span>
              ${icon('chevron', 18)}
            </a>`,
          )}</div>
        </section>`,
      )}
      <div class="section">
        <button class="btn btn-ghost-danger btn-block" data-logout>${icon('logout', 18)} Cerrar sesión</button>
      </div>
    </div>`);
  $('[data-logout]', el).addEventListener('click', logout);
  for (const btn of el.querySelectorAll('[data-switch]')) {
    btn.addEventListener('click', () => busy(btn, () => switchAccount(btn.dataset.switch, state.me)));
  }
}

// ---- Several accounts on one phone ------------------------------------------------------------

let menu = null;

function closeAccountMenu() {
  if (!menu) return;
  const m = menu;
  menu = null;
  m.classList.add('is-closing');
  setTimeout(() => m.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  document.removeEventListener('keydown', onMenuKey);
  window.removeEventListener('hashchange', closeAccountMenu);
}

function onMenuKey(e) {
  if (e.key === 'Escape') closeAccountMenu();
}

/**
 * Tapping your picture at the top: like Google's account menu. Who you are (and your profile), the other accounts
 * saved on this phone (one tap to switch), add another one and sign out.
 */
export function openAccountMenu(trigger) {
  if (menu) return closeAccountMenu();
  const { user, school } = state.me;
  const others = savedAccounts().filter((a) => a.id !== user.id);
  menu = document.createElement('div');
  menu.className = 'acct-layer';
  menu.innerHTML = String(html`
    <div class="acct-sheet" role="dialog" aria-modal="true" aria-label="Tu cuenta">
      <div class="acct-top">
        <span class="acct-brand"><img src="${appIcon()}" alt="" width="24" height="24" data-app-icon> Hallway</span>
        <button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('x', 20)}</button>
      </div>
      <div class="acct-me">
        ${avatar(user.full_name, 'xl')}
        <strong>¡Hola, ${user.full_name.split(' ')[0]}!</strong>
        <small>${[rolesLabel(user), school.name].filter(Boolean).join(' · ')}</small>
        <a class="btn btn-secondary btn-sm acct-profile" href="#/profile">${icon('user', 16)} Mi perfil</a>
      </div>
      <div class="acct-list">
        ${others.map((a) => html`<button type="button" class="acct-row" data-switch="${a.id}">
          ${avatar(a.name)}
          <span class="acct-row-text"><strong>${a.name}</strong><small>${a.expired ? REOPEN_HINT : [a.role, a.school].filter(Boolean).join(' · ')}</small></span>
          ${icon('swap', 18)}
        </button>`)}
        ${canAddAccount(user)
          ? html`<a class="acct-row" href="#/accounts/add">
              <span class="acct-add">${icon('plus', 20)}</span>
              <span class="acct-row-text"><strong>Agregar otra cuenta</strong><small>Ej. la de Admin de la escuela y la tuya</small></span>
            </a>`
          : ''}
        <button type="button" class="acct-row" data-logout>
          <span class="acct-add">${icon('logout', 20)}</span>
          <span class="acct-row-text"><strong>Cerrar sesión</strong></span>
        </button>
      </div>
      ${others.length ? html`<p class="acct-note">${icon('shield', 14)} Cada cuenta te pide su código una vez al día.</p>` : ''}
    </div>`);
  document.body.append(menu);
  menu.addEventListener('click', (e) => {
    if (e.target === menu || e.target.closest('[data-close]')) closeAccountMenu();
  });
  for (const btn of menu.querySelectorAll('[data-switch]')) {
    btn.addEventListener('click', () => busy(btn, async () => {
      await switchAccount(btn.dataset.switch, state.me);
      // Still here: it went to type that account's password again.
      closeAccountMenu();
    }));
  }
  menu.querySelector('[data-logout]').addEventListener('click', () => {
    closeAccountMenu();
    logout();
  });
  document.addEventListener('keydown', onMenuKey);
  window.addEventListener('hashchange', closeAccountMenu);
  menu.querySelector('[data-close]').focus();
  trigger?.setAttribute('aria-expanded', 'true');
}

/** Whoever manages the school (and whoever already has two accounts here) can add one. */
const canAddAccount = (user) => isAdmin(user) || isManager(user) || savedAccounts().length > 1;

export async function addAccountView({ el, query }) {
  const me = state.me;
  // An account already on this phone whose session Supabase closed: only its password, once.
  const again = savedAccounts().find((a) => a.id === query.get('cuenta') && a.expired);
  el.innerHTML = String(html`
    <div class="stack">
      <section class="card stack">
        ${again
          ? html`<h2 class="card-title">${icon('user')} Volver a abrir «${again.name}»</h2>
              <p class="hint">Supabase cerró la sesión guardada de esta cuenta. Pasa, por ejemplo, la primera vez que la misma cuenta
                configura o pasa la verificación en dos pasos en otro equipo. Escribe su contraseña <strong>una sola vez</strong>;
                desde ahí queda guardada otra vez y solo te pide el código del día.</p>`
          : html`<h2 class="card-title">${icon('plus')} Agregar otra cuenta</h2>
              <p class="hint">Para quien tiene dos cuentas en Hallway, por ejemplo la de Admin de la escuela y la suya. Las dos quedan
                en este teléfono y cambias desde <strong>Más</strong> con un toque, sin salir. Cada día, cada cuenta te pide el código
                de una app de autenticación (Google Authenticator o Microsoft Authenticator); la primera vez te ayudamos a configurarla.</p>`}
        <form class="stack" data-add-account novalidate>
          <label class="field"><span>Código de escuela</span>
            <input name="school_code" required autocapitalize="characters" spellcheck="false" value="${again?.code || me.school.code}"></label>
          <label class="field"><span>Usuario de la otra cuenta</span>
            <input name="username" required autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="Ej. admin" value="${again?.username || ''}"></label>
          <label class="field"><span>Contraseña</span>
            <span class="pw"><input name="password" type="password" required autocomplete="off">
              <button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
          <button type="submit" class="btn btn-primary btn-block btn-lg">${again ? html`${icon('user', 18)} Abrir` : html`${icon('plus', 18)} Agregar y abrir`}</button>
        </form>
      </section>
    </div>`);
  bindPasswordToggles(el);
  const form = $('[data-add-account]', el);
  // School and user already there: straight to the password.
  if (again?.username) form.password.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(form);
    busy(form.querySelector('[type=submit]'), () => addAccount(me, v.school_code, v.username, v.password));
  });
}

/** With two or more accounts on this phone: the code of the authenticator app, once a day per account. */
export async function verifyCodeView({ el }) {
  const me = state.me;
  const factor = await authenticator().catch(() => null);
  let setup = null;
  if (!factor) {
    try {
      setup = await startAuthenticator(me);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  const factorId = setup?.factorId || factor?.id;
  el.innerHTML = String(html`
    <div class="otp-screen">
      <span class="otp-blob otp-blob-1" aria-hidden="true"></span>
      <span class="otp-blob otp-blob-2" aria-hidden="true"></span>
      <span class="otp-blob otp-blob-3" aria-hidden="true"></span>
      <div class="otp-card">
        <div class="otp-head">
          <span class="otp-lock">${icon('shield', 26)}</span>
          <h1>Verificación en dos pasos</h1>
          <p>${me.user.full_name} · ${me.school.name}</p>
        </div>
        ${setup
          ? html`<p><strong>Primera vez con esta cuenta:</strong></p>
              <ol class="steps-list">
                <li>Instala <strong>Google Authenticator</strong> o <strong>Microsoft Authenticator</strong> en tu teléfono.</li>
                <li>En la app toca <strong>+</strong> y escanea este código.</li>
                <li>Escribe aquí el código de 6 números que te sale para «Hallway».</li>
              </ol>
              <div class="mfa-qr">${raw(setup.qr)}</div>
              <p class="otp-lead">En tu app saldrá como <strong>${setup.issuer}</strong> · ${setup.account}</p>
              <details><summary>¿No puedes escanearlo?</summary>
                <p>En la app elige «Escribir una clave» y pon: <code class="mfa-secret">${setup.secret}</code></p></details>`
          : html`<p class="otp-lead">Escribe el código de 6 números de <strong>Hallway</strong> que sale en tu app de autenticación. Te lo pide una vez al día.</p>`}
        <form data-code novalidate>
          ${otpField()}
          <p class="otp-status" data-otp-status aria-live="polite"></p>
        </form>
        <button type="button" class="btn btn-secondary btn-block" data-cancel>Cancelar</button>
      </div>
    </div>`);
  const form = $('[data-code]', el);
  const status = $('[data-otp-status]', el);
  bindOtp($('[data-otp]', el), async (code, otp) => {
    if (!factorId) return otp.fail('No se pudo preparar la verificación.');
    status.textContent = 'Verificando…';
    try {
      await checkCode(factorId, code);
    } catch (err) {
      status.textContent = '';
      return otp.fail(err.message);
    }
    status.textContent = '¡Listo!';
    await otp.succeed();
    state.needsCode = false;
    codeGiven();
    go(homePath(), { replace: true });
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  // Only the code or «Cancelar»: back to the account it came from (one just added is forgotten), else sign out.
  $('[data-cancel]', el).addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      if (!(await cancelCode(me))) await logout();
    }));
}

/** Six glass boxes over one real input (so autofill from SMS/keyboard and paste work). */
export function otpField() {
  return html`<label class="otp" data-otp>
    <input class="otp-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
      pattern="[0-9]*" aria-label="Código de 6 números" autofocus>
    ${[0, 1, 2, 3, 4, 5].map((i) => html`<span class="otp-box" style="--i:${i}" aria-hidden="true"></span>`)}
  </label>`;
}

/**
 * The boxes fill as the code is typed (each digit pops in) and the next one glows. With 6 digits, onComplete(code,
 * otp) runs once: otp.fail(message) shakes the boxes and clears them; otp.succeed() turns them green, one by one.
 */
export function bindOtp(root, onComplete) {
  const input = root.querySelector('.otp-input');
  const boxes = [...root.querySelectorAll('.otp-box')];
  let busyNow = false;
  const paint = () => {
    const v = input.value;
    boxes.forEach((b, i) => {
      const digit = v[i] || '';
      if (b.textContent !== digit) {
        b.textContent = digit;
        b.classList.toggle('is-filled', !!digit);
      }
      b.classList.toggle('is-active', document.activeElement === input && i === Math.min(v.length, 5) && !busyNow);
    });
  };
  const otp = {
    fail(message) {
      busyNow = false;
      root.classList.remove('is-error');
      void root.offsetWidth; // restart the shake
      root.classList.add('is-error');
      toast(message, 'error');
      setTimeout(() => {
        root.classList.remove('is-error');
        input.value = '';
        input.disabled = false;
        input.focus();
        paint();
      }, 450);
    },
    succeed() {
      root.classList.add('is-success');
      return new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650));
    },
  };
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    paint();
    if (input.value.length === 6 && !busyNow) {
      busyNow = true;
      input.disabled = true;
      paint();
      onComplete(input.value, otp);
    }
  });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', paint);
  input.focus();
  paint();
}
