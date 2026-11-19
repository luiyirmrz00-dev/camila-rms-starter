import type { Env } from "../index";

const LOYVERSE_API = "https://api.loyverse.com/v1.0";
const RESTAURANT_ID = "camila-gastrobar";

export interface LoyverseStore {
  id: string;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  phone_number?: string | null;
  deleted_at?: string | null;
}

interface LoyverseCategory {
  id: string;
  name: string;
  deleted_at?: string | null;
}

type PublicMenuSection = "drinks" | "starters" | "food" | "desserts";

function classifyMenuSection(name: string): PublicMenuSection {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("es");
  if (["postre", "postres", "dulce", "dulces"].includes(normalized)) return "desserts";
  if (["pincho", "pinchos", "entrante", "entrantes", "aperitivo", "aperitivos", "extra", "extras"].includes(normalized)) return "starters";
  if ([
    "bebida", "bebidas", "brandy", "brandys", "cafe", "cafes", "cerveza", "cervezas",
    "cocktail", "cocktails", "coctel", "cocteles", "ginebra", "ginebras", "mezcal", "mezcales",
    "licores", "otros licores", "refrescos", "refrescos y h2o", "ron", "rones", "sidra", "sidras",
    "tequila", "tequilas", "vermouth", "vino x botella", "vinos chateo", "vodka", "vodkas",
    "whiskey", "whiskeys", "whiskies", "destilados"
  ].includes(normalized)) return "drinks";
  return "food";
}

interface LoyverseStorePrice {
  store_id: string;
  pricing_type?: "FIXED" | "VARIABLE";
  price?: number | null;
  available_for_sale?: boolean;
}

interface LoyverseVariant {
  variant_id: string;
  item_id?: string;
  sku?: string | null;
  option1_value?: string | null;
  option2_value?: string | null;
  option3_value?: string | null;
  default_pricing_type?: "FIXED" | "VARIABLE";
  default_price?: number | null;
  stores?: LoyverseStorePrice[];
  updated_at?: string | null;
  deleted_at?: string | null;
}

interface LoyverseItem {
  id: string;
  item_name: string;
  track_stock?: boolean;
  description?: string | null;
  category_id?: string | null;
  variants?: LoyverseVariant[];
  updated_at?: string | null;
  deleted_at?: string | null;
  image_url?: string | null;
}

interface LoyverseInventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
  updated_at?: string | null;
}

interface Page<T> {
  cursor?: string;
  [key: string]: T[] | string | undefined;
}

export class LoyverseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LoyverseError";
    this.status = status;
  }
}

