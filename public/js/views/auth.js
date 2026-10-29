import { changePassword, requestPasswordHelp, schoolBranding, signIn } from '../backend.js';
import { appIcon, applyBranding } from '../branding.js';
import { $, busy, dialog, formValues, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { syncPush } from '../pwa.js';
import { go, homePath, logout, state } from '../store.js';
import { installHint } from './common.js';

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

/** Keeps this device's remembered school in sync (e.g. after the school changes its code). */
export function rememberSchool(school) {
  if (!school?.code) return;
  remember('lah:school', school.code);
  remember('lah:school-name', school.name || '');
}

function passwordField(name, label, autocomplete) {
  return html`
    <label class="field"><span>${label}</span>
      <span class="pw">
        <input name="${name}" type="password" required autocomplete="${autocomplete}" minlength="${name === 'password' || name === 'current_password' ? 1 : 8}">
        <button type="button" class="pw-toggle" data-pw>Ver</button>
      </span>
    </label>`;
}

export function bindPasswordToggles(root) {
  for (const btn of root.querySelectorAll('[data-pw]')) {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Ocultar' : 'Ver';
    });
  }
}

/**
 * Links shared with staff carry the school code (?escuela=CODE) so nobody has to type it.
 * Called once at startup; the code is remembered on this device.
 */
export function adoptSchoolFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('escuela') || '').trim().toUpperCase();
  if (!code) return;
  if (code !== recall('lah:school')) {
    remember('lah:school', code);
    remember('lah:school-name', '');
  }
  params.delete('escuela');
  const search = params.toString();
  history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}

async function forgotPassword(defaults) {
  const values = await dialog({
    title: '¿Olvidaste tu contraseña?',
    message: 'Le avisaremos a la dirección para que te den una contraseña temporal.',
    body: html`
      <label class="field"><span>Código de escuela</span>
        <input name="school_code" autocapitalize="characters" spellcheck="false" value="${defaults.school_code || ''}"></label>
      <label class="field"><span>Tu usuario o correo</span>
        <input name="username" autocapitalize="none" spellcheck="false" value="${defaults.username || ''}"></label>`,
    confirmText: 'Avisar a la dirección',
    collect: true,
  });
  if (!values) return;
  if (!values.school_code?.trim() || !values.username?.trim()) {
    toast('Escribe tu código de escuela y tu usuario.', 'error');
    return;
  }
  try {
    await requestPasswordHelp(values.school_code, values.username);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  await dialog({
    title: 'Solicitud enviada',
    message:
      'Si tus datos son correctos, la dirección ya recibió el aviso y te dará una contraseña temporal. ' +
      'Al entrar con ella, la app te pedirá crear una nueva.',
    confirmText: 'Entendido',
    cancelText: '',
  });
}

export async function loginView({ el, query }) {
  let mode = query.get('mode') === 'admin' ? 'admin' : 'staff';
  let editingCode = false;
  let draft = {};

  // The school's own icon, when this device already knows the school.
  const known = recall('lah:school');
  if (known) {
    schoolBranding(known).then((b) => {
      if (b) applyBranding(b);
    });
  }

  const render = () => {
    const savedCode = recall('lah:school');
    const savedName = recall('lah:school-name');
    const showCodeInput = editingCode || !savedCode;
    el.innerHTML = String(html`
      <div class="auth">
        <div class="auth-brand">
          <img src="${appIcon()}" alt="" class="auth-logo" width="72" height="72" data-app-icon>
          <h1>Hallway</h1>
          <p>Reporta tus ausencias en segundos y mantén informada a la dirección.</p>
        </div>
        <div class="card auth-card">
          <div class="segmented" role="tablist">
            <button type="button" role="tab" class="seg ${mode === 'staff' ? 'active' : ''}" data-mode="staff"
              aria-selected="${mode === 'staff'}">${icon('user', 18)} Personal</button>
            <button type="button" role="tab" class="seg ${mode === 'admin' ? 'active' : ''}" data-mode="admin"
              aria-selected="${mode === 'admin'}">${icon('shield', 18)} Admin</button>
          </div>
          <form class="stack" data-login novalidate>
            ${showCodeInput
              ? html`<label class="field"><span>Código de escuela</span>
                  <input name="school_code" required autocapitalize="characters" autocomplete="organization"
                    spellcheck="false" placeholder="Ej. ESC-2045" value="${draft.school_code ?? savedCode}">
                </label>`
              : html`<div class="school-chip">
                  ${icon('school', 20)}
                  <span class="grow"><small>Escuela</small><strong>${savedName || savedCode}</strong></span>
                  <button type="button" class="btn btn-ghost btn-sm" data-change-school>Cambiar</button>
                  <input type="hidden" name="school_code" value="${savedCode}">
                </div>`}
            ${mode === 'staff'
              ? html`<label class="field"><span>Usuario o correo</span>
                  <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"
                    value="${draft.username ?? recall('lah:username')}">
                </label>`
              : ''}
            ${passwordField('password', mode === 'admin' ? 'Contraseña de Admin' : 'Contraseña', 'current-password')}
            <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar</button>
          </form>
          ${mode === 'admin'
            ? html`<p class="hint center">Acceso completo de la dirección: personal, ausencias, configuración y datos de la escuela.</p>`
            : html`<button type="button" class="btn btn-ghost btn-block" data-forgot>${icon('key', 18)} ¿Olvidaste tu contraseña?</button>`}
        </div>
        <div data-install-slot></div>
      </div>`);

    const form = $('[data-login]', el);
    const keepDraft = () => {
      const v = formValues(form);
      draft = { school_code: v.school_code, username: v.username };
    };
    for (const btn of el.querySelectorAll('[data-mode]')) {
      btn.addEventListener('click', () => {
        keepDraft();
        mode = btn.dataset.mode;
        render();
      });
    }
    $('[data-change-school]', el)?.addEventListener('click', () => {
      keepDraft();
      editingCode = true;
      render();
      el.querySelector('[name=school_code]').select();
    });
    $('[data-forgot]', el)?.addEventListener('click', () => {
      const v = formValues(form);
      forgotPassword({ school_code: v.school_code, username: v.username });
    });
    bindPasswordToggles(el);
    installHint($('[data-install-slot]', el), { dismissible: false });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const submit = form.querySelector('[type=submit]');
      busy(submit, async () => {
        const v = formValues(form);
        if (!v.school_code || !v.password || (mode === 'staff' && !v.username)) {
          throw new Error('Completa todos los campos.');
        }
        // The school administration account is the user "admin" of that school.
        const me = await signIn(v.school_code, mode === 'admin' ? 'admin' : v.username, v.password);
        if (me.school.code !== v.school_code.trim().toUpperCase()) {
          toast(`El código de tu escuela ahora es ${me.school.code}.`, 'ok');
        }
        rememberSchool(me.school);
        applyBranding(me.school);
        if (mode === 'staff') remember('lah:username', v.username.trim());
        state.me = me;
        state.platformSession = null;
        syncPush();
        if (me.user.must_change_password) return go('/change-password', { replace: true });
        const next = state.nextPath;
        state.nextPath = null;
        go(next || homePath(), { replace: true });
      });
    });
  };
  render();
}

