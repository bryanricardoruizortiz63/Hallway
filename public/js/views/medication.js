// Medicamentos diarios (Enfermería): the students who take medication every day at set times.
//   #/medication/:service            «Hoy» (the day's doses: call, «Se medicó», «Ausente», «No se medicó»),
//                                     «Estudiantes» (the list) and «Registro» (a period, to download).
//   #/medication/:service/plan/:id   a student of the list, new («new») or changed.
// At each time the app calls the student by itself (a turn already called: the group's teachers hear «💊 Envía a …»
// and tap «Ya salió»), or reminds the nurse to do it. Only whoever attends the service and the dirección see it.
import {
  callMedication,
  downloadXlsx,
  endMedicationPlan,
  markMedication,
  medicationDay,
  medicationLog,
  medicationPlans,
  saveMedicationPlan,
  servicesOverview,
} from '../backend.js';
import { $, WEEKDAYS, addDays, busy, dialog, fmtDate, fmtLongDate, fmtTime, html, schoolCalendar, toast, todayStr } from '../lib.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { xDate } from '../xlsx.js';
import { empty } from './common.js';
import { keepFresh } from './students.js';

export const STATUS = {
  pending: 'Sin marcar',
  called: 'Llamado',
  given: 'Se medicó',
  absent: 'Ausente',
  not_given: 'No se medicó',
};
const NOT_GIVEN_REASONS = ['Se negó', 'No trajo el medicamento', 'Se le acabó el medicamento', 'Lo tomó en casa', 'Se sintió mal'];

const hour = (hhmm) => fmtTime(hhmm).replace(/\s/g, ' ');
const dayList = (days) => {
  const set = [...days].sort();
  if (set.join() === '1,2,3,4,5') return 'De lunes a viernes';
  if (set.length === 7) return 'Todos los días';
  return set.map((n) => WEEKDAYS.find((w) => w.n === n)?.name).filter(Boolean).join(', ');
};

/** The service, if this person handles its medication (who attends it, or the dirección). */
async function serviceOf(id) {
  const service = (await servicesOverview()).find((s) => s.id === id);
  if (!service || !service.medication) throw new Error('Este servicio no lleva registro de medicamentos.');
  return service;
}

// ---- The screen ----------------------------------------------------------------------------------------------------

export async function medicationView(ctx) {
  const { el, params, setTitle } = ctx;
  const id = Number(params[0]);
  const service = await serviceOf(id);
  setTitle(`Medicamentos · ${service.name}`);
  const tab = ['today', 'list', 'log'].includes(ctx.query?.get('tab')) ? ctx.query.get('tab') : 'today';
  const tabs = [['today', 'Hoy', 'clock'], ['list', 'Estudiantes', 'users'], ['log', 'Registro', 'file']];
  el.innerHTML = String(html`<div class="stack">
    <nav class="med-tabs" aria-label="Medicamentos">${tabs.map(([key, label, ic]) => html`<a href="#/medication/${id}${key === 'today' ? '' : `?tab=${key}`}"
      class="${key === tab ? 'is-on' : ''}" ${key === tab ? 'aria-current="page"' : ''}>${icon(ic, 18)} ${label}</a>`)}</nav>
    <div class="stack" data-tab></div>
  </div>`);
  const slot = $('[data-tab]', el);
  if (tab === 'list') return listTab(ctx, slot, service);
  if (tab === 'log') return logTab(slot, service);
  return todayTab(ctx, slot, service);
}

// ---- Hoy -----------------------------------------------------------------------------------------------------------

