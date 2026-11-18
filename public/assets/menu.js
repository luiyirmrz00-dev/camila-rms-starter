const nav = document.querySelector('#category-nav');
const content = document.querySelector('#menu-content');
const error = document.querySelector('#menu-error');
const empty = document.querySelector('#menu-empty');
const count = document.querySelector('#menu-count');
const syncStatus = document.querySelector('#menu-sync-status');
const search = document.querySelector('#menu-search');
const euro = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
search.value = new URLSearchParams(window.location.search).get('q') ?? '';

function safeJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');
}

function slug(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'otros';
}

function renderMenu(rows, currency = 'EUR') {
  if (!rows.length) {
    nav.replaceChildren();
    empty.hidden = true;
    content.hidden = false;
    nav.hidden = false;
    content.innerHTML = '<p class="loading-message">La carta se está preparando. Vuelve a consultarla pronto.</p>';
    count.textContent = '';
    return;
  }

  const formatter = currency === 'EUR'
    ? euro
    : new Intl.NumberFormat('es-ES', { style: 'currency', currency });
  const categories = new Map();
  const sectionDefinitions = [
    { id: 'drinks', name: 'Bebidas' },
    { id: 'starters', name: 'Entrantes' },
    { id: 'food', name: 'Comida' },
    { id: 'desserts', name: 'Postres' }
  ];

  for (const row of rows) {
    const key = row.category_id ?? 'uncategorized';
    if (!categories.has(key)) {
      categories.set(key, {
        section: sectionDefinitions.some(section => section.id === row.menu_section) ? row.menu_section : 'food',
        name: row.category_name ?? 'Otros',
        items: new Map()
      });
    }
    const category = categories.get(key);
    if (!category.items.has(row.item_id)) {
      const tags = [
        ...safeJson(row.dietary_tags_json),
        ...safeJson(row.allergens_json).map(value => `Alérgeno: ${value}`)
      ];
      category.items.set(row.item_id, {
        name: row.item_name,
        description: row.description,
        featured: Boolean(row.featured),
        tags,
        variants: []
      });
    }
    const item = category.items.get(row.item_id);
    if (row.variant_id) item.variants.push(row);
  }

  const entries = [...categories.entries()].map(([id, category], index) => ({
    id: `category-${slug(category.name)}-${index + 1}`,
    section: category.section,
    name: category.name,
    items: [...category.items.values()]
  }));

  const groups = sectionDefinitions.map(section => ({
    ...section,
    categories: entries.filter(category => category.section === section.id)
  })).filter(section => section.categories.length);

  nav.innerHTML = groups.map(section =>
    `<a href="#menu-${section.id}">${escapeHtml(section.name)}</a>`
  ).join('');

  content.innerHTML = groups.map(section => `
    <section class="menu-category" id="menu-${section.id}" data-menu-section="${section.id}">
      <div class="category-heading"><h3>${escapeHtml(section.name)}</h3><span class="category-count"></span></div>
      ${section.categories.map(category => {
        const items = category.items.map(item => {
          const searchText = normalize([
            section.name,
            category.name,
            item.name,
            item.description,
            ...item.tags,
            ...item.variants.map(variant => variant.variant_name)
          ].join(' '));
          const price = item.variants.length === 1 && item.variants[0].price_minor != null
            ? `<span class="item-price">${formatter.format(item.variants[0].price_minor / 100)}</span>`
            : '';
          const variants = item.variants.length > 1
            ? `<div class="item-variants">${item.variants.map(variant => `
                <div class="variant-row">
                  <span class="variant-name">${escapeHtml(variant.variant_name)}</span>
                  <span class="variant-price">${variant.price_minor == null ? '' : formatter.format(variant.price_minor / 100)}</span>
                </div>`).join('')}
              </div>`
            : '';
          const description = item.description
            ? `<p class="item-description">${escapeHtml(item.description)}</p>`
            : '';
          const tags = [
            ...(item.featured ? ['Destacado'] : []),
            ...item.tags
          ];
          const tagMarkup = tags.length
            ? `<div class="item-tags">${tags.map((tag, index) => `<span class="item-tag${index === 0 && item.featured ? ' item-tag-featured' : ''}">${escapeHtml(tag)}</span>`).join('')}</div>`
            : '';

          return `<article class="menu-item" data-search="${escapeHtml(searchText)}">
            <div class="item-head"><h5 class="item-name">${escapeHtml(item.name)}</h5>${price}</div>
            ${variants}${description}${tagMarkup}
          </article>`;
        }).join('');

        return `<section class="menu-subcategory" id="${category.id}" data-category="${escapeHtml(normalize(category.name))}">
          <div class="subcategory-heading"><h4>${escapeHtml(category.name)}</h4><span class="category-count"></span></div>
          <div class="menu-grid">${items}</div>
        </section>`;
      }).join('')}
    </section>`).join('');

  filterMenu();
}