export async function changePasswordView({ el }) {
  const forced = state.me.user.must_change_password;
  el.innerHTML = String(html`
    <div class="auth">
      <div class="auth-brand">
        <img src="${appIcon()}" alt="" class="auth-logo" width="64" height="64" data-app-icon>
        <h1>${forced ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1>
        <p>${forced
          ? `Hola, ${state.me.user.full_name}. Por seguridad, cambia la contraseña temporal que te dieron.`
          : 'Elige una contraseña nueva.'}</p>
      </div>
      <form class="card stack" data-form>
        ${passwordField('current_password', forced ? 'Contraseña temporal' : 'Contraseña actual', 'current-password')}
        ${passwordField('new_password', 'Nueva contraseña (mín. 8 caracteres)', 'new-password')}
        ${passwordField('confirm', 'Repite la nueva contraseña', 'new-password')}
        <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('key', 18)} Guardar contraseña</button>
        <button class="btn btn-ghost btn-block" type="button" data-leave>${forced ? 'Salir' : 'Volver'}</button>
      </form>
    </div>`);
  bindPasswordToggles(el);
  $('[data-leave]', el).addEventListener('click', () => (forced ? logout() : go(homePath())));
  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      if (v.new_password.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres.');
      if (v.new_password !== v.confirm) throw new Error('Las contraseñas no coinciden.');
      await changePassword(v.current_password, v.new_password);
      state.me.user.must_change_password = false;
      toast('Contraseña actualizada', 'ok');
      const next = state.nextPath;
      state.nextPath = null;
      go(next || homePath(), { replace: true });
    });
  });
}
