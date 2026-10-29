// "Archivo anual" (Datos y reportes): save a finished school year to Excel (+ documents ZIP),
// then free the space in the app. Only an Admin can delete.
import {
  archiveData,
  archivePurge,
  archiveRuns,
  exportArchiveXlsx,
  exportArchiveZip,
  firstAbsenceDate,
} from '../backend.js';
import { $, busy, dialog, fileSize, html, isAdmin, toast, todayStr } from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';

const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtStamp = (iso) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });

/** School years run from August 1 to July 31, newest first. */
function schoolYears(first, today) {
  const startYear = (d) => {
    const [y, m] = d.split('-').map(Number);
    return m >= 8 ? y : y - 1;
  };
  const years = [];
  for (let y = startYear(today); y >= startYear(first || today); y--) {
    years.push({ label: `${y}–${y + 1}`, from: `${y}-08-01`, to: `${y + 1}-07-31` });
  }
  return years;
}

export async function archiveSection(slot) {
  const admin = isAdmin(state.me.user);
  const { school } = state.me;
  const today = todayStr();
  const [first, runs] = await Promise.all([firstAbsenceDate(), archiveRuns().catch(() => [])]);
  const years = schoolYears(first, today);
  let year = years[years.length > 1 ? 1 : 0]; // the last finished year, if there is one
  let data = null;
  let downloaded = { xlsx: false, zip: false };

  slot.innerHTML = String(html`
    <section class="card stack">
      <h2 class="card-title">${icon('archive')} Archivo anual</h2>
      <p class="muted">Al terminar cada año escolar, guarda sus ausencias en Excel y sus documentos en un ZIP.
        ${admin ? 'Después puedes borrarlas de la app para liberar espacio.' : ''}</p>
      <label class="field"><span>Año escolar (1 de agosto – 31 de julio)</span>
        <select data-year>${years.map(
          (y) => html`<option value="${y.from}" ${y === year ? 'selected' : ''}>${y.label}${y.to >= today ? ' (en curso)' : ''}</option>`,
        )}</select></label>
      <div data-summary></div>
      <div class="stack-sm">
        <button type="button" class="btn btn-secondary btn-block" data-xlsx>${icon('download', 18)} 1. Descargar Excel del año</button>
        <button type="button" class="btn btn-secondary btn-block" data-zip>${icon('download', 18)} 2. Descargar documentos (ZIP)</button>
        ${admin ? html`<button type="button" class="btn btn-ghost-danger btn-block" data-purge>${icon('trash', 18)} 3. Liberar espacio</button>` : ''}
      </div>
      <p class="hint" data-purge-hint></p>
      <p class="hint">Las ausencias canceladas se borran solas 15 días después de cancelarse.</p>
      ${runs.length
        ? html`<div class="archive-runs"><h3>Espacio liberado antes</h3><ul>${runs.map(
            (r) => html`<li><strong>${fmtDay(r.date_from)} – ${fmtDay(r.date_to)}</strong>
              <span>${r.absences} ausencias · ${r.files} documentos (${fileSize(r.bytes)}) · ${r.actor_name}, ${fmtStamp(r.created_at)}</span></li>`,
          )}</ul></div>`
        : ''}
    </section>`);

  const summary = $('[data-summary]', slot);
  const xlsxBtn = $('[data-xlsx]', slot);
  const zipBtn = $('[data-zip]', slot);
  const purgeBtn = $('[data-purge]', slot);
  const purgeHint = $('[data-purge-hint]', slot);

  const deletable = () => (data ? data.byStatus.received + data.byStatus.cancelled : 0);

  function refreshButtons() {
    xlsxBtn.disabled = !data?.absences.length;
    zipBtn.disabled = !data?.attachments.length;
    if (!purgeBtn) return;
    const reason = !data
      ? ''
      : year.to >= today
        ? 'Este año escolar aún no termina: no se puede borrar.'
        : !deletable()
          ? 'No hay ausencias recibidas o canceladas para borrar.'
          : !downloaded.xlsx
            ? 'Para liberar espacio, primero descarga el Excel.'
            : '';
    purgeBtn.disabled = !data || !!reason;
    purgeHint.textContent = reason;
    purgeHint.hidden = !reason;
  }

  async function load() {
    data = null;
    downloaded = { xlsx: false, zip: false };
    refreshButtons();
    summary.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    const current = year;
    const loaded = await archiveData(year.from, year.to).catch((err) => {
      summary.innerHTML = String(html`<p class="hint">${err.message}</p>`);
      return null;
    });
    if (!loaded || current !== year) return;
    data = loaded;
    const { byStatus } = data;
    summary.innerHTML = String(html`
      <div class="stats">
        <div class="stat"><strong>${byStatus.received}</strong><span>Recibidas</span></div>
        <div class="stat ${byStatus.pending ? 'stat-warn' : ''}"><strong>${byStatus.pending}</strong><span>Sin confirmar</span></div>
        <div class="stat"><strong>${byStatus.cancelled}</strong><span>Canceladas</span></div>
        <div class="stat"><strong>${data.attachments.length}</strong><span>Documentos · ${fileSize(data.bytes)}</span></div>
      </div>
      ${byStatus.pending
        ? html`<p class="hint">${byStatus.pending === 1
            ? 'La ausencia sin confirmar va en el Excel, pero no se borra hasta que alguien la confirme o la cancele.'
            : `Las ${byStatus.pending} ausencias sin confirmar van en el Excel, pero no se borran hasta que alguien las confirme o las cancele.`}</p>`
        : ''}`);
    refreshButtons();
  }

  $('[data-year]', slot).addEventListener('change', (e) => {
    year = years.find((y) => y.from === e.target.value);
    load();
  });

  xlsxBtn.addEventListener('click', () =>
    busy(xlsxBtn, async () => {
      exportArchiveXlsx(school, data);
      downloaded.xlsx = true;
      toast('Excel descargado. Guárdalo en un lugar seguro (por ejemplo OneDrive).', 'ok');
    }).then(refreshButtons),
  );

  zipBtn.addEventListener('click', () =>
    busy(zipBtn, async () => {
      await exportArchiveZip(school, data, (done, total) => {
        zipBtn.textContent = `Descargando ${done} de ${total}…`;
      });
      downloaded.zip = true;
      toast('Documentos descargados.', 'ok');
    }).then(refreshButtons),
  );

  purgeBtn?.addEventListener('click', async () => {
    if (data.attachments.length && !downloaded.zip) {
      const goOn = await dialog({
        title: 'No descargaste los documentos',
        message: `Hay ${data.attachments.length} documento(s) de excusas en este año. Si continúas, se borrarán sin copia.`,
        confirmText: 'Continuar sin ellos',
        cancelText: 'Volver',
        danger: true,
      });
      if (!goOn) return;
    }
    const answer = await dialog({
      title: `¿Borrar el año ${year.label}?`,
      message: `Se borrarán para siempre ${deletable()} ausencias (recibidas y canceladas), sus comentarios, su historial y ${data.attachments.length} documento(s). Quedarán solo en el Excel que descargaste.`,
      body: html`<label class="field"><span>Escribe BORRAR para confirmar</span>
        <input name="confirm" required autocomplete="off" autocapitalize="characters" spellcheck="false"></label>`,
      collect: true,
      confirmText: 'Borrar para siempre',
      danger: true,
    });
    if (!answer) return;
    if (String(answer.confirm).trim().toUpperCase() !== 'BORRAR') {
      toast('No se borró nada: escribe BORRAR para confirmar.', 'error');
      return;
    }
    await busy(purgeBtn, async () => {
      const r = await archivePurge(year.from, year.to);
      toast(`Listo: se borraron ${r.absences} ausencias y ${r.files} documentos (${fileSize(r.bytes)}).`, 'ok');
      await archiveSection(slot);
    });
  });

  await load();
}
