// The platform panel (create and manage schools). Reached from admin.hallwayedu.com: no link in the app.
// Signing in takes the platform password and, every time, the code of an authenticator app (or one sent by email);
// the first time it shows the QR to set one up and a recovery code. The session lives only in memory and ends after
// 20 minutes without use (the server decides).
import { platform, platformSignIn } from '../backend.js';
import { APP_URL } from '../config.js';
import { $, busy, copyText, dialog, fmtDateTime, formValues, html, MODULES, raw, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { bindOtp, otpField } from './account.js';
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
  if (!state.platformSession) return platformLogin(ctx);

  const call = async (action, payload) => {
    try {
      return await platform(state.platformSession, action, payload);
    } catch (err) {
      // The session ended (20 minutes without use, 8 hours, or closed from another place): sign in again.
      if (err.status === 401) {
        state.platformSession = null;
        toast(err.message, 'error');
        ctx.reload();
      }
      throw err;
    }
  };
  const [{ schools }, sec] = await Promise.all([call('list_schools'), call('security_overview')]);
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
      ${securityCard(sec)}
    </div>`);

  bindPasswordToggles(el);
  iconTool($('[data-icon-slot]', el), { schools, call, onChange: () => ctx.reload() });
  $('[data-logout]', el).addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await call('logout').catch(() => {});
      state.platformSession = null;
      ctx.reload();
    }),
  );
  bindSecurity(el, call, ctx);

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

const EVENTS = {
  password: ['Contraseña', 'Contraseña incorrecta'],
  code: ['Entró con el código', 'Código incorrecto'],
  setup: ['Configuró la app de autenticación', 'Falló la configuración'],
  logout: ['Salió', 'Salió'],
  logout_others: ['Cerró las otras sesiones', ''],
  change_password: ['Cambió la contraseña de plataforma', ''],
  recovery_codes: ['Generó un código de recuperación nuevo', ''],
  email_code: ['Pidió un código por correo', ''],
  set_email: ['Cambió el correo de la plataforma', ''],
  reset_authenticator: ['Quitó la app de autenticación (nuevo teléfono)', ''],
};

/** «Chrome · Windows»: enough to recognize a device. */
function device(ua) {
  const s = ua || '';
  const browser = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : 'Navegador';
  const os = /iPhone|iPad/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

function securityCard(sec) {
  const failed = sec.events.filter((e) => !e.ok);
  return html`<section class="card stack" data-security>
    <h2 class="card-title">${icon('shield')} Seguridad del panel</h2>
    <p class="hint">Para entrar se piden la contraseña de plataforma y el código de tu app de autenticación, cada vez. La sesión
      termina a los 20 minutos sin uso. Solo se entra por <strong>admin.hallwayedu.com</strong>.</p>
    ${failed.length
      ? html`<p class="status-note warn">${icon('alert', 16)} ${failed.length} intento(s) fallido(s) en la actividad reciente. Si no fuiste
          tú, cambia la contraseña de plataforma.</p>`
      : ''}
    <div class="stack">
      <strong>Sesiones abiertas (${sec.sessions.length})</strong>
      ${sec.sessions.map(
        (x) => html`<p class="muted small">${x.current ? '● Esta sesión' : '○ Otra sesión'} · ${device(x.user_agent)} · IP ${x.ip}
          · desde ${fmtDateTime(x.created_at)}</p>`,
      )}
    </div>
    <p class="muted small">${sec.has_recovery
      ? 'Tienes un código de recuperación guardado (sirve una vez si pierdes el teléfono).'
      : 'No tienes código de recuperación: genera uno.'}</p>
    <p class="muted small">Códigos por correo: ${sec.email
      ? html`llegan a <strong>${sec.email}</strong>`
      : 'sin correo (solo la app).'}${sec.email_ready ? '' : ' El envío de correos aún no está configurado en Supabase (RESEND_API_KEY).'}</p>
    <div class="button-row wrap">
      ${sec.sessions.length > 1 ? html`<button type="button" class="btn btn-secondary btn-sm" data-sec-others>${icon('logout', 16)} Cerrar las otras sesiones</button>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-sec-password>${icon('key', 16)} Cambiar contraseña</button>
      <button type="button" class="btn btn-secondary btn-sm" data-sec-codes>${icon('list', 16)} Nuevo código de recuperación</button>
      <button type="button" class="btn btn-secondary btn-sm" data-sec-email>${icon('mail', 16)} Correo para códigos</button>
      <button type="button" class="btn btn-ghost btn-sm" data-sec-reset>${icon('shield', 16)} Cambié de teléfono</button>
    </div>
    <details>
      <summary>Actividad reciente</summary>
      <div class="stack">${sec.events.map(
        (e) => html`<p class="small ${e.ok ? 'muted' : 'danger-text'}">${fmtDateTime(e.at)} · ${(EVENTS[e.action] || [e.action, e.action])[e.ok ? 0 : 1] || e.action}${e.detail ? ` (${e.detail})` : ''}
          · ${device(e.user_agent)} · IP ${e.ip}</p>`,
      )}</div>
    </details>
  </section>`;
}

const codeInput = (label = 'Código de 6 números de la app') => html`<label class="field"><span>${label}</span>
  <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>`;

function bindSecurity(el, call, ctx) {
  $('[data-sec-others]', el)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await call('logout_others');
      toast('Las otras sesiones se cerraron', 'ok');
      ctx.reload();
    }),
  );
  $('[data-sec-password]', el).addEventListener('click', () =>
    dialog({
      title: 'Cambiar contraseña de plataforma',
      message: 'Usa una contraseña larga (12 o más caracteres) que no uses en otro lado. Las otras sesiones se cierran.',
      body: html`<div class="stack">
        <label class="field"><span>Contraseña actual</span><input name="current_password" type="password" required autocomplete="current-password"></label>
        <label class="field"><span>Nueva contraseña</span><input name="new_password" type="password" required minlength="12" autocomplete="new-password"></label>
        ${codeInput()}
      </div>`,
      confirmText: 'Cambiar',
      onSubmit: async (v) => {
        await call('change_password', v);
        toast('Contraseña de plataforma cambiada', 'ok');
      },
    }),
  );
  $('[data-sec-codes]', el).addEventListener('click', () =>
    dialog({
      title: 'Nuevo código de recuperación',
      message: 'El código de antes deja de servir.',
      body: codeInput(),
      confirmText: 'Generar',
      onSubmit: async (v) => {
        const { recovery_code: code } = await call('new_recovery_code', v);
        setTimeout(() => showRecoveryCode(code).then(() => ctx.reload()), 0);
      },
    }),
  );
  $('[data-sec-email]', el).addEventListener('click', () =>
    dialog({
      title: 'Correo para los códigos',
      message: 'Al entrar podrás pedir que el código te llegue a este correo en lugar de abrir la app. Te enviamos un correo de prueba. Déjalo vacío para quitarlo.',
      body: html`<div class="stack">
        <label class="field"><span>Correo</span><input name="email" type="email" autocapitalize="none" placeholder="tu@correo.com"></label>
        ${codeInput()}
      </div>`,
      confirmText: 'Guardar',
      onSubmit: async (v) => {
        await call('set_email', v);
        toast(v.email ? 'Correo guardado. Te llegó un correo de prueba.' : 'Correo quitado', 'ok');
        ctx.reload();
      },
    }),
  );
  $('[data-sec-reset]', el).addEventListener('click', () =>
    dialog({
      title: '¿Cambiaste de teléfono?',
      message: 'Con tu contraseña y un código de la app que tienes ahora, se quita la app configurada. La próxima vez que entres verás un QR nuevo para el teléfono nuevo. Todas las sesiones se cierran.',
      body: html`<div class="stack">
        <label class="field"><span>Contraseña de plataforma</span><input name="password" type="password" required autocomplete="current-password"></label>
        ${codeInput('Código de la app actual')}
      </div>`,
      confirmText: 'Quitar y salir',
      danger: true,
      onSubmit: async (v) => {
        await call('reset_authenticator', v);
        state.platformSession = null;
        toast('Listo. Entra otra vez para configurar el teléfono nuevo.', 'ok');
        ctx.reload();
      },
    }),
  );
}

