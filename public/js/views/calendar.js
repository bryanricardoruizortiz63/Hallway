// Calendario escolar: class hours and days without classes. Everyone can see it; roles with the "calendar"
// permission (Secretaría, Director(a)…) change it. They also keep the school's grades and groups, on a screen of
// their own (Grados y grupos).
import {
  addSchoolGroups,
  deleteClosure,
  listClosures,
  listEmployees,
  removeSchoolGroup,
  renameSchoolGroup,
  saveClosure,
  saveRoomHours,
  saveSchoolHours,
} from '../backend.js';
import {
  $,
  WEEKDAYS,
  busy,
  can,
  daysText,
  dialog,
  fmtDate,
  fmtTime,
  html,
  isStaff,
  schoolCalendar,
  toast,
  todayStr,
} from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';

export const CLOSURE_KINDS = {
  holiday: { label: 'Feriado', hint: 'No se trabaja.' },
  no_classes: { label: 'Sin estudiantes', hint: 'El personal trabaja (por ejemplo, desarrollo profesional).' },
};

const GRADES = ['Pre-K', 'K', ...Array.from({ length: 12 }, (_, i) => String(i + 1))];

const dayCount = (c) => Math.round((new Date(`${c.end_date}T12:00:00`) - new Date(`${c.start_date}T12:00:00`)) / 86400000) + 1;

/** "lun, 12 oct" or "lun, 21 dic – mié, 6 ene". */
export function closureDates(c) {
  return c.start_date === c.end_date ? fmtDate(c.start_date) : `${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}`;
}

function setGroups(groups) {
  state.me.school.calendar = { ...schoolCalendar(state.me.school), groups };
}

/** "7-A, 7-B … 12-C" from a range of grades and the letters of each one. */
function bulkNames(from, to, letters) {
  const a = GRADES.indexOf(from);
  const b = GRADES.indexOf(to);
  const list = String(letters || '').split(/[,\s]+/).map((l) => l.trim()).filter(Boolean);
  if (a < 0 || b < 0 || !list.length) return [];
  const grades = GRADES.slice(Math.min(a, b), Math.max(a, b) + 1);
  return grades.flatMap((g) => list.map((l) => `${g}-${l}`));
}

async function closureDialog(c = null) {
  const kind = c?.kind || 'holiday';
  return dialog({
    title: c ? 'Cambiar día sin clases' : 'Añadir día sin clases',
    body: html`<div class="stack">
      <label class="field"><span>Nombre</span>
        <input name="name" maxlength="80" required value="${c?.name || ''}" placeholder="Ej. Día de Acción de Gracias" autocomplete="off"></label>
      <div class="grid2">
        <label class="field"><span>Fecha</span>
          <input type="date" name="start" required value="${c?.start_date || todayStr()}"></label>
        <label class="field"><span>Hasta <em class="optional">si son varios días</em></span>
          <input type="date" name="end" value="${c && c.end_date !== c.start_date ? c.end_date : ''}"></label>
      </div>
      <div class="choices">${Object.entries(CLOSURE_KINDS).map(
        ([key, k]) => html`<label class="choice"><input type="radio" name="kind" value="${key}" ${key === kind ? 'checked' : ''}>
          <span><strong>${k.label}</strong><small>${k.hint}</small></span></label>`,
      )}</div>
    </div>`,
    confirmText: c ? 'Guardar' : 'Añadir',
    onOpen(dlg) {
      const start = dlg.querySelector('[name=start]');
      const end = dlg.querySelector('[name=end]');
      const sync = () => {
        end.min = start.value;
      };
      start.addEventListener('change', sync);
      sync();
      dlg.querySelector('[name=name]').focus();
    },
    onSubmit: (v) => {
      if (!v.name.trim()) throw new Error('Escribe el nombre.');
      if (!v.start) throw new Error('Elige la fecha.');
      if (v.end && v.end < v.start) throw new Error('La fecha final debe ser igual o después de la inicial.');
      return saveClosure({ id: c?.id, start: v.start, end: v.end, name: v.name.trim(), kind: v.kind });
    },
  });
}