function todayTab(ctx, slot, service) {
  const today = todayStr();
  let day = today;
  slot.innerHTML = String(html`
    <section class="card stack">
      <label class="field"><span>Día</span>
        <input type="date" data-day value="${today}" min="${addDays(today, -30)}" max="${today}"></label>
      <p class="hint">Puedes marcar los últimos 30 días.</p>
    </section>
    <div class="stack" data-doses></div>`);
  const list = $('[data-doses]', slot);

  const doseCard = (d, data) => {
    const isToday = data.day === today;
    const late = isToday && d.status === 'pending' && d.at_time <= data.now;
    const open = ['pending', 'called'].includes(d.status);
    const done = !open;
    const who = d.status === 'called'
      ? `Llamado a las ${fmtTime(new Date(d.called_at))}${d.called_by_name ? ` · ${d.called_by_name}` : ''}`
      : done
        ? `${fmtTime(new Date(d.done_at))}${d.done_by_name ? ` · ${d.done_by_name}` : ''}`
        : d.auto_call ? (isToday && !late ? 'Se llama solo a su hora' : 'No se llamó') : 'Lo llamas tú';
    return html`<li class="card med-dose st-${d.status} ${late ? 'is-late' : ''}" data-dose="${d.plan_id}|${d.at_time}">
      <div class="med-head">
        <span class="med-who"><strong>${d.student_name}</strong><small>${d.group_name}</small></span>
        <span class="med-status">${late ? 'Le tocaba ya' : STATUS[d.status]}</span>
      </div>
      <p class="med-drug">${icon('pill', 16)} ${d.medication}</p>
      ${d.note ? html`<p class="hint">${d.note}</p>` : ''}
      ${d.reason ? html`<p class="med-reason">${d.reason}</p>` : ''}
      <p class="hint">${who}${d.request_id ? html` · <a href="#/turns/${d.request_id}">Ver el turno</a>` : ''}</p>
      ${d.plan_id ? html`<div class="button-row">
        ${open && isToday && d.status === 'pending' ? html`<button type="button" class="btn btn-secondary btn-sm" data-call>${icon('bell', 16)} Llamar</button>` : ''}
        ${open ? html`<button type="button" class="btn btn-primary btn-sm" data-mark="given">${icon('check', 16)} Se medicó</button>
          <button type="button" class="btn btn-ghost btn-sm" data-mark="absent">Ausente</button>
          <button type="button" class="btn btn-ghost btn-sm" data-mark="not_given">No se medicó</button>` : ''}
        ${done ? html`<button type="button" class="btn btn-ghost btn-sm" data-mark="pending">Cambiar</button>` : ''}
      </div>` : ''}
    </li>`;
  };

  async function load() {
    const data = await medicationDay(service.id, day);
    const doses = data.doses || [];
    const times = [...new Set(doses.map((d) => d.at_time))];
    const count = (st) => doses.filter((d) => d.status === st).length;
    list.innerHTML = String(doses.length
      ? html`${data.school_day ? '' : html`<p class="status-note warn">${day === today ? 'Hoy' : 'Ese día'} no hay clases: la app no llama a nadie.</p>`}
        <div class="stats">
          <div class="stat"><strong>${doses.length}</strong><span>${doses.length === 1 ? 'Dosis' : 'Dosis'}</span></div>
          <div class="stat st-ok"><strong>${count('given')}</strong><span>Se medicaron</span></div>
          <div class="stat"><strong>${count('absent') + count('not_given')}</strong><span>Ausentes o sin medicar</span></div>
          <div class="stat"><strong>${count('pending') + count('called')}</strong><span>Por marcar</span></div>
        </div>
        ${times.map((t) => html`<section class="stack">
          <h3 class="section-title">${hour(t)}</h3>
          <ul class="med-list">${doses.filter((d) => d.at_time === t).map((d) => doseCard(d, data))}</ul>
        </section>`)}`
      : empty('pill', 'Nadie se medica este día', 'Añade estudiantes en «Estudiantes».',
        html`<a class="btn btn-primary" href="#/medication/${service.id}/plan/new">${icon('plus', 18)} Añadir estudiante</a>`));
    bind(data);
  }

  function bind(data) {
    for (const card of list.querySelectorAll('[data-dose]')) {
      const [planId, time] = card.dataset.dose.split('|');
      const d = (data.doses || []).find((x) => String(x.plan_id) === planId && x.at_time === time);
      card.querySelector('[data-call]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        await callMedication(Number(planId), time);
        toast(`Llamaste a ${d.student_name}. A sus maestros les llegó el aviso.`, 'ok');
        await load();
      }));
      for (const b of card.querySelectorAll('[data-mark]')) {
        b.addEventListener('click', (e) => busy(e.currentTarget, async () => {
          const status = b.dataset.mark;
          let reason = null;
          if (status === 'not_given') {
            reason = await askReason(d);
            if (!reason) return;
          } else if (status === 'absent') {
            const r = await dialog({
              title: `¿${d.student_name} está ausente?`,
              message: 'Queda en el registro que hoy no se medicó porque no vino.',
              body: html`<label class="field"><span>Nota <em class="optional">opcional</em></span>
                <input name="note" maxlength="300" placeholder="Ej. No vino a la escuela"></label>`,
              confirmText: 'Marcar ausente',
              collect: true,
            });
            if (!r) return;
            reason = r.note?.trim() || null;
          }
          await markMedication(Number(planId), data.day, time, status, reason);
          if (status !== 'pending') toast(`${d.student_name}: ${STATUS[status].toLowerCase()}.`, 'ok');
          await load();
        }));
      }
    }
  }

  $('[data-day]', slot).addEventListener('change', (e) => {
    if (!e.target.value) return;
    day = e.target.value;
    load().catch((err) => toast(err.message, 'error'));
  });
  keepFresh(ctx, load);
  return load();
}