async function loyverseGet<T>(env: Env, path: string, extra: Record<string, string> = {}): Promise<T> {
  if (!env.LOYVERSE_ACCESS_TOKEN) {
    throw new LoyverseError("Falta LOYVERSE_ACCESS_TOKEN en .dev.vars", 400);
  }

  const url = new URL(`${LOYVERSE_API}${path}`);
  url.searchParams.set("limit", "250");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${env.LOYVERSE_ACCESS_TOKEN}`,
      accept: "application/json"
    }
  });

  if (!response.ok) {
    // Deliberately do not include response bodies or credentials in errors/logs.
    const statusMessage = response.status === 401 || response.status === 403
      ? path === "/inventory"
        ? "Loyverse no autorizó consultar el inventario. Vuelve a emitir el token con el permiso INVENTORY_READ y actualiza LOYVERSE_ACCESS_TOKEN en Cloudflare."
        : "Loyverse rechazó la credencial o sus permisos. Revisa el token."
      : response.status === 429
        ? "Loyverse ha aplicado un límite temporal de solicitudes. Inténtalo de nuevo más tarde."
        : `Loyverse respondió con HTTP ${response.status}.`;
    throw new LoyverseError(statusMessage, response.status);
  }

  return await response.json() as T;
}

async function getAll<T>(env: Env, path: string, arrayKey: string, extra: Record<string, string> = {}): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const query = { ...extra };
    if (cursor) query.cursor = cursor;
    const page = await loyverseGet<Page<T>>(env, path, query);
    const batch = page[arrayKey];
    if (!Array.isArray(batch)) {
      throw new LoyverseError(`Respuesta inesperada de Loyverse en ${path}.`, 502);
    }
    all.push(...batch as T[]);
    cursor = typeof page.cursor === "string" && page.cursor.length ? page.cursor : undefined;
    pageCount += 1;
    if (pageCount > 100) throw new LoyverseError("La paginación excedió el límite de seguridad.", 502);
  } while (cursor);

  return all;
}

export async function listStores(env: Env): Promise<LoyverseStore[]> {
  return getAll<LoyverseStore>(env, "/stores", "stores");
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function minorUnits(amount: number): number {
  return Math.max(0, Math.round(amount * 100));
}

function variantLabel(variant: LoyverseVariant): string {
  const options = [variant.option1_value, variant.option2_value, variant.option3_value]
    .filter((value): value is string => Boolean(value && value.trim()));
  return options.length ? options.join(" · ") : "Estándar";
}

export async function syncCatalog(env: Env, storeId: string, updatedAtMin?: string): Promise<{
  store: { id: string; name: string };
  categories: number;
  items: number;
  variants: number;
  unavailable: number;
  variablePriceVariants: number;
}> {
  if (!storeId) throw new LoyverseError("Selecciona el establecimiento de Camila antes de sincronizar.", 400);
  const syncStartedAt = new Date().toISOString();

  const stores = await listStores(env);
  const store = stores.find(candidate => candidate.id === storeId && !candidate.deleted_at);
  if (!store) throw new LoyverseError("El establecimiento seleccionado no aparece en tu cuenta de Loyverse.", 400);

  const itemFilters = { show_deleted: "true", ...(updatedAtMin ? { updated_at_min: updatedAtMin } : {}) };
  const [categories, items, changedVariants] = await Promise.all([
    getAll<LoyverseCategory>(env, "/categories", "categories", { show_deleted: "true" }),
    getAll<LoyverseItem>(env, "/items", "items", itemFilters),
    updatedAtMin
      ? getAll<LoyverseVariant>(env, "/variants", "variants", { show_deleted: "true", updated_at_min: updatedAtMin })
      : Promise.resolve([] as LoyverseVariant[])
  ]);
  const inventoryLevels = await getAll<LoyverseInventoryLevel>(env, "/inventory", "inventory_levels");

  const now = syncStartedAt;
  const categoryId = (id: string) => `loyverse-category-${id}`;
  const itemId = (id: string) => `loyverse-item-${id}`;

  // Categories are upserted first so item foreign keys are valid.
  const categoryStatements = categories.map(category => env.DB.prepare(`
    INSERT INTO menu_categories
      (id, restaurant_id, loyverse_category_id, name, sort_order, active, last_synced_at, public_section)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(loyverse_category_id) DO UPDATE SET
      name = excluded.name,
      active = excluded.active,
      last_synced_at = excluded.last_synced_at
    WHERE menu_categories.name IS NOT excluded.name
       OR menu_categories.active IS NOT excluded.active
  `).bind(
    categoryId(category.id), RESTAURANT_ID, category.id, category.name,
    category.deleted_at ? 0 : 1, now, classifyMenuSection(category.name)
  ));
  for (const batch of chunks(categoryStatements, 50)) await env.DB.batch(batch);

  let variantCount = 0;
  let unavailableCount = 0;
  let variablePriceCount = 0;
  const itemStatements: D1PreparedStatement[] = [];
  const variantStatements: D1PreparedStatement[] = [];

  for (const item of items) {
    const activeVariants = (item.variants ?? []).map(variant => {
      const storeOverride = (variant.stores ?? []).find(price => price.store_id === storeId);
      const pricingType = storeOverride?.pricing_type ?? variant.default_pricing_type ?? "VARIABLE";
      const price = storeOverride?.price ?? (pricingType === "FIXED" ? variant.default_price : null);
      const available = storeOverride?.available_for_sale ?? true;
      const active = !item.deleted_at && !variant.deleted_at && available && typeof price === "number";
      if (pricingType === "VARIABLE" || typeof price !== "number") variablePriceCount += 1;
      if (!active) unavailableCount += 1;
      return { variant, price, active };
    });

    const itemAvailable = !item.deleted_at && activeVariants.some(entry => entry.active);
    const catId = item.category_id && categories.some(category => category.id === item.category_id)
      ? categoryId(item.category_id)
      : null;

    itemStatements.push(env.DB.prepare(`
      INSERT INTO catalog_items
        (id, restaurant_id, loyverse_item_id, category_id, name, description,
         available_for_sale, active, track_stock, source_updated_at, last_synced_at, raw_source_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(loyverse_item_id) DO UPDATE SET
        category_id = excluded.category_id,
        name = excluded.name,
        description = excluded.description,
        available_for_sale = excluded.available_for_sale,
        active = excluded.active,
        track_stock = excluded.track_stock,
        source_updated_at = excluded.source_updated_at,
        last_synced_at = excluded.last_synced_at,
        raw_source_json = excluded.raw_source_json
      WHERE catalog_items.category_id IS NOT excluded.category_id
         OR catalog_items.name IS NOT excluded.name
         OR catalog_items.description IS NOT excluded.description
         OR catalog_items.available_for_sale IS NOT excluded.available_for_sale
         OR catalog_items.active IS NOT excluded.active
         OR catalog_items.track_stock IS NOT excluded.track_stock
         OR catalog_items.source_updated_at IS NOT excluded.source_updated_at
         OR catalog_items.raw_source_json IS NOT excluded.raw_source_json
    `).bind(
      itemId(item.id), RESTAURANT_ID, item.id, catId, item.item_name,
      item.description ?? null, itemAvailable ? 1 : 0, item.deleted_at ? 0 : 1, item.track_stock ? 1 : 0,
      item.updated_at ?? null, now, JSON.stringify(item)
    ));

    // Publish new Loyverse products by default for the first catalogue import.
    // Existing web presentation (photo, text, tags, ordering) is never overwritten.
    itemStatements.push(env.DB.prepare(`
      INSERT INTO menu_item_presentation (item_id, visible, featured, sort_order)
      VALUES (?, 1, 0, 0)
      ON CONFLICT(item_id) DO NOTHING
    `).bind(itemId(item.id)));

    for (const entry of activeVariants) {
      const { variant, price, active } = entry;
      if (!variant.variant_id) continue;
      variantCount += 1;
      const priceMinor = typeof price === "number" ? minorUnits(price) : 0;
      variantStatements.push(env.DB.prepare(`
        INSERT INTO catalog_variants
          (id, item_id, loyverse_variant_id, name, sku, price_minor,
           currency, store_id, active, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?)
        ON CONFLICT(loyverse_variant_id) DO UPDATE SET
          item_id = excluded.item_id,
          name = excluded.name,
          sku = excluded.sku,
          price_minor = excluded.price_minor,
          currency = excluded.currency,
          store_id = excluded.store_id,
          active = excluded.active,
          last_synced_at = excluded.last_synced_at
        WHERE catalog_variants.item_id IS NOT excluded.item_id
           OR catalog_variants.name IS NOT excluded.name
           OR catalog_variants.sku IS NOT excluded.sku
           OR catalog_variants.price_minor IS NOT excluded.price_minor
           OR catalog_variants.currency IS NOT excluded.currency
           OR catalog_variants.store_id IS NOT excluded.store_id
           OR catalog_variants.active IS NOT excluded.active
      `).bind(
        `loyverse-variant-${variant.variant_id}`,
        itemId(item.id),
        variant.variant_id,
        variantLabel(variant),
        variant.sku ?? null,
        priceMinor,
        storeId,
        active ? 1 : 0,
        now
      ));
    }
  }

  for (const batch of chunks(itemStatements, 50)) await env.DB.batch(batch);
  for (const batch of chunks(variantStatements, 50)) await env.DB.batch(batch);

  if (changedVariants.length) {
    const changedItemIds = new Set(items.map(item => item.id));
    const affectedItemIds = new Set<string>();
    const externalItemIds = [...new Set(changedVariants
      .map(variant => variant.item_id)
      .filter((id): id is string => Boolean(id && !changedItemIds.has(id))))];
    const itemState = new Map<string, { id: string; active: number; available_for_sale: number }>();

    for (const itemIdBatch of chunks(externalItemIds, 200)) {
      if (!itemIdBatch.length) continue;
      const placeholders = itemIdBatch.map(() => "?").join(",");
      const result = await env.DB.prepare(`
        SELECT id, loyverse_item_id, active, available_for_sale
        FROM catalog_items
        WHERE restaurant_id = ? AND loyverse_item_id IN (${placeholders})
      `).bind(RESTAURANT_ID, ...itemIdBatch).all<{
        id: string;
        loyverse_item_id: string;
        active: number;
        available_for_sale: number;
      }>();
      for (const item of result.results) {
        itemState.set(item.loyverse_item_id, {
          id: item.id,
          active: item.active,
          available_for_sale: item.available_for_sale
        });
      }
    }

    const changedVariantStatements: D1PreparedStatement[] = [];
    for (const variant of changedVariants) {
      if (!variant.variant_id || !variant.item_id) continue;
      const parent = itemState.get(variant.item_id);
      if (!parent) continue;
      affectedItemIds.add(parent.id);

      const storeOverride = (variant.stores ?? []).find(price => price.store_id === storeId);
      const pricingType = storeOverride?.pricing_type ?? variant.default_pricing_type ?? "VARIABLE";
      const price = storeOverride?.price ?? (pricingType === "FIXED" ? variant.default_price : null);
      const available = storeOverride?.available_for_sale ?? true;
      const active = Boolean(parent.active && parent.available_for_sale) &&
        !variant.deleted_at && available && typeof price === "number";
      if (pricingType === "VARIABLE" || typeof price !== "number") variablePriceCount += 1;
      if (!active) unavailableCount += 1;
      variantCount += 1;

      changedVariantStatements.push(env.DB.prepare(`
        INSERT INTO catalog_variants
          (id, item_id, loyverse_variant_id, name, sku, price_minor,
           currency, store_id, active, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?)
        ON CONFLICT(loyverse_variant_id) DO UPDATE SET
          item_id = excluded.item_id,
          name = excluded.name,
          sku = excluded.sku,
          price_minor = excluded.price_minor,
          currency = excluded.currency,
          store_id = excluded.store_id,
          active = excluded.active,
          last_synced_at = excluded.last_synced_at
        WHERE catalog_variants.item_id IS NOT excluded.item_id
           OR catalog_variants.name IS NOT excluded.name
           OR catalog_variants.sku IS NOT excluded.sku
           OR catalog_variants.price_minor IS NOT excluded.price_minor
           OR catalog_variants.currency IS NOT excluded.currency
           OR catalog_variants.store_id IS NOT excluded.store_id
           OR catalog_variants.active IS NOT excluded.active
      `).bind(
        `loyverse-variant-${variant.variant_id}`,
        parent.id,
        variant.variant_id,
        variantLabel(variant),
        variant.sku ?? null,
        typeof price === "number" ? minorUnits(price) : 0,
        storeId,
        active ? 1 : 0,
        now
      ));
    }

    for (const batch of chunks(changedVariantStatements, 50)) await env.DB.batch(batch);
    for (const itemIdBatch of chunks([...affectedItemIds], 50)) {
      if (!itemIdBatch.length) continue;
      const placeholders = itemIdBatch.map(() => "?").join(",");
      await env.DB.prepare(`
        UPDATE catalog_items
        SET available_for_sale = CASE
          WHEN active = 1 AND EXISTS (
            SELECT 1 FROM catalog_variants v WHERE v.item_id = catalog_items.id AND v.active = 1
          ) THEN 1 ELSE 0 END,
          last_synced_at = ?
        WHERE id IN (${placeholders})
      `).bind(now, ...itemIdBatch).run();
    }
  }

  const stockByVariant = new Map<string, number>();
  for (const level of inventoryLevels) {
    if (level.store_id === storeId && level.variant_id && Number.isFinite(Number(level.in_stock))) {
      stockByVariant.set(level.variant_id, Number(level.in_stock));
    }
  }
  const storedVariants = await env.DB.prepare(`
    SELECT v.id, v.loyverse_variant_id, i.track_stock
    FROM catalog_variants v
    JOIN catalog_items i ON i.id = v.item_id
    WHERE i.restaurant_id = ? AND v.store_id = ? AND v.active = 1
  `).bind(RESTAURANT_ID, storeId).all<{ id: string; loyverse_variant_id: string; track_stock: number }>();
  const inventoryStatements = storedVariants.results.map(variant => {
    const inStock = variant.track_stock
      ? Math.max(0, stockByVariant.get(variant.loyverse_variant_id) ?? 0)
      : null;
    return env.DB.prepare(`
      UPDATE catalog_variants
      SET in_stock = ?, last_synced_at = ?
      WHERE id = ? AND store_id = ? AND in_stock IS NOT ?
    `).bind(inStock, now, variant.id, storeId, inStock);
  });
  for (const batch of chunks(inventoryStatements, 50)) await env.DB.batch(batch);

  // Update restaurant contact/location details from the selected Loyverse store only when present.
  const addressParts = [store.address, store.postal_code, store.city, store.state, store.country]
    .filter((value): value is string => Boolean(value && value.trim()));
  await env.DB.prepare(`
    UPDATE restaurants
    SET phone_e164 = COALESCE(?, phone_e164),
        address = COALESCE(?, address),
        updated_at = ?
    WHERE id = ?
      AND (phone_e164 IS NOT COALESCE(?, phone_e164)
        OR address IS NOT COALESCE(?, address))
  `).bind(
    store.phone_number ?? null,
    addressParts.length ? addressParts.join(", ") : null,
    now,
    RESTAURANT_ID,
    store.phone_number ?? null,
    addressParts.length ? addressParts.join(", ") : null
  ).run();

  const completedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO integrations (id, restaurant_id, provider, display_name, status, last_success_at, metadata_json, updated_at)
    VALUES ('integration-loyverse-camila', ?, 'loyverse', 'Loyverse', 'connected', ?, ?, ?)
    ON CONFLICT(restaurant_id, provider) DO UPDATE SET
      status = 'connected', last_success_at = excluded.last_success_at,
      last_error_at = NULL, last_error_code = NULL,
      metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
  `).bind(RESTAURANT_ID, completedAt, JSON.stringify({
    store_id: store.id,
    store_name: store.name,
    checkpoint_at: syncStartedAt,
    categories: categories.length,
    items: items.length
  }), completedAt).run();

  return {
    store: { id: store.id, name: store.name },
    categories: categories.length,
    items: items.length,
    variants: variantCount,
    unavailable: unavailableCount,
    variablePriceVariants: variablePriceCount
  };
}