function closureItem(c, { editor, today }) {
  const now = c.start_date <= today && c.end_date >= today;
  const n = dayCount(c);
  return html`<div class="item closure-item ${c.end_date < today ? 'is-muted' : ''}">
    <span class="item-icon ${c.kind === 'holiday' ? 'is-warn' : ''}">${icon('calendar')}</span>
    <span class="item-main">
      <strong>${c.name}</strong>
      <span class="item-sub">${closureDates(c)}${n > 1 ? ` · ${n} días` : ''}</span>
      <span class="item-tags">
        <span class="tag ${c.kind === 'holiday' ? 'tag-warn' : ''}">${CLOSURE_KINDS[c.kind]?.label || c.kind}</span>
        ${now ? html`<span class="tag tag-ok">Hoy</span>` : ''}
      </span>
    </span>
    ${editor
      ? html`<span class="item-actions">
          <button class="icon-btn" data-edit-closure="${c.id}" aria-label="Cambiar ${c.name}">${icon('edit', 18)}</button>
          <button class="icon-btn" data-delete-closure="${c.id}" aria-label="Borrar ${c.name}">${icon('trash', 18)}</button>
        </span>`
      : ''}
  </div>`;
}

export async function calendarView({ el, isCurrent }) {
  const user = state.me.user;
  const editor = can(user, 'calendar');
  const today = todayStr();
  let closures = [];
  let showPast = false;

  const hoursCard = () => {
    const cal = schoolCalendar(state.me.school);
    if (!editor) {
      return html`<section class="card stack" data-class-hours>
        <h2 class="card-title">${icon('clock')} Horario de clases</h2>
        <p><strong>${fmtTime(cal.day_start)} – ${fmtTime(cal.day_end)}</strong></p>
        <p class="muted">De ${daysText(cal.school_days)}.</p>
      </section>`;
    }
    return html`<form class="card stack" data-hours novalidate>
      <h2 class="card-title">${icon('clock')} Horario de clases</h2>
      <div class="grid2">
        <label class="field"><span>Entrada</span><input type="time" name="day_start" required value="${cal.day_start}"></label>
        <label class="field"><span>Salida</span><input type="time" name="day_end" required value="${cal.day_end}"></label>
      </div>
      <div class="field"><span>Días de clases</span>
        <div class="chips weekday-chips">${WEEKDAYS.map(
          (d) => html`<label class="chip"><input type="checkbox" name="day" value="${d.n}" ${cal.school_days.includes(d.n) ? 'checked' : ''}>
            <span title="${d.name}">${d.short}</span></label>`,
        )}</div>
      </div>
      <p class="hint">Con la salida terminan los recordatorios de cobertura y llega el resumen del día.</p>
      <button class="btn btn-secondary" type="submit">Guardar horario</button>
    </form>`;
  };

  /** When the conference room can be reserved: its own hours, apart from the classes. */
  const roomCard = () => {
    const cal = schoolCalendar(state.me.school);
    if (!editor) {
      return html`<section class="card stack" data-room-hours>
        <h2 class="card-title">${icon('room')} Horario del salón de conferencias</h2>
        <p><strong>${fmtTime(cal.room_start)} – ${fmtTime(cal.room_end)}</strong></p>
        <p class="muted">Se reserva en ese horario, de ${daysText(cal.school_days)}.</p>
      </section>`;
    }
    return html`<form class="card stack" data-room-hours novalidate>
      <h2 class="card-title">${icon('room')} Horario del salón de conferencias</h2>
      <div class="grid2">
        <label class="field"><span>Desde</span><input type="time" name="room_start" required value="${cal.room_start}"></label>
        <label class="field"><span>Hasta</span><input type="time" name="room_end" required value="${cal.room_end}"></label>
      </div>
      <p class="hint">Se puede reservar en este horario, los días de clases. Es aparte del horario de clases: puede empezar antes o terminar más tarde.</p>
      <button class="btn btn-secondary" type="submit">Guardar horario del salón</button>
    </form>`;
  };

  const closuresCard = () => {
    const upcoming = closures.filter((c) => c.end_date >= today);
    const past = closures.filter((c) => c.end_date < today).reverse();
    return html`<section class="card stack">
      <div class="card-head">
        <h2 class="card-title">${icon('calendar')} Días sin clases</h2>
        ${editor ? html`<button class="btn btn-primary btn-sm" data-add-closure>${icon('plus', 16)} Añadir</button>` : ''}
      </div>
      ${upcoming.length
        ? html`<div class="list flat">${upcoming.map((c) => closureItem(c, { editor, today }))}</div>`
        : html`<p class="muted">${editor
            ? 'Marca aquí los feriados y los días sin estudiantes del año escolar.'
            : 'No hay días sin clases marcados por ahora.'}</p>`}
      ${past.length
        ? html`<button type="button" class="btn btn-ghost btn-sm" data-past>${showPast ? 'Ocultar' : 'Ver'} días pasados (${past.length})</button>
          ${showPast ? html`<div class="list flat">${past.map((c) => closureItem(c, { editor, today }))}</div>` : ''}`
        : ''}
      ${editor
        ? html`<p class="hint"><b>Feriado</b>: no se trabaja. <b>Sin estudiantes</b>: el personal trabaja, pero no hay clases.
            Al reportar una ausencia se avisa si ese día no hay clases.</p>`
        : ''}
    </section>`;
  };

  const render = () => {
    el.innerHTML = String(html`<div class="stack">${hoursCard()}${roomCard()}${closuresCard()}
      ${editor
        ? html`<a class="card link-card" href="#/groups">${icon('users')}<span><strong>Grados y grupos</strong><small>Los grupos de la escuela, en su propia pantalla</small></span>${icon('chevron', 18)}</a>`
        : ''}</div>`);
    bind();
  };

  const reloadClosures = async () => {
    closures = await listClosures();
    if (isCurrent()) render();
  };

  function bind() {
    const hours = $('[data-hours]', el);
    hours?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(hours.querySelector('[type=submit]'), async () => {
        const days = [...hours.querySelectorAll('[name=day]:checked')].map((c) => Number(c.value));
        if (!days.length) throw new Error('Elige al menos un día de clases.');
        const { day_start: start, day_end: end } = Object.fromEntries(new FormData(hours));
        if (!start || !end) throw new Error('Indica la hora de entrada y la de salida.');
        if (end <= start) throw new Error('La hora de salida debe ser después de la de entrada.');
        state.me.school.calendar = await saveSchoolHours(start, end, days);
        toast('Horario guardado', 'ok');
      });
    });

    const room = $('form[data-room-hours]', el);
    room?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(room.querySelector('[type=submit]'), async () => {
        const { room_start: start, room_end: end } = Object.fromEntries(new FormData(room));
        if (!start || !end) throw new Error('Indica desde qué hora y hasta qué hora se puede reservar.');
        if (end <= start) throw new Error('La hora final debe ser después de la inicial.');
        state.me.school.calendar = await saveRoomHours(start, end);
        toast('Horario del salón guardado', 'ok');
      });
    });

    $('[data-add-closure]', el)?.addEventListener('click', async () => {
      if (await closureDialog()) {
        toast('Día añadido al calendario', 'ok');
        await reloadClosures();
      }
    });
    $('[data-past]', el)?.addEventListener('click', () => {
      showPast = !showPast;
      render();
    });
    for (const btn of el.querySelectorAll('[data-edit-closure]')) {
      btn.addEventListener('click', async () => {
        const c = closures.find((x) => String(x.id) === btn.dataset.editClosure);
        if (await closureDialog(c)) {
          toast('Cambios guardados', 'ok');
          await reloadClosures();
        }
      });
    }
    for (const btn of el.querySelectorAll('[data-delete-closure]')) {
      btn.addEventListener('click', async () => {
        const c = closures.find((x) => String(x.id) === btn.dataset.deleteClosure);
        const ok = await dialog({ title: `¿Borrar «${c.name}»?`, message: closureDates(c), confirmText: 'Borrar', danger: true });
        if (!ok) return;
        await busy(btn, async () => {
          await deleteClosure(c.id);
          toast('Día borrado del calendario', 'ok');
          await reloadClosures();
        });
      });
    }
  }

  closures = await listClosures();
  if (!isCurrent()) return;
  render();
}