/** Shown once: the code to get in without the phone (it works once; then a new one is shown). */
function showRecoveryCode(code) {
  const text = `Hallway · Panel de plataforma\nCódigo de recuperación (sirve una vez): ${code}`;
  const pending = dialog({
    title: 'Guarda tu código de recuperación',
    message: 'Si pierdes el teléfono, este código te deja entrar una vez en lugar del código de la app; al usarlo te damos uno nuevo. Guárdalo fuera del teléfono (impreso o en tu gestor de contraseñas). No se vuelve a mostrar.',
    body: html`<div class="recovery-codes mono"><span>${code}</span></div>
      <button type="button" class="btn btn-secondary btn-sm" data-copy-codes>${icon('copy', 16)} Copiar</button>`,
    confirmText: 'Ya lo guardé',
    cancelText: '',
  });
  document.querySelector('dialog.dialog:last-of-type [data-copy-codes]').addEventListener('click', () => copyText(text));
  return pending;
}

/** Password, then the code (or, the first time, the QR and the first code). */
function platformLogin({ el, reload }) {
  const head = (title, text) => html`<div class="auth-brand">
      <img src="icons/icon-192.png" alt="" class="auth-logo" width="64" height="64">
      <h1>${title}</h1>
      <p>${text}</p>
    </div>`;

  const passwordStep = () => {
    el.innerHTML = String(html`
      <div class="auth">
        ${head('Panel de plataforma', 'Crea y administra las escuelas que usan Hallway.')}
        <form class="card stack" data-form>
          <label class="field"><span>Contraseña de plataforma</span>
            <span class="pw"><input name="password" type="password" required autocomplete="current-password" autofocus><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Continuar</button>
        </form>
      </div>`);
    bindPasswordToggles(el);
    const form = $('[data-form]', el);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('[type=submit]'), async () => {
        const res = await platformSignIn('start', { password: formValues(form).password });
        if (res.next === 'setup') await setupStep(res);
        else codeStep(res.pending, res.email);
      });
    });
  };

  const enter = async (session) => {
    state.platformSession = session;
    reload();
  };

  // After the recovery code: the new one, then in.
  const entered = async (res) => {
    if (res.recovery_code) await showRecoveryCode(res.recovery_code);
    enter(res.session);
  };

  const codeStep = (pending, email) => {
    el.innerHTML = String(html`
      <div class="otp-screen">
        <div class="otp-card">
          <div class="otp-head">
            <span class="otp-lock">${icon('shield', 26)}</span>
            <h1>Verificación en dos pasos</h1>
            <p>Escribe el código de 6 números que sale para «Hallway · Plataforma» en tu app de autenticación.</p>
          </div>
          ${otpField()}
          ${email ? html`<button type="button" class="btn btn-ghost btn-block" data-email>Enviarme un código a ${email}</button>` : ''}
          <button type="button" class="btn btn-ghost btn-block" data-recovery>Usar el código de recuperación</button>
          <button type="button" class="btn btn-ghost btn-block" data-back>Cancelar</button>
        </div>
      </div>`);
    bindOtp($('[data-otp]', el), async (code, otp) => {
      try {
        const res = await platformSignIn('verify', { pending, code });
        await otp.succeed();
        entered(res);
      } catch (err) {
        if (err.status === 401 && /mucho tiempo/.test(err.message)) return passwordStep();
        otp.fail(err.message);
      }
    });
    $('[data-back]', el).addEventListener('click', passwordStep);
    $('[data-email]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const { sent } = await platformSignIn('email_code', { pending });
        toast(`Te enviamos un código a ${sent}. Escríbelo arriba; vale 10 minutos.`, 'ok');
      }),
    );
    $('[data-recovery]', el).addEventListener('click', async () => {
      const code = await dialog({
        title: 'Código de recuperación',
        message: 'El que guardaste al configurar el panel (por ejemplo, K7QM-2XWP-HD4R-9BNA). Sirve una vez; después te damos uno nuevo.',
        input: { label: 'Código', placeholder: 'XXXX-XXXX-XXXX-XXXX' },
        confirmText: 'Entrar',
      });
      if (!code) return;
      try {
        entered(await platformSignIn('verify', { pending, code }));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };

  const setupStep = async ({ pending, secret, uri }) => {
    const { default: qrcode } = await import('../../vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    el.innerHTML = String(html`
      <div class="otp-screen">
        <div class="otp-card">
          <div class="otp-head">
            <span class="otp-lock">${icon('shield', 26)}</span>
            <h1>Protege el panel</h1>
            <p>Desde ahora, entrar al panel pedirá también el código de una app de autenticación, cada vez.</p>
          </div>
          <ol class="steps-list">
            <li>Abre <strong>Microsoft Authenticator</strong> o <strong>Google Authenticator</strong> en tu teléfono.</li>
            <li>Toca <strong>+</strong> y escanea este código.</li>
            <li>Escribe aquí el código de 6 números que sale para «Hallway · Plataforma».</li>
          </ol>
          <div class="mfa-qr">${raw(qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'Código QR para la app de autenticación' }))}</div>
          <p class="hint center">¿No puedes escanear? Escribe esta clave en la app: <span class="mono">${secret.match(/.{1,4}/g).join(' ')}</span></p>
          ${otpField()}
          <button type="button" class="btn btn-ghost btn-block" data-back>Cancelar</button>
        </div>
      </div>`);
    bindOtp($('[data-otp]', el), async (code, otp) => {
      try {
        const res = await platformSignIn('setup', { pending, code });
        await otp.succeed();
        await entered(res);
      } catch (err) {
        if (err.status === 401 && /mucho tiempo/.test(err.message)) return passwordStep();
        otp.fail(err.message);
      }
    });
    $('[data-back]', el).addEventListener('click', passwordStep);
  };

  passwordStep();
}
