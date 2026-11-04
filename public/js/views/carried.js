// Turns kept open from earlier days (services set to keep them, like Soporte IT): once a day, whoever attends the
// service is shown them with their details and decides, one by one or all at once, whether each goes on or is closed.
// Whoever asked for them (a teacher) is asked too, whether they were attended: they keep or delete each one.
// Whatever they decide goes to the history.
import { myCarriedTurns, myRequestedCarriedTurns, reviewCarriedTurns, reviewRequestedTurns } from '../backend.js';
import { dialog, fmtDateTime, html, toast } from '../lib.js';
import { icon } from '../icons.js';

const SEVERITY = { 1: 'Baja', 2: 'Media', 3: 'Alta', 4: 'Urgente' };
const STATUS = {
  waiting: 'En fila',
  called: 'Llamado',
  sent: 'Salió del salón',
  arrived: 'En la oficina',
  on_the_way: 'Alguien va en camino',
  returning: 'Regresando al salón',
};

let asked = null;

function turnRow(t, labels = { keep: 'Seguir', close: 'Cerrar' }) {
  const what = t.service_mode === 'support'
    ? [t.reason || 'Pedido de ayuda', t.room ? (/^\d/.test(t.room) ? `salón ${t.room}` : t.room) : null].filter(Boolean).join(' · ')
    : `${t.student_name} (${t.group_name})${t.reason ? ` · ${t.reason}` : ''}`;
  return html`<div class="carried-turn" data-carried="${t.id}">
    <div class="carried-main">
      <strong>${t.service_name}: ${what}</strong>
      <small>${[`Pidió ${t.created_by_name}`, fmtDateTime(t.created_at), SEVERITY[t.severity], STATUS[t.status],
        t.handled_by_name ? `lo tiene ${t.handled_by_name}` : null].filter(Boolean).join(' · ')}</small>
      ${t.note ? html`<small class="carried-note">${t.note}</small>` : ''}
    </div>
    <div class="segmented carried-choice" role="group" aria-label="¿Qué hacer con este turno?">
      <label class="seg"><input type="radio" name="t${t.id}" value="keep" checked><span>${labels.keep}</span></label>
      <label class="seg"><input type="radio" name="t${t.id}" value="close"><span>${labels.close}</span></label>
    </div>
  </div>`;
}

/** Once per opening of the app: ask about the turns from earlier days, if there are any. */
export async function checkCarriedTurns(user) {
  if (!user || asked === user.id) return;
  asked = user.id;
  if (user.serves?.length) await askService();
  await askRequester();
}

/** Whoever attends the service: go on with each turn, or close it. */
async function askService() {
  let turns;
  try {
    turns = await myCarriedTurns();
  } catch {
    return;
  }
  if (!turns.length) return;
  await dialog({
    title: turns.length === 1 ? 'Tienes 1 turno de días anteriores' : `Tienes ${turns.length} turnos de días anteriores`,
    message: 'Siguen abiertos desde antes de hoy. Indica si continúas con cada uno o si lo cierras (por ejemplo, si ya lo atendiste y no lo cerraste). Queda registrado en el historial.',
    body: html`<div class="quick carried-all">
        <button type="button" class="chip-btn" data-all="keep">${icon('check', 16)} Seguir con todos</button>
        <button type="button" class="chip-btn" data-all="close">${icon('x', 16)} Cerrar todos</button>
      </div>
      <div class="carried-list">${turns.map((t) => turnRow(t))}</div>`,
    confirmText: 'Guardar',
    cancelText: 'Decidir después',
    onOpen: bindAll,
    async onSubmit(values) {
      const { keep, close } = split(turns, values);
      await reviewCarriedTurns(keep, close);
      toast(close.length
        ? `Listo: ${close.length === 1 ? 'se cerró 1 turno' : `se cerraron ${close.length} turnos`}${keep.length ? ` y sigues con ${keep.length}` : ''}.`
        : 'Listo: sigues con esos turnos.', 'ok');
      window.dispatchEvent(new Event('hashchange'));
    },
  });
}

/** Whoever asked for the turns: were they attended? Keep each one, or delete it. */
async function askRequester() {
  let turns;
  try {
    turns = await myRequestedCarriedTurns();
  } catch {
    return;
  }
  if (!turns.length) return;
  await dialog({
    title: turns.length === 1 ? '¿Te atendieron este turno?' : `¿Te atendieron estos ${turns.length} turnos?`,
    message: 'Los pediste antes de hoy y siguen abiertos. Si ya te atendieron o ya no hace falta, bórralo; si todavía lo necesitas, mantenlo. Le avisamos al servicio y queda registrado en el historial.',
    body: html`<div class="quick carried-all">
        <button type="button" class="chip-btn" data-all="keep">${icon('check', 16)} Mantener todos</button>
        <button type="button" class="chip-btn" data-all="close">${icon('x', 16)} Borrar todos</button>
      </div>
      <div class="carried-list">${turns.map((t) => turnRow(t, { keep: 'Mantener', close: 'Borrar' }))}</div>`,
    confirmText: 'Guardar',
    cancelText: 'Decidir después',
    onOpen: bindAll,
    async onSubmit(values) {
      const { keep, close } = split(turns, values);
      await reviewRequestedTurns(keep, close);
      toast(close.length
        ? `Listo: ${close.length === 1 ? 'se borró 1 turno' : `se borraron ${close.length} turnos`}${keep.length ? ` y mantienes ${keep.length}` : ''}.`
        : 'Listo: mantienes esos turnos.', 'ok');
      window.dispatchEvent(new Event('hashchange'));
    },
  });
}

function bindAll(dlg) {
  for (const b of dlg.querySelectorAll('[data-all]')) {
    b.addEventListener('click', () => {
      for (const r of dlg.querySelectorAll(`.carried-choice input[value=${b.dataset.all}]`)) r.checked = true;
    });
  }
}

const split = (turns, values) => ({
  keep: turns.filter((t) => values[`t${t.id}`] !== 'close').map((t) => t.id),
  close: turns.filter((t) => values[`t${t.id}`] === 'close').map((t) => t.id),
});