export async function getLoyverseSyncCheckpoint(env: Env): Promise<string | null> {
  const integration = await env.DB.prepare(`
    SELECT metadata_json FROM integrations
    WHERE restaurant_id = ? AND provider = 'loyverse'
    LIMIT 1
  `).bind(RESTAURANT_ID).first<{ metadata_json: string | null }>();
  if (!integration?.metadata_json) return null;

  try {
    const metadata = JSON.parse(integration.metadata_json) as { checkpoint_at?: unknown };
    if (typeof metadata.checkpoint_at !== "string" || Number.isNaN(Date.parse(metadata.checkpoint_at))) return null;
    return metadata.checkpoint_at;
  } catch {
    return null;
  }
}

export async function recordLoyverseSyncFailure(env: Env, error: unknown): Promise<void> {
  const failedAt = new Date().toISOString();
  const errorCode = error instanceof LoyverseError ? String(error.status) : "unknown";
  await env.DB.prepare(`
    INSERT INTO integrations
      (id, restaurant_id, provider, display_name, status, last_error_at, last_error_code, metadata_json, updated_at)
    VALUES ('integration-loyverse-camila', ?, 'loyverse', 'Loyverse', 'error', ?, ?, '{}', ?)
    ON CONFLICT(restaurant_id, provider) DO UPDATE SET
      status = 'error', last_error_at = excluded.last_error_at,
      last_error_code = excluded.last_error_code, updated_at = excluded.updated_at
  `).bind(RESTAURANT_ID, failedAt, errorCode, failedAt).run();
}

