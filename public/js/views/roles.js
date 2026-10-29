// Roles y permisos: an Admin adds, renames and deletes the school's roles (Maestro(a),
// Enfermería, Seguridad…), chooses what each one can do and whether its absences need someone to cover them.
import { deleteRole, getMe, listEmployees, saveRole } from '../backend.js';
import { $, PERMISSIONS, busy, dialog, formValues, getSchoolRoles, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';

const BASE = 'Reportar sus propias ausencias';

/** "Ver y confirmar… · Enviar mensajes", only the base permission, or nothing. */
export function permissionSummary(role) {
  const own = role.own_absences !== false;
  const names = PERMISSIONS.filter((p) => role.permissions.includes(p.key)).map((p) => p.label);
  if (!names.length) return own ? `Solo ${BASE.toLowerCase()}` : 'Sin permisos';
  return own ? names.join(' · ') : `${names.join(' · ')} · No reporta sus ausencias`;
}

/** Reloads me() so the role names and permissions are current everywhere. */
async function refreshRoles() {
  const me = await getMe();
  if (me) state.me = me;
}

/** Create (no role) or edit a role. Resolves with the saved role, or null if cancelled. */
export async function roleDialog(role = null) {
  const perms = new Set(role?.permissions || []);
  const coverage = role ? role.coverage : true;
  const ownAbsences = role ? role.own_absences !== false : true;
  let saved = null;
  await dialog({
    title: role ? `Editar «${role.name}»` : 'Nuevo rol',
    body: html`<div class="stack" data-role-form>
      <label class="field"><span>Nombre del rol</span>
        <input name="role_name" maxlength="40" required value="${role?.name || ''}" placeholder="Ej. Enfermería" autocomplete="off"></label>
      <div class="field"><span>Qué puede hacer</span>
        <div class="perm-list">
          <label class="choice"><input type="checkbox" name="own_absences" ${ownAbsences ? 'checked' : ''}>
            <span><strong>${BASE}</strong><small>Avisar desde la app que va a faltar y ver sus ausencias. Quítalo para roles
              que no reportan las suyas aquí.</small></span></label>
          ${PERMISSIONS.map(
            (p) => html`<label class="choice"><input type="checkbox" name="perm" value="${p.key}" ${perms.has(p.key) ? 'checked' : ''}>
              <span><strong>${p.label}</strong><small>${p.hint}</small></span></label>`,
          )}
        </div>
        <p class="hint" data-absences-note hidden></p>
      </div>
      <label class="toggle"><input type="checkbox" name="coverage" ${coverage ? 'checked' : ''}>
        <span class="toggle-ui"></span><span>Sus ausencias necesitan cobertura (sustituto)</span></label>
      <p class="hint">Si está activo, al reportar se pide «Para cubrir» y la ausencia muestra «Cobertura».
        Desactívalo para roles como enfermería, mantenimiento o seguridad.</p>
      <p class="status-note danger" data-role-error hidden></p>
    </div>`,
    confirmText: role ? 'Guardar' : 'Crear rol',
    onOpen(dlg) {
      const form = dlg.querySelector('form');
      const box = (key) => form.querySelector(`[name=perm][value=${key}]`);
      // Managing the staff, the reports, registering absences and the day's summary need to see everyone's absences:
      // turning one on turns that on too, and turning that off turns them off.
      const NEED_ABSENCES = ['staff', 'reports', 'register', 'summary'];
      const note = $('[data-absences-note]', form);
      form.addEventListener('change', (e) => {
        const key = e.target.matches('[name=perm]') ? e.target.value : null;
        if (!key) return;
        if (NEED_ABSENCES.includes(key) && e.target.checked) box('absences').checked = true;
        const dropped = key === 'absences' && !e.target.checked
          ? NEED_ABSENCES.filter((k) => box(k).checked)
          : [];
        for (const k of dropped) box(k).checked = false;
        note.textContent = dropped.length
          ? `También se quitó: ${dropped.map((k) => PERMISSIONS.find((p) => p.key === k).label).join(', ')} (necesitan ver las ausencias de todos).`
          : '';
        note.hidden = !dropped.length;
      });
      form.querySelector('[name=role_name]').focus();
      // Save before closing, so errors (e.g. a repeated name) show in the dialog.
      form.addEventListener(
        'submit',
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const v = formValues(form);
          const error = $('[data-role-error]', form);
          busy(form.querySelector('[type=submit]'), async () => {
            try {
              const res = await saveRole({
                key: role?.key,
                name: String(v.role_name || '').trim(),
                permissions: [...form.querySelectorAll('[name=perm]:checked')].map((c) => c.value),
                coverage: form.querySelector('[name=coverage]').checked,
                own_absences: form.querySelector('[name=own_absences]').checked,
              });
              saved = res.role;
              await refreshRoles();
              // Closes the dialog (its cancel handler resolves it).
              dlg.dispatchEvent(new Event('cancel'));
            } catch (err) {
              error.textContent = err.message;
              error.hidden = false;
            }
          });
        },
        { capture: true },
      );
    },
  });
  return saved;
}

