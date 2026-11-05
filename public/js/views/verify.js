// #/verify/CODE (and #/verify, to type a code): checks a document the app made. It works without an account: whoever
// receives the paper scans its QR code. It shows what Hallway kept of that document (who made it, when and, for
// absences, turns and a person's history, every item), so it can be compared with the paper.
import { verifyDocument } from '../backend.js';
import { $, busy, fmtDateTime, html } from '../lib.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { appIcon } from '../branding.js';
import { absenceBlock, historyBlock, turnBlock } from '../docs.js';

const FORMATS = { pdf: 'PDF', image: 'Foto', excel: 'Excel' };
const KINDS = {
  absences: 'Ausencias', turns: 'Turnos', history: 'Historial de una persona', school_history: 'Historial del personal',
  export: 'Descarga de datos',
};

function blocksOf(d) {
  const list = Array.isArray(d.content) ? d.content : [];
  if (d.kind === 'absences') return list.map((a) => absenceBlock(a));
  if (d.kind === 'turns') return list.map(turnBlock);
  if (d.kind === 'history') return list.map(historyBlock);
  return [];
}

function result(d) {
  if (!d) {
    return html`<section class="card stack verify-result is-bad">
      <h2 class="card-title">${icon('alert')} No encontramos este código</h2>
      <p>Revisa que esté bien escrito. Si lo está, el documento no salió de Hallway, o tiene más de un año (las copias se guardan un año).</p>
    </section>`;
  }
  const blocks = blocksOf(d);
  return html`<section class="card stack verify-result is-ok">
      <h2 class="card-title">${icon('check')} Documento auténtico de Hallway</h2>
      <p>Este código existe y corresponde a este documento. Compara el papel con lo de abajo: si dice algo distinto, lo cambiaron.</p>
      <dl class="details">
        <div><dt>Escuela</dt><dd>${d.school_name}</dd></div>
        <div><dt>Documento</dt><dd>${d.title}</dd></div>
        ${d.details ? html`<div><dt>Filtros o período</dt><dd>${d.details}</dd></div>` : ''}
        <div><dt>Tipo</dt><dd>${t(KINDS[d.kind] || d.kind)} · ${t(FORMATS[d.format] || d.format)}</dd></div>
        <div><dt>Lo generó</dt><dd>${d.created_by_name}</dd></div>
        <div><dt>Fecha</dt><dd>${fmtDateTime(d.created_at)}</dd></div>
        <div><dt>Elementos</dt><dd>${d.items}</dd></div>
        <div><dt>Código</dt><dd class="verify-code">${d.code}</dd></div>
        <div><dt>Huella</dt><dd class="verify-code">${d.hash}</dd></div>
      </dl>
    </section>
    ${blocks.length
      ? html`<section class="section">
          <h3 class="section-title">Lo que contiene <span class="count">${blocks.length}</span></h3>
          <div class="list">${blocks.map((b) => html`<div class="item"><span class="item-main"><strong>${b.title}</strong>
            ${b.lines.map((l) => html`<span class="item-sub verify-line">${l}</span>`)}</span></div>`)}</div>
        </section>`
      : html`<p class="hint">${d.kind === 'school_history'
          ? 'Hallway guardó cuántas líneas tenía y una huella de todas ellas; el detalle completo está en el Excel.'
          : 'Hallway guardó quién lo descargó, cuándo y cuántas filas tenía.'}</p>`}`;
}

export async function verifyView({ el, params }) {
  const code = (params[0] || '').toUpperCase();
  el.innerHTML = String(html`<div class="verify-page">
    <header class="verify-head">
      <img src="${appIcon()}" alt="" width="44" height="44">
      <div><strong>Hallway</strong><span>Verificar un documento</span></div>
    </header>
    <form class="card stack" data-verify>
      <label class="field"><span>Código de verificación</span>
        <input name="code" value="${code}" placeholder="Ej. K7QM-3XPA-9RTD" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
      <button class="btn btn-primary btn-block" type="submit">${icon('search', 18)} Verificar</button>
      <p class="hint">El código está en el documento, junto al código QR. Escanear el QR abre esta página con el código puesto.</p>
    </form>
    <div data-result></div>
  </div>`);
  const form = $('[data-verify]', el);
  const check = async () => {
    const value = form.code.value.trim();
    if (!value) return;
    const d = await verifyDocument(value);
    $('[data-result]', el).innerHTML = String(result(d));
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), check);
  });
  if (code) await busy(form.querySelector('[type=submit]'), check);
}
