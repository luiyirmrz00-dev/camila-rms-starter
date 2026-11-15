import { AdminAuthError, requireAdmin } from "./integrations/access";
import type { Env } from "./index";

const RESTAURANT_ID = "camila-gastrobar";
const TABLE_SHAPES = new Set(["round", "square", "rectangle", "booth"]);

interface SetupInput {
  areas?: Array<{ id?: string; name: string; sort_order?: number; active?: boolean }>;
  tables?: Array<{
    id?: string;
    area_id: string;
    table_code: string;
    display_name?: string | null;
    min_capacity: number;
    max_capacity: number;
    shape: "round" | "square" | "rectangle" | "booth";
    x: number;
    y: number;
    rotation?: number;
    active?: boolean;
    sort_order?: number;
  }>;
  combinations?: Array<{ id?: string; name: string; max_capacity: number; active?: boolean; table_ids: string[] }>;
  opening_hours?: Array<{
    id?: string;
    weekday: number;
    service_name: string;
    opens_at_local: string;
    closes_at_local: string;
    active?: boolean;
  }>;
  closures?: Array<{
    id?: string;
    closure_date_local: string;
    starts_at_local?: string | null;
    ends_at_local?: string | null;
    reason?: string | null;
  }>;
  rules?: {
    default_duration_minutes: number;
    slot_interval_minutes: number;
    max_party_size_online: number;
    min_lead_time_minutes: number;
    max_days_in_advance: number;
    auto_confirm: boolean;
    pending_hold_minutes: number;
    cancellation_cutoff_minutes: number;
  };
}

class SetupValidationError extends Error {}

