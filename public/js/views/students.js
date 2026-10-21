// Shared by Alertas and Turnos: the student's name and group (only noted students are kept, for 24 hours),
// and screens that keep themselves up to date.
import { similarStudents } from '../backend.js';
import { dialog, html, poll, schoolCalendar } from '../lib.js';
import { state } from '../store.js';

const REFRESH_MS = 15000;

/**
 * Refreshes while the screen is open: every few seconds (waiting longer after each failure, up to 2 minutes) and
 * whenever a notice arrives.
 */
export function keepFresh({ onLeave, isCurrent }, load) {
  const tick = () => {
    if (isCurrent() && document.visibilityState === 'visible') load().catch(() => {});
  };
  const stop = poll(() => (isCurrent() && document.visibilityState === 'visible' ? load() : true), REFRESH_MS);
  window.addEventListener('lah:push', tick);
  document.addEventListener('visibilitychange', tick);
  onLeave(() => {
    stop();
    window.removeEventListener('lah:push', tick);
    document.removeEventListener('visibilitychange', tick);
  });
}

/**
 * The student's name and group. The groups the dirección gave the teacher come first, one tap away (already chosen
 * when it's just one): the notices of a turn also reach the other teachers of that group. "Otro grupo" has the rest.
 */
export function studentFields() {
  const { groups } = schoolCalendar(state.me.school);
  const mine = (state.me.user.groups || []).filter((g) => groups.includes(g));
  const others = groups.filter((g) => !mine.includes(g));
  const name = html`<label class="field"><span>Nombre del estudiante</span>
      <input name="student" required maxlength="100" autocomplete="off" autocapitalize="words" placeholder="Nombre y apellidos"></label>`;
  if (!mine.length) {
    return html`${name}
      <label class="field"><span>Grado y grupo</span>
        ${groups.length
          ? html`<select name="group" required>
              <option value="" selected disabled>Elige…</option>
              ${groups.map((g) => html`<option value="${g}">${g}</option>`)}
            </select>`
          : html`<input name="group" required maxlength="20" autocomplete="off" placeholder="Ej. 9-B">`}
      </label>`;
  }
  return html`${name}
    <div class="field"><span>Grado y grupo</span>
      <div class="chips" role="radiogroup" aria-label="Grado y grupo">
        ${mine.map(
          (g) => html`<label class="chip"><input type="radio" name="group" value="${g}" ${mine.length === 1 ? 'checked' : ''}><span>${g}</span></label>`,
        )}
        ${others.length ? html`<label class="chip"><input type="radio" name="group" value="" data-other-group><span>Otro grupo</span></label>` : ''}
      </div>
      ${others.length
        ? html`<select name="group_other" class="group-other" aria-label="Otro grupo">
            <option value="" selected disabled>Elige el grupo…</option>
            ${others.map((g) => html`<option value="${g}">${g}</option>`)}
          </select>`
        : ''}
    </div>`;
}

/**
 * The student, checking first whether someone already noted a student with a similar name in that group
 * today ("¿Es José Pérez Rivera (9-B)?"). Resolves { id } for one already noted, { name, group } for a new
 * one, or null if the person cancelled.
 */
export async function confirmStudent(name, group) {
  const matches = await similarStudents(name, group);
  const exact = matches.find((m) => m.exact);
  if (exact) return { id: exact.id };
  if (!matches.length) return { name, group };
  const v = await dialog({
    title: '¿Es el mismo estudiante?',
    message: `Hoy ya se apuntó en ${group} a alguien con un nombre parecido.`,
    body: html`<div class="choices" data-same>
      ${matches.map(
        (m, i) => html`<label class="choice"><input type="radio" name="same" value="${m.id}" ${i === 0 ? 'checked' : ''}>
          <span><strong>Sí, es ${m.name} <span class="nowrap">(${m.group_name})</span></strong><small>Se sigue con el mismo estudiante.</small></span></label>`,
      )}
      <label class="choice"><input type="radio" name="same" value="new">
        <span><strong>No, es otro estudiante</strong><small>Se apunta a ${name} (${group}).</small></span></label>
    </div>`,
    confirmText: 'Continuar',
    collect: true,
  });
  if (!v) return null;
  return v.same === 'new' ? { name, group } : { id: Number(v.same) };
}

/** Reads and checks the name and group of a form; the form's own validation shows what's missing. */
export function studentFrom(form) {
  const name = form.student.value.trim().replace(/\s+/g, ' ');
  // The teacher's groups are chips (radios); otherwise a list or a text field.
  const chip = form.querySelector('[name=group]:checked');
  const field = form.querySelector('select[name=group], input[name=group]:not([type=radio])');
  const group = (chip ? (chip.hasAttribute('data-other-group') ? form.group_other.value : chip.value) : field?.value || '').trim();
  if (name.length < 2) throw new Error('Escribe el nombre del estudiante.');
  if (!group) throw new Error('Elige el grado y grupo del estudiante.');
  return { name, group };
}

/** A label and its value in a detail card (nothing when there's no value). */
export const fact = (label, value) => (value ? html`<div class="fact"><span>${label}</span><strong>${value}</strong></div>` : '');
