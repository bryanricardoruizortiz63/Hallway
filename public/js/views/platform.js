import { platform } from '../backend.js';
import { APP_URL } from '../config.js';
import { $, busy, copyText, dialog, fmtDateTime, formValues, html, MODULES, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { logout, state } from '../store.js';
import { bindPasswordToggles } from './auth.js';
import { empty } from './common.js';
import { iconTool } from './icon-tool.js';

function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "16.6 MB", "820 KB". */
function megabytes(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export async function platformView(ctx) {
  const { el } = ctx;
  if (state.me) {
    el.innerHTML = String(html`<div class="auth"><div class="card stack center">
      <p>Cierra la sesión de la escuela para entrar al panel de plataforma.</p>
      <a class="btn btn-secondary" href="#/login">Volver</a></div></div>`);
    return;
  }
  if (!state.platformPassword) return platformLogin(ctx);

  const call = (action, payload) => platform(state.platformPassword, action, payload);
  const { schools } = await call('list_schools');
  el.innerHTML = String(html`
    <div class="platform">
      <header class="platform-head">
        <div class="row"><img src="icons/icon-192.png" alt="" width="36" height="36">
          <div><h1>Panel de plataforma</h1><small class="muted">Hallway · ${schools.length} escuela(s)</small></div></div>
        <button class="btn btn-ghost btn-sm" data-logout>${icon('logout', 16)} Salir</button>
      </header>

      <form class="card stack" data-create>
        <h2 class="card-title">${icon('plus')} Nueva escuela</h2>
        <label class="field"><span>Nombre de la escuela</span><input name="name" required maxlength="150"></label>
        <div class="grid2">
          <label class="field"><span>Código <em class="optional">vacío = automático</em></span>
            <input name="code" maxlength="20" autocapitalize="characters" spellcheck="false" placeholder="Ej. ESC-01"></label>
          <label class="field"><span>Contraseña de Admin</span>
            <span class="pw"><input name="admin_password" type="text" required minlength="8" value="${randomPassword()}" autocomplete="off">
            <button type="button" class="pw-toggle" data-pw>Ocultar</button></span></label>
        </div>
        <button class="btn btn-primary" type="submit">Crear escuela</button>
      </form>

      <section class="stack">
        ${schools.length
          ? schools.map(
              (s) => html`<div class="card school ${s.active ? '' : 'is-muted'}">
                <div class="row">
                  <div class="grow"><strong>${s.name}</strong>
                    <p class="muted"><span class="mono">${s.code}</span> · ${s.employees} empleados · ${s.absences} ausencias
                    ${s.has_teams ? ' · Teams ✓' : ''}</p>
                    <small class="muted">Creada ${fmtDateTime(s.created_at)}${s.last_absence_at ? ` · última ausencia ${fmtDateTime(s.last_absence_at)}` : ''}</small>
                  </div>
                  ${s.active ? html`<span class="badge badge-ok">Activa</span>` : html`<span class="badge badge-muted">Inactiva</span>`}
                </div>
                <div class="usage-grid">
                  <span><strong>${s.active_month}</strong><small>entraron este mes</small></span>
                  <span><strong>${s.turns_month}</strong><small>turnos del mes</small></span>
                  <span><strong>${s.alerts_month}</strong><small>alertas del mes</small></span>
                  <span><strong>${s.maintenance_month}</strong><small>mantenimiento</small></span>
                  <span><strong>${s.bookings_month}</strong><small>reservas</small></span>
                  <span><strong>${megabytes(s.storage_bytes)}</strong><small>archivos</small></span>
                </div>
                <p class="muted small">${s.last_login_at ? `Último inicio de sesión ${timeAgo(s.last_login_at)}` : 'Nadie ha entrado todavía'}${(s.disabled_modules || []).length
                  ? ` · Apagado: ${s.disabled_modules.map((m) => MODULES[m]?.split(' (')[0] || m).join(', ')}` : ''}</p>
                <div class="button-row wrap">
                  <button class="btn btn-secondary btn-sm" data-modules="${s.id}">${icon('sliders', 16)} Módulos</button>
                  <button class="btn btn-secondary btn-sm" data-reset="${s.id}">${icon('key', 16)} Nueva contraseña admin</button>
                  <button class="btn btn-ghost btn-sm" data-toggle="${s.id}" data-active="${s.active}">${s.active ? 'Desactivar' : 'Activar'}</button>
                </div>
              </div>`,
            )
          : html`<div class="card">${empty('school', 'Aún no hay escuelas', 'Crea la primera con el formulario de arriba.')}</div>`}
      </section>

      <div data-icon-slot></div>
    </div>`);

  bindPasswordToggles(el);
  iconTool($('[data-icon-slot]', el), { schools, call, onChange: () => ctx.reload() });
  $('[data-logout]', el).addEventListener('click', logout);

  const form = $('[data-create]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      const { school } = await call('create_school', v);
      const text = `Hallway\nEnlace: ${APP_URL}?escuela=${encodeURIComponent(school.code)}\nEscuela: ${school.name}\nCódigo de escuela: ${school.code}\nContraseña de Admin: ${v.admin_password}`;
      const pending = dialog({
        title: 'Escuela creada ✅',
        body: html`<div class="credentials">
            <div><span>Código de escuela</span><strong class="mono">${school.code}</strong></div>
            <div><span>Contraseña de Admin</span><strong class="mono">${v.admin_password}</strong></div>
          </div>
          <p class="hint">La dirección entra en la pestaña “Admin” con estos datos.</p>
          <button type="button" class="btn btn-secondary btn-sm" data-copy>${icon('copy', 16)} Copiar</button>`,
        confirmText: 'Listo',
        cancelText: '',
      });
      document.querySelector('dialog.dialog:last-of-type [data-copy]').addEventListener('click', () => copyText(text));
      await pending;
      ctx.reload();
    });
  });

  for (const btn of el.querySelectorAll('[data-reset]')) {
    btn.addEventListener('click', async () => {
      const password = randomPassword();
      const ok = await dialog({
        title: '¿Generar nueva contraseña de Admin?',
        message: `La nueva contraseña será: ${password}. Cópiala antes de confirmar.`,
        confirmText: 'Cambiar',
      });
      if (!ok) return;
      await busy(btn, async () => {
        await call('reset_admin_password', { school_id: btn.dataset.reset, new_password: password });
        await copyText(password);
        toast('Contraseña cambiada y copiada', 'ok');
      });
    });
  }
  for (const btn of el.querySelectorAll('[data-modules]')) {
    btn.addEventListener('click', async () => {
      const school = schools.find((x) => x.id === btn.dataset.modules);
      const off = new Set(school.disabled_modules || []);
      const v = await dialog({
        title: `Módulos de ${school.name}`,
        message: 'Lo que apagues deja de verse en la app de esa escuela (pestañas, enlaces y servicios). Los datos no se borran.',
        body: html`<div class="stack">${Object.entries(MODULES).map(
          ([key, label]) => html`<label class="switch-inline"><input type="checkbox" name="${key}" ${off.has(key) ? '' : 'checked'}> ${label}</label>`,
        )}</div>`,
        confirmText: 'Guardar',
        collect: true,
      });
      if (!v) return;
      await busy(btn, async () => {
        await call('set_school_modules', { school_id: school.id, disabled_modules: Object.keys(MODULES).filter((k) => !v[k]) });
        toast('Módulos guardados', 'ok');
        ctx.reload();
      });
    });
  }
  for (const btn of el.querySelectorAll('[data-toggle]')) {
    btn.addEventListener('click', () =>
      busy(btn, async () => {
        await call('set_school_active', { school_id: btn.dataset.toggle, active: btn.dataset.active !== 'true' });
        ctx.reload();
      }),
    );
  }
}

function platformLogin({ el, reload }) {
  el.innerHTML = String(html`
    <div class="auth">
      <div class="auth-brand">
        <img src="icons/icon-192.png" alt="" class="auth-logo" width="64" height="64">
        <h1>Panel de plataforma</h1>
        <p>Crea y administra las escuelas que usan Hallway.</p>
      </div>
      <form class="card stack" data-form>
        <label class="field"><span>Contraseña de plataforma</span>
          <span class="pw"><input name="password" type="password" required autocomplete="current-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar</button>
        <a class="btn btn-ghost btn-block" href="#/login">Volver</a>
      </form>
    </div>`);
  bindPasswordToggles(el);
  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const { password } = formValues(form);
      await platform(password, 'list_schools');
      state.platformPassword = password;
      reload();
    });
  });
}