/** «No se medicó»: why (a quick choice or written). */
async function askReason(d) {
  const r = await dialog({
    title: `¿Por qué no se medicó ${d.student_name}?`,
    body: html`<div class="chips" data-quick>${NOT_GIVEN_REASONS.map((x) => html`<button type="button" class="chip-btn" data-r="${x}">${x}</button>`)}</div>
      <label class="field"><span>Razón</span><textarea name="reason" rows="2" maxlength="300" required placeholder="Escribe por qué"></textarea></label>`,
    confirmText: 'Guardar',
    collect: true,
    onOpen: (dlg) => {
      for (const b of dlg.querySelectorAll('[data-r]')) {
        b.addEventListener('click', () => {
          dlg.querySelector('[name=reason]').value = b.dataset.r;
          for (const x of dlg.querySelectorAll('[data-r]')) x.classList.toggle('active', x === b);
        });
      }
    },
  });
  return r?.reason?.trim() || null;
}

// ---- Estudiantes -----------------------------------------------------------------------------------------------------

async function listTab(ctx, slot, service) {
  const plans = await medicationPlans(service.id);
  const active = plans.filter((p) => p.active);
  const ended = plans.filter((p) => !p.active);
  const row = (p) => html`<a class="item" href="#/medication/${service.id}/plan/${p.id}">
    <span class="item-icon">${icon('pill')}</span>
    <span class="item-main"><strong>${p.student_name} <small>(${p.group_name})</small></strong>
      <span class="item-sub">${p.medication}</span>
      <span class="item-sub">${p.times.map((t) => hour(t.slice(0, 5))).join(', ')} · ${dayList(p.weekdays)}${p.end_date ? ` · hasta el ${fmtDate(p.end_date)}` : ''}</span>
      <span class="item-tags"><span class="tag ${p.auto_call ? 'ok' : ''}">${p.auto_call ? 'Se llama solo' : 'Lo llamas tú'}</span>
        ${p.start_date > todayStr() ? html`<span class="tag">Empieza el ${fmtDate(p.start_date)}</span>` : ''}</span>
    </span>${icon('chevron', 18)}</a>`;
  slot.innerHTML = String(html`
    <a class="btn btn-primary btn-block" href="#/medication/${service.id}/plan/new">${icon('plus', 18)} Añadir estudiante</a>
    ${active.length
      ? html`<section class="stack"><h3 class="section-title">Se medican <span class="count">${active.length}</span></h3>
          <div class="list">${active.map(row)}</div></section>`
      : empty('pill', 'Nadie en la lista', 'Añade a los estudiantes que se medican en la escuela, con su hora.')}
    ${ended.length ? html`<details class="card"><summary>Quitados de la lista (${ended.length})</summary>
        <div class="list">${ended.map((p) => html`<div class="item"><span class="item-icon">${icon('pill')}</span>
          <span class="item-main"><strong>${p.student_name} <small>(${p.group_name})</small></strong>
            <span class="item-sub">${p.medication}</span>
            <span class="item-sub">Lo quitó ${p.ended_by_name || '—'} el ${fmtDate(todayStr(new Date(p.ended_at)))}</span></span></div>`)}</div>
      </details>` : ''}
    <p class="hint">Solo ${service.name} y la dirección ven esta lista. A los maestros solo les llega «Envía a … a ${service.name}», sin el medicamento.</p>`);
}