/**
 * Grados y grupos: the school's groups (7-A, 7-B…), which each person gets in their file in Personal. Only for whoever
 * keeps the calendar.
 */
export async function groupsView({ el, isCurrent }) {
  const user = state.me.user;
  // How many people have each group (only for those who see the staff list).
  let people = null;

  const groupsCard = () => {
    const { groups } = schoolCalendar(state.me.school);
    const count = (g) => people?.filter((p) => p.groups?.includes(g)).length ?? null;
    return html`<section class="card stack" data-groups>
      <h2 class="card-title">${icon('users')} Grados y grupos</h2>
      <p class="muted">Cada maestro verá solo a los estudiantes de sus grupos. Los grupos de cada persona se eligen en su ficha de <b>Personal</b>.</p>
      ${groups.length
        ? html`<div class="group-chips">${groups.map((g) => {
            const n = count(g);
            return html`<button type="button" class="chip-btn group-chip" data-group="${g}"
                aria-label="${g}${n === null ? '' : `, ${n} persona(s)`}">${g}${n === null ? '' : html`<small>${n}</small>`}</button>`;
          })}</div>
          <p class="hint">Toca un grupo para cambiarle el nombre o borrarlo.${people ? ' El número es cuántas personas lo tienen.' : ''}</p>`
        : html`<p class="hint">Aún no hay grupos. Añádelos uno a uno o créalos todos a la vez.</p>`}
      <form class="add-row" data-add-group novalidate>
        <input name="group" maxlength="80" placeholder="Ej. 9-B" autocomplete="off" aria-label="Grupo nuevo (o varios separados por comas)">
        <button class="btn btn-secondary" type="submit">${icon('plus', 16)} Añadir</button>
      </form>
      <button type="button" class="btn btn-ghost btn-sm" data-bulk>${icon('grid', 16)} Crear varios grados a la vez</button>
    </section>`;
  };

  const render = () => {
    el.innerHTML = String(html`<div class="stack">${groupsCard()}</div>`);
    bind();
  };

  const groupsChanged = (groups, message) => {
    setGroups(groups);
    toast(message, 'ok');
    render();
  };

  function bind() {
    const add = $('[data-add-group]', el);
    add?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(add.querySelector('[type=submit]'), async () => {
        const names = add.group.value.split(',').map((g) => g.trim()).filter(Boolean);
        if (!names.length) throw new Error('Escribe el grupo, por ejemplo 9-B.');
        const before = schoolCalendar(state.me.school).groups.length;
        const groups = await addSchoolGroups(names);
        const added = groups.length - before;
        groupsChanged(groups, added ? `${added === 1 ? 'Grupo añadido' : `${added} grupos añadidos`}` : 'Ese grupo ya existía');
      });
    });

    $('[data-bulk]', el)?.addEventListener('click', async () => {
      const options = (selected) => GRADES.map((g) => html`<option value="${g}" ${g === selected ? 'selected' : ''}>${g}</option>`);
      const groups = await dialog({
        title: 'Crear varios grados a la vez',
        body: html`<div class="stack">
          <div class="grid2">
            <label class="field"><span>Del grado</span><select name="from">${options('7')}</select></label>
            <label class="field"><span>Al grado</span><select name="to">${options('12')}</select></label>
          </div>
          <label class="field"><span>Grupos de cada grado</span>
            <input name="letters" value="A, B, C" maxlength="60" autocomplete="off" placeholder="A, B, C"></label>
          <p class="hint" data-bulk-preview></p>
        </div>`,
        confirmText: 'Crear grupos',
        onOpen(dlg) {
          const preview = () => {
            const v = Object.fromEntries(new FormData(dlg.querySelector('form')));
            const names = bulkNames(v.from, v.to, v.letters);
            dlg.querySelector('[data-bulk-preview]').textContent = names.length
              ? `Se crearán ${names.length} grupos: ${names.length > 6 ? `${names.slice(0, 3).join(', ')} … ${names.slice(-2).join(', ')}` : names.join(', ')}.`
              : 'Escribe las letras de los grupos, por ejemplo A, B, C.';
          };
          dlg.querySelector('form').addEventListener('input', preview);
          preview();
        },
        onSubmit: (v) => {
          const names = bulkNames(v.from, v.to, v.letters);
          if (!names.length) throw new Error('Escribe las letras de los grupos, por ejemplo A, B, C.');
          return addSchoolGroups(names);
        },
      });
      if (groups) groupsChanged(groups, 'Grupos creados');
    });

    for (const chip of el.querySelectorAll('[data-group]')) {
      chip.addEventListener('click', async () => {
        const name = chip.dataset.group;
        const n = people?.filter((p) => p.groups?.includes(name)).length ?? 0;
        let removed = false;
        const result = await dialog({
          title: `Grupo ${name}`,
          body: html`<div class="stack">
            <label class="field"><span>Nombre</span>
              <input name="name" maxlength="20" required value="${name}" autocomplete="off"></label>
            <p class="hint">Si le cambias el nombre, las personas que lo tienen lo conservan con el nombre nuevo.</p>
            <button type="button" class="btn btn-ghost-danger btn-sm" data-remove-group>${icon('trash', 16)} Borrar grupo</button>
          </div>`,
          confirmText: 'Guardar',
          onOpen(dlg) {
            dlg.querySelector('[data-remove-group]').addEventListener('click', async () => {
              const ok = await dialog({
                title: `¿Borrar el grupo ${name}?`,
                message: n ? `Se quitará a las ${n} persona(s) que lo tienen.` : 'Se quitará a las personas que lo tengan.',
                confirmText: 'Borrar',
                danger: true,
              });
              if (!ok) return;
              try {
                const groups = await removeSchoolGroup(name);
                removed = true;
                setGroups(groups);
                dlg.dispatchEvent(new Event('cancel'));
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          },
          onSubmit: (v) => {
            const next = v.name.trim().replace(/\s+/g, ' ');
            if (!next) throw new Error('Escribe el nombre del grupo.');
            return next === name ? schoolCalendar(state.me.school).groups : renameSchoolGroup(name, next);
          },
        });
        if (removed) {
          if (people) people = people.map((p) => ({ ...p, groups: (p.groups || []).filter((g) => g !== name) }));
          toast('Grupo borrado', 'ok');
          render();
        } else if (result) {
          if (people) await loadPeople();
          groupsChanged(result, 'Grupo guardado');
        }
      });
    }
  }

  async function loadPeople() {
    people = (await listEmployees()).filter((p) => p.active);
  }

  // Group counts for those who see the whole staff (they also assign the groups).
  if (isStaff(user) || can(user, 'staff')) await loadPeople().catch(() => (people = null));
  if (!isCurrent()) return;
  render();
}

/** Text for the absence form when the chosen days include days without classes. */
export function closureNote(closures, start, end = start) {
  const hits = closures.filter((c) => c.start_date <= end && c.end_date >= start);
  if (!hits.length) return '';
  if (start === end) {
    const c = hits[0];
    return c.kind === 'holiday'
      ? `Ese día es feriado en la escuela (${c.name}).`
      : `Ese día no hay estudiantes (${c.name}). El personal trabaja.`;
  }
  return `Incluye días sin clases: ${hits.map((c) => `${c.name} (${closureDates(c)})`).join('; ')}.`;
}
