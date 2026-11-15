const state = {
  areas: [],
  tables: [],
  combinations: [],
  opening_hours: [],
  closures: [],
  rules: null
};
let selectedTableId = null;
let dirty = false;

const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const shapeNames = { round: 'Redonda', square: 'Cuadrada', rectangle: 'Rectangular', booth: 'Banco' };
const statusNode = document.querySelector('#save-status');
const saveButton = document.querySelector('#save-setup');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function setDirty(message = 'Hay cambios sin guardar.') {
  dirty = true;
  saveButton.disabled = false;
  statusNode.textContent = message;
  statusNode.classList.add('is-dirty');
}

function setSaved(message) {
  dirty = false;
  saveButton.disabled = false;
  statusNode.textContent = message;
  statusNode.classList.remove('is-dirty');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function openView(name) {
  const labels = { sala: 'Sala y mesas', horarios: 'Horarios', cierres: 'Cierres especiales', reglas: 'Reglas de reserva' };
  for (const section of document.querySelectorAll('.admin-view')) section.hidden = section.id !== `view-${name}`;
  for (const button of document.querySelectorAll('[data-view-target]')) {
    const active = button.dataset.viewTarget === name;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.querySelector('#page-title').textContent = labels[name] ?? labels.sala;
  if (window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function currentAreaFilter() {
  return document.querySelector('#area-filter').value || 'all';
}

function renderAreas() {
  const filter = document.querySelector('#area-filter');
  const previousValue = filter.value;
  filter.innerHTML = `<option value="all">Todas las zonas</option>${state.areas.map(area => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join('')}`;
  if ([...filter.options].some(option => option.value === previousValue)) filter.value = previousValue;
  const areaSelect = document.querySelector('#table-form [name="area_id"]');
  areaSelect.innerHTML = state.areas.map(area => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join('');
}

function renderTables() {
  const filter = currentAreaFilter();
  const tables = state.tables.filter(table => filter === 'all' || table.area_id === filter);
  const floor = document.querySelector('#floor-plan');
  floor.innerHTML = tables.map(table => {
    const area = state.areas.find(candidate => candidate.id === table.area_id);
    const selected = table.id === selectedTableId;
    return `<button class="table-marker table-${escapeHtml(table.shape)}${selected ? ' is-selected' : ''}${table.active ? '' : ' is-inactive'}" type="button" data-table-id="${escapeHtml(table.id)}" aria-label="${escapeHtml(table.display_name || table.table_code)}, ${table.min_capacity} a ${table.max_capacity} personas, ${escapeHtml(area?.name || 'zona sin nombre')}" style="left:${Number(table.x)}%;top:${Number(table.y)}%;transform:translate(-50%,-50%) rotate(${Number(table.rotation || 0)}deg)">
      <span>${escapeHtml(table.display_name || table.table_code)}</span><small>${table.min_capacity}–${table.max_capacity}</small>
    </button>`;
  }).join('') || '<p class="floor-empty">Añade mesas para empezar a dibujar el plano.</p>';

  document.querySelector('#table-summary').textContent = `${state.tables.filter(table => table.active).length} mesas activas · ${state.tables.length} configuradas`;
  const tableList = document.querySelector('#table-list');
  tableList.innerHTML = tables.map(table => {
    const area = state.areas.find(candidate => candidate.id === table.area_id);
    return `<button class="table-list-item${selectedTableId === table.id ? ' is-selected' : ''}" type="button" data-table-id="${escapeHtml(table.id)}"><span><strong>${escapeHtml(table.display_name || table.table_code)}</strong><small>${escapeHtml(area?.name || 'Zona sin nombre')}</small></span><span class="capacity-chip">${table.min_capacity}–${table.max_capacity}</span></button>`;
  }).join('') || '<p class="muted list-empty">No hay mesas en esta zona.</p>';

  document.querySelectorAll('[data-table-id]').forEach(button => {
    button.addEventListener('click', () => selectTable(button.dataset.tableId));
    if (button.classList.contains('table-marker')) {
      button.addEventListener('keydown', event => {
        const delta = event.shiftKey ? 5 : 1;
        let { x, y } = state.tables.find(table => table.id === button.dataset.tableId);
        if (event.key === 'ArrowLeft') x = Math.max(0, Number(x) - delta);
        else if (event.key === 'ArrowRight') x = Math.min(100, Number(x) + delta);
        else if (event.key === 'ArrowUp') y = Math.max(0, Number(y) - delta);
        else if (event.key === 'ArrowDown') y = Math.min(100, Number(y) + delta);
        else return;
        event.preventDefault();
        updateTablePosition(button.dataset.tableId, x, y);
      });
    }
  });
  renderSelectedTable();
}

function renderSelectedTable() {
  const table = state.tables.find(candidate => candidate.id === selectedTableId);
  const title = document.querySelector('#selected-table-title');
  const description = document.querySelector('#selected-table-description');
  const edit = document.querySelector('#edit-table');
  const deactivate = document.querySelector('#deactivate-table');
  if (!table) {
    title.textContent = 'Selecciona una mesa';
    description.textContent = 'Aquí podrás ajustar su zona, capacidad, forma y posición.';
    edit.disabled = true;
    deactivate.disabled = true;
    return;
  }
  const area = state.areas.find(candidate => candidate.id === table.area_id);
  title.textContent = table.display_name || table.table_code;
  description.textContent = `${table.min_capacity}–${table.max_capacity} personas · ${shapeNames[table.shape]} · ${area?.name || 'Zona sin nombre'}${table.active ? '' : ' · desactivada'}`;
  edit.disabled = false;
  deactivate.disabled = false;
  deactivate.textContent = table.active ? 'Desactivar mesa' : 'Reactivar mesa';
}

function selectTable(id) {
  selectedTableId = id;
  renderTables();
}

function updateTablePosition(id, x, y) {
  const table = state.tables.find(candidate => candidate.id === id);
  if (!table) return;
  table.x = x;
  table.y = y;
  setDirty();
  renderTables();
}

function renderCombinations() {
  const node = document.querySelector('#combination-list');
  node.innerHTML = state.combinations.map(combo => {
    const names = combo.table_ids.map(id => state.tables.find(table => table.id === id)?.display_name || state.tables.find(table => table.id === id)?.table_code || 'Mesa retirada');
    return `<article class="combination-item"><div><strong>${escapeHtml(combo.name)}</strong><p>${escapeHtml(names.join(' + '))} · hasta ${Number(combo.max_capacity)} personas</p></div><button class="text-button danger-text" type="button" data-remove-combo="${escapeHtml(combo.id)}">Quitar</button></article>`;
  }).join('') || '<p class="muted list-empty">Aún no hay uniones de mesas configuradas.</p>';
  node.querySelectorAll('[data-remove-combo]').forEach(button => button.addEventListener('click', () => {
    state.combinations = state.combinations.filter(combo => combo.id !== button.dataset.removeCombo);
    setDirty();
    renderCombinations();
  }));
}

function renderHours() {
  const node = document.querySelector('#hours-list');
  const sorted = [...state.opening_hours].sort((a, b) => Number(a.weekday) - Number(b.weekday) || a.opens_at_local.localeCompare(b.opens_at_local));
  node.innerHTML = sorted.map(hour => {
    const index = state.opening_hours.indexOf(hour);
    return `<article class="hours-row" data-hour-index="${index}">
      <label>Día<select data-field="weekday">${weekdays.map((day, dayIndex) => `<option value="${dayIndex}"${Number(hour.weekday) === dayIndex ? ' selected' : ''}>${day}</option>`).join('')}</select></label>
      <label>Servicio<input data-field="service_name" value="${escapeHtml(hour.service_name)}" maxlength="40"></label>
      <label>Abre<input data-field="opens_at_local" type="time" value="${escapeHtml(hour.opens_at_local)}"></label>
      <label>Cierra<input data-field="closes_at_local" type="time" value="${escapeHtml(hour.closes_at_local)}"></label>
      <label class="check-row hours-active"><input data-field="active" type="checkbox"${hour.active ? ' checked' : ''}> Abierto</label>
      <button class="icon-button remove-hour" type="button" aria-label="Eliminar turno de ${weekdays[Number(hour.weekday)]}">×</button>
    </article>`;
  }).join('') || '<p class="muted list-empty">No hay turnos; el local aparecerá como cerrado.</p>';
  node.querySelectorAll('.hours-row').forEach(row => {
    const hour = state.opening_hours[Number(row.dataset.hourIndex)];
    row.querySelectorAll('[data-field]').forEach(field => field.addEventListener('change', () => {
      const name = field.dataset.field;
      hour[name] = field.type === 'checkbox' ? field.checked : name === 'weekday' ? Number(field.value) : field.value;
      setDirty();
      if (name === 'weekday' || name === 'active') renderHours();
    }));
    row.querySelector('.remove-hour').addEventListener('click', () => {
      state.opening_hours.splice(Number(row.dataset.hourIndex), 1);
      setDirty();
      renderHours();
    });
  });
}

function renderClosures() {
  const node = document.querySelector('#closures-list');
  const sorted = [...state.closures].sort((a, b) => a.closure_date_local.localeCompare(b.closure_date_local));
  node.innerHTML = sorted.map(closure => {
    const description = closure.starts_at_local && closure.ends_at_local
      ? `${closure.starts_at_local}–${closure.ends_at_local}`
      : 'Todo el día';
    const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(new Date(`${closure.closure_date_local}T12:00:00`));
    return `<article class="closure-row"><div><strong>${escapeHtml(date)}</strong><p>${escapeHtml(description)}${closure.reason ? ` · ${escapeHtml(closure.reason)}` : ''}</p></div><button class="text-button danger-text" type="button" data-remove-closure="${escapeHtml(closure.id)}">Eliminar</button></article>`;
  }).join('') || '<p class="muted list-empty">No hay cierres especiales configurados.</p>';
  node.querySelectorAll('[data-remove-closure]').forEach(button => button.addEventListener('click', () => {
    state.closures = state.closures.filter(closure => closure.id !== button.dataset.removeClosure);
    setDirty();
    renderClosures();
  }));
}

function fillRules() {
  if (!state.rules) return;
  const form = document.querySelector('#rules-form');
  for (const [name, value] of Object.entries(state.rules)) {
    const field = form.elements.namedItem(name);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
    field.addEventListener('change', () => {
      state.rules[name] = field.type === 'checkbox' ? field.checked : Number(field.value);
      setDirty();
    });
  }
}

function refresh() {
  renderAreas();
  renderTables();
  renderCombinations();
  renderHours();
  renderClosures();
  fillRules();
}

function editTable(table) {
  const form = document.querySelector('#table-form');
  form.reset();
  form.elements.id.value = table?.id ?? '';
  if (table) {
    for (const key of ['area_id', 'table_code', 'display_name', 'min_capacity', 'max_capacity', 'shape', 'x', 'y', 'rotation']) form.elements[key].value = table[key] ?? '';
    form.elements.active.checked = Boolean(table.active);
  } else {
    form.elements.area_id.value = state.areas[0]?.id ?? '';
    form.elements.table_code.value = `M${state.tables.length + 1}`;
    form.elements.active.checked = true;
  }
  document.querySelector('#table-dialog-title').textContent = table ? 'Editar mesa' : 'Añadir mesa';
  document.querySelector('#table-dialog').showModal();
}

function saveTableFromDialog() {
  const form = document.querySelector('#table-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const id = data.get('id') || newId('table');
  const table = {
    id,
    area_id: data.get('area_id'),
    table_code: String(data.get('table_code')).trim(),
    display_name: String(data.get('display_name') || '').trim() || null,
    min_capacity: Number(data.get('min_capacity')),
    max_capacity: Number(data.get('max_capacity')),
    shape: data.get('shape'),
    x: Number(data.get('x')),
    y: Number(data.get('y')),
    rotation: Number(data.get('rotation') || 0),
    active: form.elements.active.checked,
    sort_order: state.tables.find(existing => existing.id === id)?.sort_order ?? state.tables.length
  };
  if (table.max_capacity < table.min_capacity) {
    statusNode.textContent = 'La capacidad máxima debe ser igual o mayor que la mínima.';
    return;
  }
  const index = state.tables.findIndex(existing => existing.id === id);
  if (index === -1) state.tables.push(table);
  else state.tables[index] = table;
  selectedTableId = id;
  document.querySelector('#table-dialog').close();
  setDirty();
  renderTables();
}

function addHours() {
  state.opening_hours.push({
    id: newId('hours'), weekday: 3, service_name: 'Comida',
    opens_at_local: '12:00', closes_at_local: '16:00', active: true
  });
  setDirty();
  renderHours();
}

function saveClosureFromDialog() {
  const form = document.querySelector('#closure-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const allDay = form.elements.all_day.checked;
  state.closures.push({
    id: newId('closure'),
    closure_date_local: data.get('closure_date_local'),
    starts_at_local: allDay ? null : data.get('starts_at_local'),
    ends_at_local: allDay ? null : data.get('ends_at_local'),
    reason: String(data.get('reason') || '').trim() || null
  });
  document.querySelector('#closure-dialog').close();
  setDirty();
  renderClosures();
}

function saveCombination() {
  const form = document.querySelector('#combo-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const tableIds = [...form.querySelectorAll('[name="table_ids"]:checked')].map(input => input.value);
  if (tableIds.length < 2) {
    statusNode.textContent = 'Selecciona al menos 2 mesas para crear una unión.';
    return;
  }
  state.combinations.push({
    id: newId('combo'), name: String(data.get('name')).trim(),
    max_capacity: Number(data.get('max_capacity')), active: true, table_ids: tableIds
  });
  document.querySelector('#combo-dialog').close();
  setDirty();
  renderCombinations();
}

async function saveSetup() {
  saveButton.disabled = true;
  statusNode.textContent = 'Guardando configuración…';
  try {
    const result = await requestJson('/api/admin/setup', {
      method: 'PUT',
      body: JSON.stringify(state)
    });
    Object.assign(state, result.setup);
    setSaved('Configuración guardada.');
    refresh();
  } catch (error) {
    statusNode.textContent = error.message;
    statusNode.classList.add('is-error');
    saveButton.disabled = false;
  }
}

async function syncLoyverse() {
  const button = document.querySelector('#sync-loyverse');
  button.disabled = true;
  button.textContent = 'Actualizando…';
  try {
    const result = await requestJson('/api/admin/integrations/loyverse/sync', { method: 'POST' });
    statusNode.textContent = `${result.items} productos consultados · carta actualizada`;
    statusNode.classList.remove('is-error', 'is-dirty');
    await refreshPublicMenuStatus();
  } catch (error) {
    statusNode.textContent = error.message;
    statusNode.classList.add('is-error');
  } finally {
    button.disabled = false;
    button.textContent = 'Actualizar carta';
  }
}

async function refreshPublicMenuStatus() {
  try {
    const response = await fetch('/api/public/menu', { headers: { accept: 'application/json' } });
    if (response.ok) {
      const menu = await response.json();
      statusNode.textContent = `Precios sincronizados · ${menu.items.length} productos`;
      statusNode.classList.remove('is-error');
    }
  } catch { /* status remains as returned by sync */ }
}

async function loadSetup() {
  statusNode.textContent = 'Cargando configuración…';
  try {
    const data = await requestJson('/api/admin/setup');
    Object.assign(state, data);
    refresh();
    setSaved('Configuración cargada.');
  } catch (error) {
    statusNode.textContent = error.message;
    statusNode.classList.add('is-error');
    saveButton.disabled = true;
  }
}

document.querySelectorAll('[data-view-target]').forEach(button => button.addEventListener('click', () => openView(button.dataset.viewTarget)));
document.querySelector('#area-filter').addEventListener('change', renderTables);
document.querySelector('#save-setup').addEventListener('click', saveSetup);
document.querySelector('#sync-loyverse').addEventListener('click', syncLoyverse);
document.querySelector('#add-table').addEventListener('click', () => editTable(null));
document.querySelector('#edit-table').addEventListener('click', () => editTable(state.tables.find(table => table.id === selectedTableId)));
document.querySelector('#deactivate-table').addEventListener('click', () => {
  const table = state.tables.find(candidate => candidate.id === selectedTableId);
  if (!table) return;
  table.active = !table.active;
  setDirty();
  renderTables();
});
document.querySelector('#save-table').addEventListener('click', saveTableFromDialog);
document.querySelector('#add-area').addEventListener('click', () => document.querySelector('#area-dialog').showModal());
document.querySelector('#save-area').addEventListener('click', () => {
  const form = document.querySelector('#area-form');
  if (!form.reportValidity()) return;
  state.areas.push({ id: newId('area'), name: String(new FormData(form).get('name')).trim(), sort_order: state.areas.length, active: true });
  document.querySelector('#area-dialog').close();
  setDirty();
  renderAreas();
});
document.querySelector('#add-combination').addEventListener('click', () => {
  const form = document.querySelector('#combo-form');
  form.reset();
  document.querySelector('#combo-table-options').innerHTML = state.tables.filter(table => table.active).map(table => `
    <label><input type="checkbox" name="table_ids" value="${escapeHtml(table.id)}"> ${escapeHtml(table.display_name || table.table_code)} · ${table.max_capacity} plazas</label>
  `).join('') || '<p class="muted">Crea las mesas antes de definir uniones.</p>';
  document.querySelector('#combo-dialog').showModal();
});
document.querySelector('#save-combo').addEventListener('click', saveCombination);
document.querySelector('#add-hours').addEventListener('click', addHours);
document.querySelector('#add-closure').addEventListener('click', () => {
  const form = document.querySelector('#closure-form');
  form.reset();
  form.elements.all_day.checked = true;
  document.querySelector('.closure-times').hidden = true;
  document.querySelector('#closure-dialog').showModal();
});
document.querySelector('#closure-form [name="all_day"]').addEventListener('change', event => {
  document.querySelector('.closure-times').hidden = event.target.checked;
});
document.querySelector('#save-closure').addEventListener('click', saveClosureFromDialog);
document.querySelector('#rules-form').addEventListener('input', () => setDirty());
document.querySelector('#rules-form').addEventListener('change', event => {
  const field = event.target;
  if (!field.name || !state.rules) return;
  state.rules[field.name] = field.type === 'checkbox' ? field.checked : Number(field.value);
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
}
window.addEventListener('beforeunload', event => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
const initialView = window.location.hash.slice(1);
openView(['sala', 'horarios', 'cierres', 'reglas'].includes(initialView) ? initialView : 'sala');
loadSetup();