function fail(message: string): never {
  throw new SetupValidationError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength = 120): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    return fail(`${field} es obligatorio y debe tener como máximo ${maxLength} caracteres.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fail(`${field} debe estar entre ${min} y ${max}.`);
  return number;
}

function optionalNumber(value: unknown, fallback: number, field: string, min: number, max: number): number {
  return value == null ? fallback : requireNumber(value, field, min, max);
}

function localTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fail(`${field} debe usar el formato HH:mm.`);
  return value;
}

function localDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail("La fecha debe usar el formato AAAA-MM-DD.");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return fail("La fecha indicada no existe.");
  return value;
}

function normalizeId(value: unknown, prefix: string): string {
  if (value == null || value === "") return `${prefix}-${crypto.randomUUID()}`;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) return fail("El identificador no es válido.");
  return value;
}

function normalizeBoolean(value: unknown, fallback = true): number {
  if (value == null) return fallback ? 1 : 0;
  if (typeof value !== "boolean") return fail("El estado debe ser verdadero o falso.");
  return value ? 1 : 0;
}

function normalizeArray<T>(value: unknown, field: string, max = 100): T[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => !isObject(item))) {
    return fail(`${field} debe ser una lista válida de hasta ${max} elementos.`);
  }
  return value as T[];
}

function validateSetup(value: unknown): SetupInput {
  if (!isObject(value)) return fail("El cuerpo de configuración debe ser un objeto JSON.");
  const input = value as SetupInput;
  const areas = normalizeArray<NonNullable<SetupInput["areas"]>[number]>(input.areas, "areas", 20).map(area => ({
    id: normalizeId(area.id, "area"),
    name: requireString(area.name, "El nombre de zona", 60),
    sort_order: optionalNumber(area.sort_order, 0, "El orden de zona", 0, 999),
    active: Boolean(normalizeBoolean(area.active))
  }));
  const knownAreas = new Set(areas.map(area => area.id));

  const tables = normalizeArray<NonNullable<SetupInput["tables"]>[number]>(input.tables, "tables", 100).map(table => ({
    id: normalizeId(table.id, "table"),
    area_id: requireString(table.area_id, "La zona de mesa", 120),
    table_code: requireString(table.table_code, "El código de mesa", 24),
    display_name: typeof table.display_name === "string" ? table.display_name.trim().slice(0, 60) || null : null,
    min_capacity: requireNumber(table.min_capacity, "La capacidad mínima", 1, 100),
    max_capacity: requireNumber(table.max_capacity, "La capacidad máxima", 1, 100),
    shape: table.shape,
    x: Number(table.x),
    y: Number(table.y),
    rotation: optionalNumber(table.rotation, 0, "La rotación", 0, 359),
    active: Boolean(normalizeBoolean(table.active)),
    sort_order: optionalNumber(table.sort_order, 0, "El orden de mesa", 0, 999)
  }));
  if (tables.some(table => table.max_capacity < table.min_capacity)) fail("La capacidad máxima debe ser igual o mayor que la mínima.");
  if (tables.some(table => !TABLE_SHAPES.has(table.shape))) fail("La forma de mesa no es válida.");
  if (tables.some(table => !Number.isFinite(table.x) || table.x < 0 || table.x > 100 || !Number.isFinite(table.y) || table.y < 0 || table.y > 100)) {
    fail("La posición de cada mesa debe estar entre 0 y 100.");
  }
  if (areas.length && tables.some(table => !knownAreas.has(table.area_id))) fail("Cada mesa debe pertenecer a una zona incluida en la configuración.");

  const knownTables = new Set(tables.map(table => table.id));
  const combinations = normalizeArray<NonNullable<SetupInput["combinations"]>[number]>(input.combinations, "combinations", 100).map(combo => ({
    id: normalizeId(combo.id, "combo"),
    name: requireString(combo.name, "El nombre de combinación", 60),
    max_capacity: requireNumber(combo.max_capacity, "La capacidad de combinación", 2, 100),
    active: Boolean(normalizeBoolean(combo.active)),
    table_ids: Array.isArray(combo.table_ids) ? [...new Set(combo.table_ids.map(id => requireString(id, "El identificador de mesa", 120)))] : fail("Cada combinación debe incluir sus mesas.")
  }));
  if (combinations.some(combo => combo.table_ids.length < 2 || combo.table_ids.length > 14)) fail("Una combinación debe unir entre 2 y 14 mesas.");
  if (tables.length && combinations.some(combo => combo.table_ids.some(id => !knownTables.has(id)))) fail("Cada combinación debe referirse a mesas incluidas en la configuración.");

  const openingHours = normalizeArray<NonNullable<SetupInput["opening_hours"]>[number]>(input.opening_hours, "opening_hours", 100).map(hour => ({
    id: normalizeId(hour.id, "hours"),
    weekday: requireNumber(hour.weekday, "El día de la semana", 0, 6),
    service_name: requireString(hour.service_name, "El nombre del turno", 40),
    opens_at_local: localTime(hour.opens_at_local, "La hora de apertura"),
    closes_at_local: localTime(hour.closes_at_local, "La hora de cierre"),
    active: Boolean(normalizeBoolean(hour.active))
  }));
  if (openingHours.some(hour => hour.closes_at_local <= hour.opens_at_local && hour.closes_at_local !== "00:00")) {
    fail("La hora de cierre debe ser posterior a la apertura; 00:00 indica medianoche del día siguiente.");
  }

  const closures = normalizeArray<NonNullable<SetupInput["closures"]>[number]>(input.closures, "closures", 100).map(closure => {
    const startsAt = closure.starts_at_local == null || closure.starts_at_local === "" ? null : localTime(closure.starts_at_local, "El inicio del cierre");
    const endsAt = closure.ends_at_local == null || closure.ends_at_local === "" ? null : localTime(closure.ends_at_local, "El final del cierre");
    if ((startsAt == null) !== (endsAt == null)) fail("Indica inicio y final para un cierre parcial, o deja ambos vacíos para cerrar todo el día.");
    if (startsAt && endsAt && endsAt <= startsAt) fail("El cierre parcial debe terminar después de empezar.");
    return {
      id: normalizeId(closure.id, "closure"),
      closure_date_local: localDate(closure.closure_date_local),
      starts_at_local: startsAt,
      ends_at_local: endsAt,
      reason: typeof closure.reason === "string" ? closure.reason.trim().slice(0, 180) || null : null
    };
  });

  let rules = input.rules;
  if (rules != null) {
    if (!isObject(rules)) fail("Las reglas de reserva deben ser un objeto.");
    rules = {
      default_duration_minutes: requireNumber(rules.default_duration_minutes, "La duración", 15, 480),
      slot_interval_minutes: requireNumber(rules.slot_interval_minutes, "El intervalo", 5, 60),
      max_party_size_online: requireNumber(rules.max_party_size_online, "El tamaño máximo del grupo", 1, 100),
      min_lead_time_minutes: requireNumber(rules.min_lead_time_minutes, "El tiempo mínimo de anticipación", 0, 10080),
      max_days_in_advance: requireNumber(rules.max_days_in_advance, "Los días máximos de anticipación", 1, 365),
      auto_confirm: Boolean(normalizeBoolean(rules.auto_confirm, false)),
      pending_hold_minutes: requireNumber(rules.pending_hold_minutes, "El tiempo para confirmar", 1, 1440),
      cancellation_cutoff_minutes: requireNumber(rules.cancellation_cutoff_minutes, "El plazo de cancelación", 0, 10080)
    };
  }

  return { areas, tables, combinations, opening_hours: openingHours, closures, rules };
}

function audit(env: Env, staffId: string, action: string, entityType: string, entityId: string | null, after: unknown): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO audit_logs (id, restaurant_id, actor_staff_id, action, entity_type, entity_id, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), RESTAURANT_ID, staffId, action, entityType, entityId, JSON.stringify(after));
}

async function getSetup(env: Env): Promise<Record<string, unknown>> {
  const [areas, tables, combinations, members, hours, closures, rules] = await Promise.all([
    env.DB.prepare(`SELECT id, name, sort_order, active FROM dining_areas WHERE restaurant_id = ? ORDER BY sort_order, name`).bind(RESTAURANT_ID).all(),
    env.DB.prepare(`SELECT id, area_id, table_code, display_name, min_capacity, max_capacity, shape, x, y, rotation, active, sort_order FROM dining_tables WHERE restaurant_id = ? ORDER BY sort_order, table_code`).bind(RESTAURANT_ID).all(),
    env.DB.prepare(`SELECT id, name, max_capacity, active FROM table_combinations WHERE restaurant_id = ? ORDER BY name`).bind(RESTAURANT_ID).all(),
    env.DB.prepare(`SELECT m.combination_id, m.table_id FROM table_combination_members m JOIN table_combinations c ON c.id = m.combination_id WHERE c.restaurant_id = ?`).bind(RESTAURANT_ID).all<{ combination_id: string; table_id: string }>(),
    env.DB.prepare(`SELECT id, weekday, service_name, opens_at_local, closes_at_local, active FROM opening_hours WHERE restaurant_id = ? ORDER BY weekday, opens_at_local`).bind(RESTAURANT_ID).all(),
    env.DB.prepare(`SELECT id, closure_date_local, starts_at_local, ends_at_local, reason FROM restaurant_closures WHERE restaurant_id = ? ORDER BY closure_date_local, starts_at_local`).bind(RESTAURANT_ID).all(),
    env.DB.prepare(`SELECT default_duration_minutes, slot_interval_minutes, max_party_size_online, min_lead_time_minutes, max_days_in_advance, auto_confirm, pending_hold_minutes, cancellation_cutoff_minutes FROM reservation_rules WHERE restaurant_id = ? LIMIT 1`).bind(RESTAURANT_ID).first()
  ]);
  const tableIdsByCombo = new Map<string, string[]>();
  for (const member of members.results) {
    const existing = tableIdsByCombo.get(member.combination_id) ?? [];
    existing.push(member.table_id);
    tableIdsByCombo.set(member.combination_id, existing);
  }
  return {
    areas: areas.results,
    tables: tables.results,
    combinations: combinations.results.map(combo => ({ ...combo, table_ids: tableIdsByCombo.get(String(combo.id)) ?? [] })),
    opening_hours: hours.results,
    closures: closures.results,
    rules
  };
}

export async function handleAdminSetupRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/setup") return null;
  if (request.method !== "GET" && request.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const staff = await requireAdmin(request, env, request.method === "GET"
      ? ["owner", "manager", "host", "server"]
      : ["owner", "manager"]);
    if (request.method === "GET") {
      return Response.json(await getSetup(env), { headers: { "cache-control": "no-store" } });
    }

    let parsed: unknown;
    try { parsed = await request.json(); } catch { return Response.json({ error: "El cuerpo debe ser JSON válido." }, { status: 400 }); }
    const setup = validateSetup(parsed);
    const statements: D1PreparedStatement[] = [];

    for (const area of setup.areas ?? []) {
      statements.push(env.DB.prepare(`
        INSERT INTO dining_areas (id, restaurant_id, name, sort_order, active)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, active = excluded.active
        WHERE dining_areas.restaurant_id = excluded.restaurant_id
      `).bind(area.id, RESTAURANT_ID, area.name, area.sort_order, area.active ? 1 : 0));
    }
    for (const table of setup.tables ?? []) {
      statements.push(env.DB.prepare(`
        INSERT INTO dining_tables
          (id, restaurant_id, area_id, table_code, display_name, min_capacity, max_capacity, shape, x, y, rotation, active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          area_id = excluded.area_id, table_code = excluded.table_code, display_name = excluded.display_name,
          min_capacity = excluded.min_capacity, max_capacity = excluded.max_capacity, shape = excluded.shape,
          x = excluded.x, y = excluded.y, rotation = excluded.rotation, active = excluded.active, sort_order = excluded.sort_order
        WHERE dining_tables.restaurant_id = excluded.restaurant_id
      `).bind(
        table.id, RESTAURANT_ID, table.area_id, table.table_code, table.display_name,
        table.min_capacity, table.max_capacity, table.shape, table.x, table.y,
        table.rotation, table.active ? 1 : 0, table.sort_order
      ));
    }
    for (const combo of setup.combinations ?? []) {
      statements.push(env.DB.prepare(`
        INSERT INTO table_combinations (id, restaurant_id, name, max_capacity, active)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, max_capacity = excluded.max_capacity, active = excluded.active
        WHERE table_combinations.restaurant_id = excluded.restaurant_id
      `).bind(combo.id, RESTAURANT_ID, combo.name, combo.max_capacity, combo.active ? 1 : 0));
      statements.push(env.DB.prepare(`DELETE FROM table_combination_members WHERE combination_id = ?`).bind(combo.id));
      for (const tableId of combo.table_ids) {
        statements.push(env.DB.prepare(`INSERT INTO table_combination_members (combination_id, table_id) VALUES (?, ?)`).bind(combo.id, tableId));
      }
    }
    const openingHours = setup.opening_hours ?? [];
    for (const hour of openingHours) {
      statements.push(env.DB.prepare(`
        INSERT INTO opening_hours (id, restaurant_id, weekday, service_name, opens_at_local, closes_at_local, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          weekday = excluded.weekday, service_name = excluded.service_name,
          opens_at_local = excluded.opens_at_local, closes_at_local = excluded.closes_at_local, active = excluded.active
        WHERE opening_hours.restaurant_id = excluded.restaurant_id
      `).bind(hour.id, RESTAURANT_ID, hour.weekday, hour.service_name, hour.opens_at_local, hour.closes_at_local, hour.active ? 1 : 0));
    }
    const hourIds = openingHours.map(hour => hour.id);
    if (hourIds.length) {
      statements.push(env.DB.prepare(`DELETE FROM opening_hours WHERE restaurant_id = ? AND id NOT IN (${hourIds.map(() => "?").join(",")})`).bind(RESTAURANT_ID, ...hourIds));
    } else {
      statements.push(env.DB.prepare(`DELETE FROM opening_hours WHERE restaurant_id = ?`).bind(RESTAURANT_ID));
    }

    const closures = setup.closures ?? [];
    for (const closure of closures) {
      statements.push(env.DB.prepare(`
        INSERT INTO restaurant_closures (id, restaurant_id, closure_date_local, starts_at_local, ends_at_local, reason)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          closure_date_local = excluded.closure_date_local, starts_at_local = excluded.starts_at_local,
          ends_at_local = excluded.ends_at_local, reason = excluded.reason
        WHERE restaurant_closures.restaurant_id = excluded.restaurant_id
      `).bind(closure.id, RESTAURANT_ID, closure.closure_date_local, closure.starts_at_local, closure.ends_at_local, closure.reason));
    }
    const closureIds = closures.map(closure => closure.id);
    if (closureIds.length) {
      statements.push(env.DB.prepare(`DELETE FROM restaurant_closures WHERE restaurant_id = ? AND id NOT IN (${closureIds.map(() => "?").join(",")})`).bind(RESTAURANT_ID, ...closureIds));
    } else {
      statements.push(env.DB.prepare(`DELETE FROM restaurant_closures WHERE restaurant_id = ?`).bind(RESTAURANT_ID));
    }

    const combinations = setup.combinations ?? [];
    const combinationIds = combinations.map(combo => combo.id);
    if (combinationIds.length) {
      statements.push(env.DB.prepare(`DELETE FROM table_combinations WHERE restaurant_id = ? AND id NOT IN (${combinationIds.map(() => "?").join(",")})`).bind(RESTAURANT_ID, ...combinationIds));
    } else {
      statements.push(env.DB.prepare(`DELETE FROM table_combinations WHERE restaurant_id = ?`).bind(RESTAURANT_ID));
    }
    if (setup.rules) {
      statements.push(env.DB.prepare(`
        INSERT INTO reservation_rules
          (restaurant_id, default_duration_minutes, slot_interval_minutes, max_party_size_online,
           min_lead_time_minutes, max_days_in_advance, auto_confirm, pending_hold_minutes, cancellation_cutoff_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(restaurant_id) DO UPDATE SET
          default_duration_minutes = excluded.default_duration_minutes,
          slot_interval_minutes = excluded.slot_interval_minutes,
          max_party_size_online = excluded.max_party_size_online,
          min_lead_time_minutes = excluded.min_lead_time_minutes,
          max_days_in_advance = excluded.max_days_in_advance,
          auto_confirm = excluded.auto_confirm,
          pending_hold_minutes = excluded.pending_hold_minutes,
          cancellation_cutoff_minutes = excluded.cancellation_cutoff_minutes,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).bind(
        RESTAURANT_ID,
        setup.rules.default_duration_minutes,
        setup.rules.slot_interval_minutes,
        setup.rules.max_party_size_online,
        setup.rules.min_lead_time_minutes,
        setup.rules.max_days_in_advance,
        setup.rules.auto_confirm ? 1 : 0,
        setup.rules.pending_hold_minutes,
        setup.rules.cancellation_cutoff_minutes
      ));
    }

    if (!statements.length) return Response.json({ ok: true, message: "No hay cambios que guardar." });
    statements.push(audit(env, staff.staffId, "update", "restaurant_setup", RESTAURANT_ID, {
      areas: setup.areas?.length ?? 0,
      tables: setup.tables?.length ?? 0,
      combinations: setup.combinations?.length ?? 0,
      opening_hours: setup.opening_hours?.length ?? 0,
      closures: setup.closures?.length ?? 0,
      rules: Boolean(setup.rules)
    }));
    await env.DB.batch(statements);
    return Response.json({ ok: true, setup: await getSetup(env) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AdminAuthError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SetupValidationError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return Response.json({ error: "Ya existe una mesa con ese código o una combinación con esos datos." }, { status: 409 });
    }
    throw error;
  }
}