export async function rolesView({ el }) {
  const render = async () => {
    const employees = await listEmployees();
    // With it as their main role or as one of their other roles.
    const count = (key) => employees.filter((e) => e.role === key || e.extra_roles?.includes(key)).length;
    const roles = getSchoolRoles();
    el.innerHTML = String(html`
      <div class="stack">
        <div class="toolbar">
          <p class="muted grow">Elige qué puede hacer cada rol, también si reporta sus propias ausencias.</p>
          <button class="btn btn-primary" data-new>${icon('plus', 18)} Nuevo rol</button>
        </div>
        <div class="list">
          <div class="item role-item">
            <span class="item-icon">${icon('shield')}</span>
            <span class="item-main">
              <strong>Admin</strong>
              <span class="item-sub">Puede hacer todo en la escuela: personal, roles, configuración y todos los módulos</span>
              <span class="item-tags"><span class="tag">${icon('users', 14)} La cuenta admin + ${count('admin')} persona(s)</span></span>
            </span>
          </div>
          ${roles.map((r) => {
          const n = count(r.key);
          return html`<div class="item role-item">
            <span class="item-icon">${icon(r.permissions.length ? 'shield' : 'user')}</span>
            <span class="item-main">
              <strong>${r.name}</strong>
              <span class="item-sub">${permissionSummary(r)}</span>
              <span class="item-tags">
                <span class="tag">${icon('users', 14)} ${n} persona(s)</span>
                ${r.coverage ? html`<span class="tag">Necesita cobertura</span>` : html`<span class="tag">Sin cobertura</span>`}
              </span>
            </span>
            <span class="role-actions">
              <button class="icon-btn" data-edit="${r.key}" aria-label="Editar ${r.name}">${icon('edit', 18)}</button>
              <button class="icon-btn" data-delete="${r.key}" aria-label="Borrar ${r.name}">${icon('trash', 18)}</button>
            </span>
          </div>`;
        })}
        </div>
        <p class="hint"><b>Admin</b> puede hacer todo en la escuela y no se edita aquí: es el rol de la cuenta admin de la escuela,
          y se le puede dar a cualquier persona además del suyo desde su ficha en Personal (<b>Otros roles</b>). Para borrar un rol, primero cambia
          de rol a las personas que lo tienen (también las desactivadas). Nadie puede dar un rol con más permisos que el suyo.</p>
      </div>`);

    $('[data-new]', el).addEventListener('click', async () => {
      const role = await roleDialog();
      if (role) {
        toast(`Rol «${role.name}» creado`, 'ok');
        await render();
      }
    });
    for (const btn of el.querySelectorAll('[data-edit]')) {
      btn.addEventListener('click', async () => {
        const role = await roleDialog(roles.find((r) => r.key === btn.dataset.edit));
        if (role) {
          toast('Rol guardado', 'ok');
          await render();
        }
      });
    }
    for (const btn of el.querySelectorAll('[data-delete]')) {
      btn.addEventListener('click', async () => {
        const role = roles.find((r) => r.key === btn.dataset.delete);
        const n = count(role.key);
        if (n) {
          toast(`Hay ${n} persona(s) con el rol «${role.name}». Cámbiales el rol antes de borrarlo.`, 'error');
          return;
        }
        const ok = await dialog({ title: `¿Borrar el rol «${role.name}»?`, confirmText: 'Borrar', danger: true });
        if (!ok) return;
        await busy(btn, async () => {
          await deleteRole(role.key);
          await refreshRoles();
          toast('Rol borrado', 'ok');
          await render();
        });
      });
    }
  };
  await render();
}