export async function handleLoyverseDevRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/dev/loyverse/")) return null;

  if (env.APP_ENV !== "development") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!env.LOYVERSE_ACCESS_TOKEN) {
    return Response.json({ error: "Falta LOYVERSE_ACCESS_TOKEN en .dev.vars" }, { status: 400 });
  }

  try {
    if (url.pathname === "/api/dev/loyverse/stores" && request.method === "GET") {
      const stores = await listStores(env);
      return Response.json({
        ok: true,
        stores: stores.filter(store => !store.deleted_at).map(store => ({
          id: store.id,
          name: store.name,
          address: store.address ?? null,
          city: store.city ?? null,
          country: store.country ?? null,
          phone_number: store.phone_number ?? null
        })),
        configuredStoreId: env.LOYVERSE_STORE_ID ?? null
      }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/dev/loyverse/sync" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { store_id?: string };
      const storeId = body.store_id?.trim() || env.LOYVERSE_STORE_ID?.trim();
      if (!storeId) {
        return Response.json({ error: "Primero selecciona el establecimiento y guarda su ID en LOYVERSE_STORE_ID dentro de .dev.vars." }, { status: 400 });
      }
      const result = await syncCatalog(env, storeId);
      return Response.json({ ok: true, message: "Catálogo sincronizado", ...result }, { headers: { "cache-control": "no-store" } });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof LoyverseError) {
      return Response.json({ error: error.message }, { status: error.status >= 400 && error.status <= 599 ? error.status : 502 });
    }
    console.error("Loyverse integration failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "No se pudo completar la operación de Loyverse. Revisa los logs locales." }, { status: 500 });
  }
}