function filterMenu() {
  const query = normalize(search.value.trim());
  let visibleCount = 0;

  let visibleSections = 0;
  for (const section of content.querySelectorAll('.menu-category')) {
    let sectionCount = 0;
    for (const category of section.querySelectorAll('.menu-subcategory')) {
      let categoryCount = 0;
      for (const item of category.querySelectorAll('.menu-item')) {
        const visible = !query || item.dataset.search.includes(query);
        item.hidden = !visible;
        if (visible) categoryCount += 1;
      }
      category.hidden = categoryCount === 0;
      category.querySelector('.category-count').textContent = categoryCount ? `${categoryCount}` : '';
      sectionCount += categoryCount;
    }
    section.hidden = sectionCount === 0;
    section.querySelector('.category-count').textContent = sectionCount ? `${sectionCount}` : '';
    const sectionLink = [...nav.querySelectorAll('a')].find(link => link.hash === `#${section.id}`);
    if (sectionLink) sectionLink.hidden = sectionCount === 0;
    if (sectionCount) visibleSections += 1;
    visibleCount += sectionCount;
  }

  const noResults = query.length > 0 && visibleCount === 0;
  empty.hidden = !noResults;
  content.hidden = noResults;
  nav.hidden = noResults;
  count.textContent = query
    ? `${visibleCount} ${visibleCount === 1 ? 'resultado' : 'resultados'}`
    : `${visibleCount} productos · ${visibleSections} secciones`;
}

function syncSearchUrl() {
  const url = new URL(window.location.href);
  if (search.value.trim()) url.searchParams.set('q', search.value.trim());
  else url.searchParams.delete('q');
  window.history.replaceState(null, '', url);
}

function formatAddress(value) {
  return String(value ?? '')
    .replace(/\bGijon\b/gi, 'Gijón')
    .replace(/(Calle\s+[^\d,]+)\s+(\d+)/i, '$1, $2')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

function formatPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return value;
}

async function loadRestaurant() {
  try {
    const response = await fetch('/api/public/restaurant', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const restaurant = await response.json();
    const address = formatAddress(restaurant.address);
    const addressNode = document.querySelector('#restaurant-address');
    const phoneNode = document.querySelector('#restaurant-phone');
    const directions = document.querySelector('#directions-link');

    if (address) addressNode.textContent = address;
    if (restaurant.phone_e164) {
      phoneNode.href = `tel:${String(restaurant.phone_e164).replace(/[^\d+]/g, '')}`;
      phoneNode.textContent = formatPhone(restaurant.phone_e164);
    } else {
      phoneNode.closest('.detail-row').hidden = true;
    }
    const query = ['Camila Gastrobar', address].filter(Boolean).join(' ');
    directions.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  } catch (err) {
    console.error('Could not load Camila restaurant details', err);
  }
}

async function loadMenu() {
  error.hidden = true;
  empty.hidden = true;
  content.hidden = false;
  nav.hidden = false;
  content.setAttribute('aria-busy', 'true');
  content.innerHTML = '<p class="loading-message">Cargando carta…</p>';
  count.textContent = '';

  try {
    const response = await fetch('/api/public/menu', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderMenu(data.items ?? [], data.currency ?? 'EUR');
    if (data.lastSyncedAt) {
      const syncedAt = new Date(data.lastSyncedAt);
      if (!Number.isNaN(syncedAt.valueOf())) {
        const formatted = new Intl.DateTimeFormat('es-ES', {
          dateStyle: 'short',
          timeStyle: 'short'
        }).format(syncedAt);
        syncStatus.textContent = `Precios sincronizados: ${formatted}`;
      }
    }
  } catch (err) {
    console.error('Could not load Camila menu', err);
    content.replaceChildren();
    nav.replaceChildren();
    error.hidden = false;
  } finally {
    content.setAttribute('aria-busy', 'false');
  }
}

search.addEventListener('input', () => {
  filterMenu();
  syncSearchUrl();
});
document.querySelector('#clear-search').addEventListener('click', () => {
  search.value = '';
  filterMenu();
  syncSearchUrl();
  search.focus();
});
document.querySelector('#menu-retry').addEventListener('click', loadMenu);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    search.focus();
  }
  if (event.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    filterMenu();
    syncSearchUrl();
  }
});

loadRestaurant();
loadMenu();
