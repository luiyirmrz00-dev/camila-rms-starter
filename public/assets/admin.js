const state = {
  areas: [],
  tables: [],
  floor_elements: [],
  combinations: [],
  opening_hours: [],
  special_openings: [],
  closures: [],
  menu_categories: [],
  rules: null
};
let selectedTableId = null;
let selectedFloorElementId = null;
let dirty = false;
let drawing = null;

const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const shapeNames = { round: 'Redonda', square: 'Cuadrada', rectangle: 'Rectangular', booth: 'Banco' };
const floorElementNames = { wall: 'Pared', bar: 'Barra', entrance: 'Acceso', window: 'Ventana', column: 'Columna' };
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
  const labels = { sala: 'Sala y mesas', horarios: 'Horarios', cierres: 'Calendario especial', reglas: 'Reglas de reserva', carta: 'Carta' };
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
  const elements = (state.floor_elements || []).filter(element => filter === 'all' || element.area_id === filter);
  const floor = document.querySelector('#floor-plan');
  const elementsMarkup = elements.map(element => `<button class="floor-element floor-${escapeHtml(element.kind)}${selectedFloorElementId === element.id ? ' is-selected' : ''}" type="button" data-floor-element-id="${escapeHtml(element.id)}" aria-label="${escapeHtml(element.label || floorElementNames[element.kind] || 'Elemento del plano')}" style="left:${Number(element.x)}%;top:${Number(element.y)}%;width:${Number(element.width)}%;height:${Number(element.height)}%"><span>${escapeHtml(element.label || floorElementNames[element.kind] || '')}</span></button>`).join('');
  const tablesMarkup = tables.map(table => {
    const area = state.areas.find(candidate => candidate.id === table.area_id);
    const selected = table.id === selectedTableId;
    return `<button class="table-marker table-${escapeHtml(table.shape)}${selected ? ' is-selected' : ''}${table.active ? '' : ' is-inactive'}" type="button" data-table-id="${escapeHtml(table.id)}" aria-label="${escapeHtml(table.display_name || table.table_code)}, ${table.min_capacity} a ${table.max_capacity} personas, ${escapeHtml(area?.name || 'zona sin nombre')}" style="left:${Number(table.x)}%;top:${Number(table.y)}%;transform:translate(-50%,-50%) rotate(${Number(table.rotation || 0)}deg)">
      <span>${escapeHtml(table.display_name || table.table_code)}</span><small>${table.min_capacity}–${table.max_capacity}</small>
    </button>`;
  }).join('');
  floor.innerHTML = `${elementsMarkup}${tablesMarkup}${tables.length ? '' : '<p class="floor-empty">Añade mesas para empezar a dibujar el plano.</p>'}`;

  document.querySelector('#table-summary').textContent = `${state.tables.filter(table => table.active).length} mesas activas · ${state.tables.length} configuradas`;
  const tableList = document.querySelector('#table-list');
  tableList.innerHTML = tables.map(table => {
    const area = state.areas.find(candidate => candidate.id === table.area_id);
    return `<button class="table-list-item${selectedTableId === table.id ? ' is-selected' : ''}" type="button" data-table-id="${escapeHtml(table.id)}"><span><strong>${escapeHtml(table.display_name || table.table_code)}</strong><small>${escapeHtml(area?.name || 'Zona sin nombre')}</small></span><span class="capacity-chip">${table.min_capacity}–${table.max_capacity}</span></button>`;
  }).join('') || '<p class="muted list-empty">No hay mesas en esta zona.</p>';

  document.querySelectorAll('[data-table-id]').forEach(button => {
    button.addEventListener('click', () => selectTable(button.dataset.tableId));
    if (button.classList.contains('table-marker')) {
      button.addEventListener('pointerdown', event => {
        if (document.querySelector('#floor-tool').value !== 'select' || event.button !== 0) return;
        event.preventDefault();
        selectedTableId = button.dataset.tableId;
        selectedFloorElementId = null;
        renderSelectedTable();
        document.querySelectorAll('.table-marker').forEach(marker => marker.classList.toggle('is-selected', marker.dataset.tableId === selectedTableId));
        const table = state.tables.find(candidate => candidate.id === selectedTableId);
        const floorRect = floor.getBoundingClientRect();
        const startX = (event.clientX - floorRect.left) / floorRect.width * 100;
        const startY = (event.clientY - floorRect.top) / floorRect.height * 100;
        const offsetX = Number(table?.x ?? 50) - startX;
        const offsetY = Number(table?.y ?? 50) - startY;
        let moved = false;
        button.setPointerCapture(event.pointerId);
        const onMove = moveEvent => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const x = Math.max(2, Math.min(98, (moveEvent.clientX - floorRect.left) / floorRect.width * 100 + offsetX));
          const y = Math.max(2, Math.min(98, (moveEvent.clientY - floorRect.top) / floorRect.height * 100 + offsetY));
          if (Math.abs(x - startX) > 0.2 || Math.abs(y - startY) > 0.2) moved = true;
          if (!moved || !table) return;
          table.x = x;
          table.y = y;
          button.style.left = `${x}%`;
          button.style.top = `${y}%`;
        };
        const onEnd = endEvent => {
          if (endEvent.pointerId !== event.pointerId) return;
          button.removeEventListener('pointermove', onMove);
          button.removeEventListener('pointerup', onEnd);
          button.removeEventListener('pointercancel', onEnd);
          if (moved) {
            setDirty();
            renderTables();
          }
        };
        button.addEventListener('pointermove', onMove);
        button.addEventListener('pointerup', onEnd);
        button.addEventListener('pointercancel', onEnd);
      });
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
  floor.querySelectorAll('[data-floor-element-id]').forEach(button => button.addEventListener('click', () => {
    selectedFloorElementId = button.dataset.floorElementId;
    selectedTableId = null;
    renderTables();
  }));
  renderSelectedTable();
}

function renderSelectedTable() {
  const table = state.tables.find(candidate => candidate.id === selectedTableId);
  const title = document.querySelector('#selected-table-title');
  const description = document.querySelector('#selected-table-description');
  const edit = document.querySelector('#edit-table');
  const deactivate = document.querySelector('#deactivate-table');
  const removeElement = document.querySelector('#remove-floor-element');
  const rotationControl = document.querySelector('#table-rotation-control');
  const rotationSelect = document.querySelector('#selected-table-rotation');
  const element = (state.floor_elements || []).find(candidate => candidate.id === selectedFloorElementId);
  if (element) {
    title.textContent = element.label || floorElementNames[element.kind] || 'Elemento del plano';
    description.textContent = `Elemento dibujado en la zona ${state.areas.find(area => area.id === element.area_id)?.name || 'sin nombre'}.`;
    edit.disabled = true;
    deactivate.disabled = true;
    removeElement.hidden = false;
    rotationControl.hidden = true;
    return;
  }
  removeElement.hidden = true;
  if (!table) {
    title.textContent = 'Selecciona una mesa';
    description.textContent = 'Aquí podrás ajustar su zona, capacidad, forma y posición.';
    edit.disabled = true;
    deactivate.disabled = true;
    rotationControl.hidden = true;
    return;
  }
  const area = state.areas.find(candidate => candidate.id === table.area_id);
  title.textContent = table.display_name || table.table_code;
  description.textContent = `${table.min_capacity}–${table.max_capacity} personas · ${shapeNames[table.shape]} · ${area?.name || 'Zona sin nombre'}${table.active ? '' : ' · desactivada'}`;
  edit.disabled = false;
  deactivate.disabled = false;
  deactivate.textContent = table.active ? 'Desactivar mesa' : 'Reactivar mesa';
  rotationControl.hidden = false;
  rotationSelect.value = String(Number(table.rotation || 0));
}

function selectTable(id) {
  selectedTableId = id;
  selectedFloorElementId = null;
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

function floorPoint(event, rect) {
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
  };
}

function updateDrawingPreview(event) {
  if (!drawing || event.pointerId !== drawing.pointerId) return;
  const point = floorPoint(event, drawing.rect);
  const endX = Math.min(drawing.rect.width, Math.max(0, Math.round(point.x / 34) * 34));
  const endY = Math.min(drawing.rect.height, Math.max(0, Math.round(point.y / 34) * 34));
  drawing.currentX = endX;
  drawing.currentY = endY;
  const left = Math.min(drawing.startX, endX);
  const top = Math.min(drawing.startY, endY);
  const width = Math.max(34, Math.abs(endX - drawing.startX));
  const height = Math.max(34, Math.abs(endY - drawing.startY));
  Object.assign(drawing.preview.style, {
    left: `${left / drawing.rect.width * 100}%`, top: `${top / drawing.rect.height * 100}%`,
    width: `${Math.min(width, drawing.rect.width - left) / drawing.rect.width * 100}%`,
    height: `${Math.min(height, drawing.rect.height - top) / drawing.rect.height * 100}%`
  });
}

function finishDrawing(event) {
  if (!drawing || event.pointerId !== drawing.pointerId) return;
  const activeDrawing = drawing;
  drawing = null;
  const point = floorPoint(event, activeDrawing.rect);
  const endX = Math.min(activeDrawing.rect.width, Math.max(0, Math.round(point.x / 34) * 34));
  const endY = Math.min(activeDrawing.rect.height, Math.max(0, Math.round(point.y / 34) * 34));
  const left = Math.min(activeDrawing.startX, endX);
  const top = Math.min(activeDrawing.startY, endY);
  const width = Math.min(Math.max(34, Math.abs(endX - activeDrawing.startX)), activeDrawing.rect.width - left);
  const height = Math.min(Math.max(34, Math.abs(endY - activeDrawing.startY)), activeDrawing.rect.height - top);
  activeDrawing.preview.remove();
  const element = {
    id: newId('floor'), area_id: activeDrawing.areaId, kind: activeDrawing.kind,
    label: floorElementNames[activeDrawing.kind],
    x: left / activeDrawing.rect.width * 100, y: top / activeDrawing.rect.height * 100,
    width: width / activeDrawing.rect.width * 100, height: height / activeDrawing.rect.height * 100
  };
  state.floor_elements.push(element);
  selectedFloorElementId = element.id;
  selectedTableId = null;
  setDirty();
  renderTables();
}

function cancelDrawing(event) {
  if (!drawing || event.pointerId !== drawing.pointerId) return;
  drawing.preview.remove();
  drawing = null;
}

function startDrawing(event) {
  const floor = document.querySelector('#floor-plan');
  const kind = document.querySelector('#floor-tool').value;
  if (kind === 'select' || (event.target !== floor && !event.target.classList.contains('floor-empty'))) return;
  if (event.button !== 0) return;
  const areaId = currentAreaFilter();
  if (areaId === 'all') {
    statusNode.textContent = 'Selecciona una zona antes de dibujar sus elementos.';
    return;
  }
  event.preventDefault();
  const rect = floor.getBoundingClientRect();
  const point = floorPoint(event, rect);
  const grid = 34;
  const startX = Math.min(rect.width - grid, Math.max(0, Math.round(point.x / grid) * grid));
  const startY = Math.min(rect.height - grid, Math.max(0, Math.round(point.y / grid) * grid));
  const preview = document.createElement('div');
  preview.className = `floor-element floor-${kind} is-drawing`;
  floor.append(preview);
  drawing = { kind, areaId, rect, pointerId: event.pointerId, startX, startY, currentX: startX, currentY: startY, preview };
  floor.setPointerCapture(event.pointerId);
  updateDrawingPreview(event);
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
  const rows = [...state.closures].map(closure => {
    const description = closure.starts_at_local && closure.ends_at_local
      ? `${closure.starts_at_local}–${closure.ends_at_local}`
      : 'Todo el día';
    const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(new Date(`${closure.closure_date_local}T12:00:00`));
    return { date: closure.closure_date_local, html: `<article class="closure-row"><div><span class="exception-badge is-closed">Cierre</span><strong>${escapeHtml(date)}</strong><p>${escapeHtml(description)}${closure.reason ? ` · ${escapeHtml(closure.reason)}` : ''}</p></div><button class="text-button danger-text" type="button" data-remove-closure="${escapeHtml(closure.id)}">Eliminar</button></article>` };
  });
  rows.push(...(state.special_openings || []).map(opening => {
    const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(new Date(`${opening.opening_date_local}T12:00:00`));
    return { date: opening.opening_date_local, html: `<article class="closure-row"><div><span class="exception-badge is-open">Apertura</span><strong>${escapeHtml(date)}</strong><p>${escapeHtml(opening.service_name)} · ${escapeHtml(opening.opens_at_local)}–${escapeHtml(opening.closes_at_local)}</p></div><button class="text-button danger-text" type="button" data-remove-special-opening="${escapeHtml(opening.id)}">Eliminar</button></article>` };
  }));
  node.innerHTML = rows.sort((a, b) => a.date.localeCompare(b.date)).map(row => row.html).join('') || '<p class="muted list-empty">No hay aperturas ni cierres especiales configurados.</p>';
  node.querySelectorAll('[data-remove-closure]').forEach(button => button.addEventListener('click', () => {
    state.closures = state.closures.filter(closure => closure.id !== button.dataset.removeClosure);
    setDirty();
    renderClosures();
  }));
  node.querySelectorAll('[data-remove-special-opening]').forEach(button => button.addEventListener('click', () => {
    state.special_openings = state.special_openings.filter(opening => opening.id !== button.dataset.removeSpecialOpening);
    setDirty();
    renderClosures();
  }));
}

function renderCatalogCategories() {
  const node = document.querySelector('#catalog-category-list');
  const count = document.querySelector('#catalog-category-count');
  const labels = { drinks: 'Bebidas', starters: 'Entrantes', food: 'Comida', desserts: 'Postres' };
  count.textContent = `${state.menu_categories.length} categorías`;
  node.innerHTML = state.menu_categories.map(category => `
    <label class="catalog-category-row">
      <span class="catalog-category-name"><strong>${escapeHtml(category.name)}</strong><small>${Number(category.product_count) || 0} productos activos</small></span>
      <span class="catalog-category-field"><span>Sección pública</span><select data-menu-category="${escapeHtml(category.id)}" aria-label="Sección pública de ${escapeHtml(category.name)}">
        ${Object.entries(labels).map(([value, label]) => `<option value="${value}"${category.public_section === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></span>
    </label>`).join('') || '<p class="muted list-empty">Aún no hay categorías. Pulsa «Actualizar carta» para sincronizarlas desde Loyverse.</p>';
  node.querySelectorAll('[data-menu-category]').forEach(select => select.addEventListener('change', () => {
    const category = state.menu_categories.find(item => item.id === select.dataset.menuCategory);
    if (!category) return;
    category.public_section = select.value;
    setDirty();
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
  renderCatalogCategories();
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
    const filteredArea = currentAreaFilter();
    form.elements.area_id.value = filteredArea !== 'all' ? filteredArea : state.areas[0]?.id ?? '';
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
  selectedFloorElementId = null;
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

function saveSpecialOpeningFromDialog() {
  const form = document.querySelector('#special-opening-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const opening = {
    id: newId('special-opening'),
    opening_date_local: data.get('opening_date_local'),
    service_name: String(data.get('service_name')).trim(),
    opens_at_local: data.get('opens_at_local'),
    closes_at_local: data.get('closes_at_local')
  };
  if (opening.closes_at_local <= opening.opens_at_local && opening.closes_at_local !== '00:00') {
    statusNode.textContent = 'La hora de cierre debe ser posterior a la apertura.';
    return;
  }
  state.special_openings.push(opening);
  document.querySelector('#special-opening-dialog').close();
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
    statusNode.classList.remove('is-error');
    if (!dirty) {
      const setup = await requestJson('/api/admin/setup');
      state.menu_categories = setup.menu_categories ?? [];
      renderCatalogCategories();
      await refreshPublicMenuStatus();
    } else {
      statusNode.textContent += ' · Guarda tus cambios de administración.';
    }
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
document.querySelector('#floor-tool').addEventListener('change', event => {
  document.querySelector('#floor-plan').classList.toggle('is-drawing-mode', event.target.value !== 'select');
  document.querySelector('#floor-help').textContent = event.target.value === 'select'
    ? 'Arrastra las mesas para colocarlas. Elige una herramienta para dibujar paredes, barra, acceso, ventanas o columnas.'
    : 'Selecciona una zona y arrastra sobre el plano para dibujar el elemento. Haz clic sobre un elemento para eliminarlo.';
});
document.querySelector('#floor-plan').addEventListener('pointerdown', startDrawing);
document.querySelector('#floor-plan').addEventListener('pointermove', updateDrawingPreview);
document.querySelector('#floor-plan').addEventListener('pointerup', finishDrawing);
document.querySelector('#floor-plan').addEventListener('pointercancel', cancelDrawing);
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
document.querySelector('#selected-table-rotation').addEventListener('change', event => {
  const table = state.tables.find(candidate => candidate.id === selectedTableId);
  if (!table) return;
  table.rotation = Number(event.target.value);
  setDirty();
  renderTables();
});
document.querySelector('#remove-floor-element').addEventListener('click', () => {
  if (!selectedFloorElementId) return;
  state.floor_elements = state.floor_elements.filter(element => element.id !== selectedFloorElementId);
  selectedFloorElementId = null;
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
document.querySelector('#add-special-opening').addEventListener('click', () => {
  const form = document.querySelector('#special-opening-form');
  form.reset();
  form.elements.service_name.value = 'Servicio especial';
  form.elements.opens_at_local.value = '12:00';
  form.elements.closes_at_local.value = '16:00';
  document.querySelector('#special-opening-dialog').showModal();
});
document.querySelector('#save-special-opening').addEventListener('click', saveSpecialOpeningFromDialog);
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
window.addEventListener('keydown', event => {
  if (!selectedFloorElementId || !['Delete', 'Backspace'].includes(event.key)) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  state.floor_elements = state.floor_elements.filter(element => element.id !== selectedFloorElementId);
  selectedFloorElementId = null;
  setDirty();
  renderTables();
});
const initialView = window.location.hash.slice(1);
openView(['sala', 'horarios', 'cierres', 'reglas', 'carta'].includes(initialView) ? initialView : 'sala');
loadSetup();