// ---- Registro ------------------------------------------------------------------------------------------------------

async function logTab(slot, service) {
  const today = todayStr();
  slot.innerHTML = String(html`
    <section class="card stack">
      <div class="grid2">
        <label class="field"><span>Desde</span><input type="date" data-from value="${today.slice(0, 8)}01" max="${today}"></label>
        <label class="field"><span>Hasta</span><input type="date" data-to value="${today}" max="${today}"></label>
      </div>
    </section>
    <div class="stack" data-log></div>`);
  const out = $('[data-log]', slot);
  let rows = [];
  const range = () => ({ from: $('[data-from]', slot).value, to: $('[data-to]', slot).value });

  async function load() {
    const r = range();
    if (!r.from || !r.to) return;
    if (r.from > r.to) throw new Error('La fecha inicial debe ser antes de la final.');
    rows = await medicationLog(service.id, r.from, r.to);
    const count = (st) => rows.filter((d) => d.status === st).length;
    const days = [...new Set(rows.map((d) => d.day))].sort().reverse();
    out.innerHTML = String(rows.length
      ? html`<div class="stats">
          <div class="stat"><strong>${rows.length}</strong><span>Dosis</span></div>
          <div class="stat st-ok"><strong>${count('given')}</strong><span>Se medicaron</span></div>
          <div class="stat"><strong>${count('absent')}</strong><span>Ausentes</span></div>
          <div class="stat"><strong>${count('not_given')}</strong><span>No se medicaron</span></div>
          <div class="stat"><strong>${count('pending') + count('called')}</strong><span>Sin marcar</span></div>
        </div>
        <button type="button" class="btn btn-secondary btn-block" data-export>${icon('download', 18)} Descargar (Excel o PDF)</button>
        ${days.slice(0, 31).map((day) => html`<section class="stack">
          <h3 class="section-title">${fmtLongDate(day)}</h3>
          <div class="list">${rows.filter((d) => d.day === day).map((d) => html`<div class="item med-log st-${d.status}">
            <span class="item-main"><strong>${d.student_name} <small>(${d.group_name})</small></strong>
              <span class="item-sub">${hour(d.at_time.slice(0, 5))} · ${d.medication}</span>
              ${d.reason ? html`<span class="item-sub">${d.reason}</span>` : ''}</span>
            <span class="tag med-tag">${STATUS[d.status]}</span></div>`)}</div>
        </section>`)}
        ${days.length > 31 ? html`<p class="hint">Se muestran los últimos 31 días; la descarga trae todo el período.</p>` : ''}`
      : empty('file', 'Sin registro en este período', 'Cada dosis queda aquí desde su hora: se medicó, ausente, no se medicó o sin marcar.'));
    $('[data-export]', out)?.addEventListener('click', (e) => busy(e.currentTarget, () => exportLog(r)));
  }

  function exportLog(r) {
    const by = new Map();
    for (const d of rows) {
      const key = `${d.student_key}|${d.group_name}|${d.medication}`;
      const x = by.get(key) || { name: d.student_name, group: d.group_name, med: d.medication, all: 0, given: 0, absent: 0, not_given: 0, open: 0 };
      x.all++;
      if (d.status === 'given') x.given++;
      else if (d.status === 'absent') x.absent++;
      else if (d.status === 'not_given') x.not_given++;
      else x.open++;
      by.set(key, x);
    }
    return downloadXlsx(`medicamentos_${r.from}_${r.to}.xlsx`, [
      {
        name: 'Registro',
        columns: [
          { header: 'Fecha', width: 11 }, { header: 'Hora', width: 10 }, { header: 'Estudiante', width: 26 }, { header: 'Grupo', width: 8 },
          { header: 'Medicamento', width: 26, wrap: true }, { header: 'Estado', width: 14 }, { header: 'Razón', width: 30, wrap: true },
          { header: 'Llamado por', width: 18 }, { header: 'Marcado por', width: 20 }, { header: 'Hora marcado', width: 12 },
        ],
        rows: rows.map((d) => [xDate(d.day), hour(d.at_time.slice(0, 5)), d.student_name, d.group_name, d.medication,
          STATUS[d.status], d.reason, d.called_by_name, d.done_by_name, d.done_at ? fmtTime(new Date(d.done_at)) : null]),
      },
      {
        name: 'Por estudiante',
        columns: [
          { header: 'Estudiante', width: 26 }, { header: 'Grupo', width: 8 }, { header: 'Medicamento', width: 26, wrap: true },
          { header: 'Dosis', width: 8 }, { header: 'Se medicó', width: 10 }, { header: 'Ausente', width: 9 },
          { header: 'No se medicó', width: 12 }, { header: 'Sin marcar', width: 10 },
        ],
        rows: [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
          .map((x) => [x.name, x.group, x.med, x.all, x.given, x.absent, x.not_given, x.open]),
      },
    ], { title: `Medicamentos · ${service.name}`, details: `${fmtLongDate(r.from)} – ${fmtLongDate(r.to)}` });
  }

  for (const input of slot.querySelectorAll('[data-from], [data-to]')) {
    input.addEventListener('change', () => load().catch((err) => toast(err.message, 'error')));
  }
  return load();
}

// ---- A student of the list ------------------------------------------------------------------------------------------

export async function medicationPlanView(ctx) {
  const { el, params, setTitle } = ctx;
  const id = Number(params[0]);
  const isNew = params[1] === 'new';
  const service = await serviceOf(id);
  const plan = isNew ? null : (await medicationPlans(id)).find((p) => p.id === Number(params[1]) && p.active);
  if (!isNew && !plan) throw new Error('No se encontró ese estudiante en la lista.');
  setTitle(isNew ? 'Añadir estudiante' : plan.student_name);
  const { groups, school_days: schoolDays } = schoolCalendar(state.me.school);
  const days = plan?.weekdays || schoolDays;
  const times = plan?.times.map((t) => t.slice(0, 5)) || [''];

  el.innerHTML = String(html`<form class="stack" data-form novalidate>
    <section class="card stack">
      <h2 class="card-title">${icon('user')} Estudiante</h2>
      <label class="field"><span>Nombre y apellidos</span>
        <input name="name" maxlength="100" autocomplete="off" required value="${plan?.student_name || ''}" placeholder="Ej. Carlos Méndez"></label>
      <label class="field"><span>Grupo</span><select name="group" required>
        <option value="">Elige el grupo</option>
        ${groups.map((g) => html`<option value="${g}" ${plan?.group_name === g ? 'selected' : ''}>${g}</option>`)}
      </select></label>
    </section>
    <section class="card stack">
      <h2 class="card-title">${icon('pill')} Medicamento</h2>
      <label class="field"><span>Medicamento y dosis</span>
        <input name="medication" maxlength="120" required value="${plan?.medication || ''}" placeholder="Ej. Metilfenidato 10 mg, 1 tableta"></label>
      <label class="field"><span>Nota <em class="optional">opcional</em></span>
        <textarea name="note" rows="2" maxlength="300" placeholder="Ej. Con comida; se guarda en la nevera">${plan?.note || ''}</textarea></label>
    </section>
    <section class="card stack">
      <h2 class="card-title">${icon('clock')} ¿Cuándo?</h2>
      <div class="stack" data-times>${times.map((t) => timeRow(t))}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-add-time>${icon('plus', 16)} Otra hora</button>
      <div class="chips" role="group" aria-label="Días">${WEEKDAYS.map((w) => html`<label class="chip">
        <input type="checkbox" name="day" value="${w.n}" ${days.includes(w.n) ? 'checked' : ''}><span>${w.short}</span></label>`)}</div>
      <div class="grid2">
        <label class="field"><span>Desde</span><input type="date" name="start" value="${plan?.start_date || todayStr()}"></label>
        <label class="field"><span>Hasta <em class="optional">opcional</em></span><input type="date" name="end" value="${plan?.end_date || ''}"></label>
      </div>
      <p class="hint">Sin fecha final, sigue hasta que lo quites de la lista. Los días sin clases no se llama a nadie.</p>
    </section>
    <section class="card stack">
      <label class="toggle notify-row"><input type="checkbox" name="auto" ${plan?.auto_call === false ? '' : 'checked'}>
        <span class="toggle-ui"></span><span class="notify-text"><span>Llamarlo automáticamente a su hora</span>
        <small>A esa hora, a sus maestros les llega «Envía a … a ${service.name}» y tocan «Ya salió», como en cualquier turno.
          Apágalo para llamarlo tú: a la hora te llega un recordatorio.</small></span></label>
    </section>
    <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('check')} Guardar</button>
    ${isNew ? '' : html`<button type="button" class="btn btn-ghost-danger btn-block" data-end>Quitar de la lista</button>`}
  </form>`);

  const form = $('[data-form]', el);
  const timesBox = $('[data-times]', el);
  const bindRemove = () => {
    for (const b of timesBox.querySelectorAll('[data-remove-time]')) {
      b.hidden = timesBox.children.length < 2;
      b.onclick = () => {
        b.closest('.med-time').remove();
        bindRemove();
      };
    }
    $('[data-add-time]', el).hidden = timesBox.children.length >= 6;
  };
  bindRemove();
  $('[data-add-time]', el).addEventListener('click', () => {
    timesBox.insertAdjacentHTML('beforeend', String(timeRow('')));
    bindRemove();
    timesBox.lastElementChild.querySelector('input').focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const hours = [...timesBox.querySelectorAll('input')].map((i) => i.value).filter(Boolean);
      if (!form.name.value.trim()) throw new Error('Escribe el nombre del estudiante.');
      if (!form.group.value) throw new Error('Elige el grupo.');
      if (!form.medication.value.trim()) throw new Error('Escribe el medicamento y la dosis.');
      if (!hours.length) throw new Error('Escribe a qué hora se medica.');
      const weekdays = [...form.querySelectorAll('[name=day]:checked')].map((i) => Number(i.value));
      if (!weekdays.length) throw new Error('Elige qué días se medica.');
      await saveMedicationPlan({
        id: plan?.id,
        serviceId: id,
        name: form.name.value.trim(),
        group: form.group.value,
        medication: form.medication.value.trim(),
        note: form.note.value.trim(),
        times: hours,
        weekdays,
        auto: form.auto.checked,
        start: form.start.value,
        end: form.end.value,
      });
      toast(isNew ? 'Estudiante añadido' : 'Cambios guardados', 'ok');
      go(`/medication/${id}?tab=list`, { replace: true });
    });
  });
  $('[data-end]', el)?.addEventListener('click', async () => {
    const ok = await dialog({
      title: `¿Quitar a ${plan.student_name} de la lista?`,
      message: 'Ya no se llamará. Su registro de días anteriores se queda.',
      confirmText: 'Quitar de la lista',
      danger: true,
    });
    if (!ok) return;
    await endMedicationPlan(plan.id);
    toast('Quitado de la lista', 'ok');
    go(`/medication/${id}?tab=list`, { replace: true });
  });
}

const timeRow = (value) => html`<div class="med-time">
  <label class="field"><span>Hora</span><input type="time" value="${value}" required></label>
  <button type="button" class="icon-btn" data-remove-time aria-label="Quitar esta hora">${icon('x', 18)}</button>
</div>`;
