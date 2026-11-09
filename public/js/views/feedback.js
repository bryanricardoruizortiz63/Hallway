// Más › Comentarios y problemas: tell Hallway's creator an idea, a problem or anything else. The screen and the
// device go with it (to find the problem); the answer comes as a notice and shows here.
import { myFeedback, sendFeedback } from '../backend.js';
import { $, busy, fmtDateTime, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { empty } from './common.js';

const KINDS = [
  ['problem', 'Algo no funciona', 'Un error, algo que no carga o no hace lo que esperabas.'],
  ['idea', 'Una idea', 'Algo que te gustaría que Hallway hiciera o hiciera mejor.'],
  ['other', 'Otra cosa', 'Un comentario, una duda o una felicitación.'],
];
const STATUS = { new: ['Enviado', ''], seen: ['Visto', 'tag-warn'], done: ['Resuelto', 'tag-ok'] };
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));

export async function feedbackView({ el, query }) {
  // The screen it came from (when it's opened from a problem), to find it.
  const from = query.get('desde') || '';

  const drawMine = async () => {
    const list = await myFeedback().catch(() => []);
    $('[data-mine]', el).innerHTML = String(list.length
      ? html`<div class="list">${list.map((f) => html`<div class="item feedback-item">
          <span class="item-main">
            <strong>${KIND_LABEL[f.kind] || f.kind} · <span class="tag ${STATUS[f.status]?.[1] || ''}">${STATUS[f.status]?.[0] || f.status}</span></strong>
            <span class="item-sub pre">${f.message}</span>
            <span class="item-sub">${fmtDateTime(f.created_at)}</span>
            ${f.reply ? html`<span class="feedback-reply"><b>Respuesta de Hallway</b> · ${fmtDateTime(f.replied_at)}<br>${f.reply}</span>` : ''}
          </span>
        </div>`)}</div>`
      : empty('chat', 'Todavía no has enviado nada', 'Lo que envíes aparece aquí, con la respuesta.'));
  };

  el.innerHTML = String(html`<div class="stack">
    <p class="hint">Cuéntale al equipo de Hallway qué piensas de la app o qué problema tuviste. Lo lee quien hace la app; la escuela no lo ve.</p>
    <form class="card stack" data-form>
      <h2 class="card-title">${icon('chat')} ¿Qué quieres contarnos?</h2>
      <div class="choices">
        ${KINDS.map(([value, label, hint], i) => html`<label class="choice"><input type="radio" name="kind" value="${value}" ${i === 0 ? 'checked' : ''}>
          <span><strong>${label}</strong><small>${hint}</small></span></label>`)}
      </div>
      <label class="field"><span>Mensaje</span>
        <textarea name="message" rows="5" maxlength="3000" required placeholder="Ej.: Cuando pido un turno de Enfermería desde el iPad, el botón no hace nada."></textarea></label>
      <p class="hint">Si es un problema, di qué estabas haciendo y en qué pantalla. Enviamos también el modelo del teléfono o la computadora para encontrarlo.</p>
      <button class="btn btn-primary btn-block" type="submit">${icon('send', 18)} Enviar</button>
    </form>
    <section class="section">
      <h3 class="section-title">Lo que has enviado</h3>
      <div data-mine></div>
    </section>
  </div>`);

  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const message = form.message.value.trim();
      if (message.length < 3) throw new Error('Escribe qué quieres contarnos.');
      await sendFeedback(form.kind.value, message, from || null);
      form.message.value = '';
      toast('¡Gracias! Lo recibimos.', 'ok');
      await drawMine();
    });
  });
  await drawMine();
}
