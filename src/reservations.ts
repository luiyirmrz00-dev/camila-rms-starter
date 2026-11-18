import type { Env } from "./index";
import { AdminAuthError, requireAdmin, type StaffRole } from "./integrations/access";

const RESTAURANT_ID = "camila-gastrobar";
const TIME_ZONE = "Europe/Madrid";
const SLOT_MINUTES = 5;
const ACTIVE_RESERVATION_STATUSES = ["pending", "confirmed", "seated"] as const;
const READ_ROLES: StaffRole[] = ["owner", "manager", "host", "server"];
const WRITE_ROLES: StaffRole[] = ["owner", "manager", "host"];

type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;
class ReservationHttpError extends Error {
  status: HttpErrorStatus;
  constructor(message: string, status: HttpErrorStatus) {
    super(message);
    this.name = "ReservationHttpError";
    this.status = status;
  }
}

interface Rules {
  default_duration_minutes: number;
  slot_interval_minutes: number;
  max_party_size_online: number;
  min_lead_time_minutes: number;
  max_days_in_advance: number;
  auto_confirm: number;
  pending_hold_minutes: number;
  cancellation_cutoff_minutes: number;
}

interface OpeningHour {
  id: string;
  service_name: string;
  opens_at_local: string;
  closes_at_local: string;
}

interface Closure {
  starts_at_local: string | null;
  ends_at_local: string | null;
}

interface DiningTable {
  id: string;
  area_id: string;
  table_code: string;
  display_name: string | null;
  min_capacity: number;
  max_capacity: number;
}

interface DiningCombination {
  id: string;
  name: string;
  max_capacity: number;
  table_ids: string[];
}

interface SeatingOption {
  tableIds: string[];
  minCapacity: number;
  maxCapacity: number;
}

interface AvailableSlot {
  time: string;
  startsAtUtc: string;
  endsAtUtc: string;
  tableIds: string[];
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localWeekday(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

function localMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localParts(epochMs: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function localDateTimeToEpoch(date: string, time: string): number | null {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const targetUtcAsLocal = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetUtcAsLocal;

  for (let index = 0; index < 4; index += 1) {
    const parts = localParts(candidate);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const offset = representedAsUtc - Math.floor(candidate / 60000) * 60000;
    candidate = targetUtcAsLocal - offset;
  }

  const check = localParts(candidate);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    return null;
  }
  return candidate;
}

function epochToLocalTime(epochMs: number): string {
  const { hour, minute } = localParts(epochMs);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function addLocalMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return {
    date: value.toISOString().slice(0, 10),
    time: `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`
  };
}

function normalizePhone(value: unknown): string {
  if (typeof value !== "string") throw new ReservationHttpError("Escribe un número de teléfono válido.", 400);
  let phone = value.trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (/^\d{9}$/.test(phone)) phone = `+34${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new ReservationHttpError("Incluye el prefijo del país; por ejemplo, +34 600 123 456.", 400);
  return phone;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ReservationHttpError(`${label} es obligatorio y admite hasta ${maxLength} caracteres.`, 400);
  }
  return value.trim();
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function actionUrl(request: Request, type: "confirm" | "cancel", token: string): string {
  const url = new URL("/reserva.html", request.url);
  url.searchParams.set("accion", type);
  url.searchParams.set("token", token);
  return url.toString();
}

async function loadRules(env: Env): Promise<Rules> {
  const rules = await env.DB.prepare(`
    SELECT default_duration_minutes, slot_interval_minutes, max_party_size_online,
           min_lead_time_minutes, max_days_in_advance, auto_confirm,
           pending_hold_minutes, cancellation_cutoff_minutes
    FROM reservation_rules WHERE restaurant_id = ? LIMIT 1
  `).bind(RESTAURANT_ID).first<Rules>();
  if (!rules) throw new ReservationHttpError("El sistema de reservas aún no está configurado.", 503);
  return rules;
}

async function loadSeatingOptions(env: Env): Promise<SeatingOption[]> {
  const [tablesResult, combinationsResult, membersResult] = await Promise.all([
    env.DB.prepare(`
      SELECT t.id, t.area_id, t.table_code, t.display_name, t.min_capacity, t.max_capacity
      FROM dining_tables t JOIN dining_areas a ON a.id = t.area_id
      WHERE t.restaurant_id = ? AND t.active = 1 AND a.active = 1
      ORDER BY (t.max_capacity - t.min_capacity), t.max_capacity, t.table_code
    `).bind(RESTAURANT_ID).all<DiningTable>(),
    env.DB.prepare(`SELECT id, name, max_capacity FROM table_combinations WHERE restaurant_id = ? AND active = 1`).bind(RESTAURANT_ID).all<Omit<DiningCombination, "table_ids">>(),
    env.DB.prepare(`SELECT m.combination_id, m.table_id FROM table_combination_members m JOIN table_combinations c ON c.id = m.combination_id WHERE c.restaurant_id = ? AND c.active = 1`).bind(RESTAURANT_ID).all<{ combination_id: string; table_id: string }>()
  ]);

  const tables = tablesResult.results;
  const tableById = new Map(tables.map(table => [table.id, table]));
  const membersByCombination = new Map<string, string[]>();
  for (const member of membersResult.results) {
    const ids = membersByCombination.get(member.combination_id) ?? [];
    ids.push(member.table_id);
    membersByCombination.set(member.combination_id, ids);
  }

  const options: SeatingOption[] = tables.map(table => ({
    tableIds: [table.id], minCapacity: table.min_capacity, maxCapacity: table.max_capacity
  }));
  for (const combo of combinationsResult.results) {
    const tableIds = membersByCombination.get(combo.id) ?? [];
    const comboTables = tableIds.map(id => tableById.get(id));
    if (tableIds.length < 2 || comboTables.some(table => !table)) continue;
    const validTables = comboTables as DiningTable[];
    if (new Set(validTables.map(table => table.area_id)).size > 1) continue;
    options.push({
      tableIds,
      minCapacity: validTables.reduce((sum, table) => sum + table.min_capacity, 0),
      maxCapacity: combo.max_capacity
    });
  }
  return options.sort((a, b) => a.tableIds.length - b.tableIds.length || a.maxCapacity - b.maxCapacity);
}

function makeSlotTimes(startMs: number, endMs: number): string[] {
  const first = Math.floor(startMs / (SLOT_MINUTES * 60000)) * SLOT_MINUTES * 60000;
  const slots: string[] = [];
  for (let slot = first; slot < endMs; slot += SLOT_MINUTES * 60000) {
    if (slot + SLOT_MINUTES * 60000 > startMs) slots.push(new Date(slot).toISOString());
  }
  return slots;
}

async function getClosedIntervals(env: Env, date: string): Promise<Closure[]> {
  const result = await env.DB.prepare(`
    SELECT starts_at_local, ends_at_local FROM restaurant_closures
    WHERE restaurant_id = ? AND closure_date_local = ?
  `).bind(RESTAURANT_ID, date).all<Closure>();
  return result.results;
}

function isClosedByException(date: string, startMs: number, endMs: number, closures: Closure[]): boolean {
  for (const closure of closures) {
    if (!closure.starts_at_local || !closure.ends_at_local) return true;
    const closureStart = localDateTimeToEpoch(date, closure.starts_at_local);
    const closureEnd = localDateTimeToEpoch(date, closure.ends_at_local);
    if (closureStart != null && closureEnd != null && startMs < closureEnd && endMs > closureStart) return true;
  }
  return false;
}

async function loadOccupiedSlots(env: Env, start: string, end: string): Promise<Set<string>> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    SELECT s.table_id, s.slot_start_utc
    FROM reservation_table_slots s
    JOIN reservations r ON r.id = s.reservation_id
    WHERE r.restaurant_id = ?
      AND s.slot_start_utc >= ? AND s.slot_start_utc < ?
      AND r.status IN ('pending','confirmed','seated')
      AND (r.status != 'pending' OR r.hold_expires_at > ? OR r.hold_expires_at IS NULL)
  `).bind(RESTAURANT_ID, start, end, now).all<{ table_id: string; slot_start_utc: string }>();
  return new Set(result.results.map(row => `${row.table_id}:${row.slot_start_utc}`));
}

async function calculateAvailability(env: Env, date: string, partySize: number): Promise<AvailableSlot[]> {
  const weekday = localWeekday(date);
  const [rules, weeklyHours, specialHours, closures, seatingOptions] = await Promise.all([
    loadRules(env),
    env.DB.prepare(`
      SELECT id, service_name, opens_at_local, closes_at_local
      FROM opening_hours WHERE restaurant_id = ? AND weekday = ? AND active = 1
      ORDER BY opens_at_local
    `).bind(RESTAURANT_ID, weekday).all<OpeningHour>(),
    env.DB.prepare(`
      SELECT id, service_name, opens_at_local, closes_at_local
      FROM restaurant_special_openings WHERE restaurant_id = ? AND opening_date_local = ?
      ORDER BY opens_at_local
    `).bind(RESTAURANT_ID, date).all<OpeningHour>(),
    getClosedIntervals(env, date),
    loadSeatingOptions(env)
  ]);
  const hours = specialHours.results.length ? specialHours : weeklyHours;

  if (partySize > rules.max_party_size_online) return [];
  const options = seatingOptions.filter(option => partySize >= option.minCapacity && partySize <= option.maxCapacity);
  if (!options.length || !hours.results.length) return [];

  const occupiedStartDate = addDays(date, -1);
  const occupiedEndDate = addDays(date, 2);
  const occupied = await loadOccupiedSlots(
    env,
    new Date(`${occupiedStartDate}T00:00:00.000Z`).toISOString(),
    new Date(`${occupiedEndDate}T00:00:00.000Z`).toISOString()
  );

  const result = new Map<string, AvailableSlot>();
  const interval = Math.max(SLOT_MINUTES, rules.slot_interval_minutes);
  const duration = rules.default_duration_minutes;

  for (const service of hours.results) {
    const opening = localDateTimeToEpoch(date, service.opens_at_local);
    const closingDate = localMinute(service.closes_at_local) <= localMinute(service.opens_at_local) ? addDays(date, 1) : date;
    const closing = localDateTimeToEpoch(closingDate, service.closes_at_local);
    if (opening == null || closing == null || closing <= opening) continue;

    const serviceStartLocal = localMinute(service.opens_at_local);
    const lastStartLocal = localMinute(service.closes_at_local) - duration;
    const wrapsMidnight = closingDate !== date;
    let offset = 0;
    while (true) {
      const localStart = addLocalMinutes(date, service.opens_at_local, offset);
      const startsOnDate = localStart.date === date;
      const startLocalMinute = localMinute(localStart.time);
      if (startsOnDate && startLocalMinute > lastStartLocal) break;
      if (!startsOnDate && !wrapsMidnight) break;
      const start = localDateTimeToEpoch(localStart.date, localStart.time);
      if (start == null || start < opening || start + duration * 60000 > closing) {
        offset += interval;
        if (offset > 24 * 60) break;
        continue;
      }
      const end = start + duration * 60000;
      const held = isClosedByException(date, start, end, closures);
      if (!held) {
        const requestedSlots = makeSlotTimes(start, end);
        const seating = options.find(option => option.tableIds.every(tableId =>
          requestedSlots.every(slot => !occupied.has(`${tableId}:${slot}`))
        ));
        if (seating) {
          const time = epochToLocalTime(start);
          result.set(time, { time, startsAtUtc: new Date(start).toISOString(), endsAtUtc: new Date(end).toISOString(), tableIds: seating.tableIds });
        }
      }
      offset += interval;
      if (offset > 24 * 60) break;
      if (startLocalMinute >= serviceStartLocal && startsOnDate && startLocalMinute >= 24 * 60) break;
    }
  }

  return [...result.values()].sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));
}

async function getPublicAvailability(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = isoDate(url.searchParams.get("date"));
  const partySize = Number(url.searchParams.get("party"));
  if (!date) throw new ReservationHttpError("Selecciona una fecha válida.", 400);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) throw new ReservationHttpError("El número de comensales no es válido.", 400);

  const rules = await loadRules(env);
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
  if (date < todayLocal) throw new ReservationHttpError("No puedes consultar fechas pasadas.", 400);
  if (date > addDays(todayLocal, rules.max_days_in_advance)) return response({ date, slots: [], message: "La fecha queda fuera del plazo de reservas." });

  const slots = await calculateAvailability(env, date, partySize);
  const earliest = Date.now() + rules.min_lead_time_minutes * 60000;
  const filtered = slots.filter(slot => Date.parse(slot.startsAtUtc) >= earliest);
  return response({ date, partySize, currency: "EUR", slots: filtered.map(({ time, startsAtUtc }) => ({ time, startsAtUtc })) });
}

async function createPublicReservation(request: Request, env: Env): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 160) {
    throw new ReservationHttpError("Falta una clave de idempotencia válida. Actualiza la página y vuelve a intentarlo.", 400);
  }
  const prior = await env.DB.prepare(`
    SELECT id, status, starts_at_utc FROM reservations
    WHERE restaurant_id = ? AND idempotency_key = ? LIMIT 1
  `).bind(RESTAURANT_ID, idempotencyKey).first<{ id: string; status: string; starts_at_utc: string }>();
  if (prior) return response({ ok: true, reservationId: prior.id, status: prior.status, startsAtUtc: prior.starts_at_utc, repeated: true });

  let bodyValue: unknown;
  try { bodyValue = await request.json(); } catch { throw new ReservationHttpError("El cuerpo de la reserva no es JSON válido.", 400); }
  if (!isPlainObject(bodyValue)) throw new ReservationHttpError("Revisa los datos de la reserva.", 400);
  const body = bodyValue;
  const guestName = requireText(body.guest_name, "El nombre", 120);
  const phone = normalizePhone(body.guest_phone);
  const date = isoDate(typeof body.date === "string" ? body.date : null);
  if (!date) throw new ReservationHttpError("Selecciona una fecha válida.", 400);
  const partySize = Number(body.party_size);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) throw new ReservationHttpError("El número de comensales no es válido.", 400);
  const requestedTime = typeof body.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : null;
  if (!requestedTime) throw new ReservationHttpError("Selecciona una hora disponible.", 400);
  const email = typeof body.guest_email === "string" && body.guest_email.trim().length <= 254 ? body.guest_email.trim() : null;
  const specialRequests = typeof body.special_requests === "string" ? body.special_requests.trim().slice(0, 500) || null : null;
  const whatsappConsent = body.whatsapp_consent === true;

  const rules = await loadRules(env);
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
  if (date < todayLocal || date > addDays(todayLocal, rules.max_days_in_advance)) {
    throw new ReservationHttpError("La fecha solicitada queda fuera del plazo de reservas.", 400);
  }
  if (partySize > rules.max_party_size_online) throw new ReservationHttpError(`Las reservas online admiten hasta ${rules.max_party_size_online} personas.`, 400);

  const slots = await calculateAvailability(env, date, partySize);
  const slot = slots.find(candidate => candidate.time === requestedTime);
  if (!slot) throw new ReservationHttpError("Esa hora ya no está disponible. Elige otra opción.", 409);
  const startsAt = Date.parse(slot.startsAtUtc);
  if (startsAt < Date.now() + rules.min_lead_time_minutes * 60000) {
    throw new ReservationHttpError("La hora elegida queda fuera de la antelación mínima.", 400);
  }

  const now = new Date().toISOString();
  const reservationId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const autoConfirm = rules.auto_confirm === 1;
  const status = autoConfirm ? "confirmed" : "pending";
  const holdExpiresAt = autoConfirm ? null : new Date(Date.now() + rules.pending_hold_minutes * 60000).toISOString();
  const confirmationToken = randomToken();
  const cancellationToken = randomToken();
  const confirmationHash = await sha256(confirmationToken);
  const cancellationHash = await sha256(cancellationToken);
  const expiry = new Date(Math.max(Date.parse(slot.endsAtUtc), Date.now() + 30 * 24 * 60 * 60000)).toISOString();
  const statements: D1PreparedStatement[] = [];

  statements.push(env.DB.prepare(`
    INSERT INTO customers
      (id, restaurant_id, full_name, phone_e164, email, whatsapp_consent_at, consent_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'website_reservation', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(customerId, RESTAURANT_ID, guestName, phone, email, whatsappConsent ? now : null, now, now));
  statements.push(env.DB.prepare(`
    INSERT INTO reservations
      (id, restaurant_id, customer_id, guest_name, guest_phone_e164, guest_email, party_size,
       starts_at_utc, ends_at_utc, service_date_local, status, source, channel_reference,
       special_requests, idempotency_key, confirmed_at, hold_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'website', 'own_website', ?, ?, ?, ?, ?, ?)
  `).bind(
    reservationId, RESTAURANT_ID, customerId, guestName, phone, email, partySize,
    slot.startsAtUtc, slot.endsAtUtc, date, status, specialRequests, idempotencyKey,
    autoConfirm ? now : null, holdExpiresAt, now, now
  ));
  statements.push(env.DB.prepare(`
    INSERT INTO reservation_events (id, reservation_id, event_type, to_status, details_json, created_at)
    VALUES (?, ?, 'created', ?, ?, ?)
  `).bind(crypto.randomUUID(), reservationId, status, JSON.stringify({ source: "website", party_size: partySize, time: requestedTime }), now));
  statements.push(env.DB.prepare(`
    INSERT INTO reservation_action_tokens (token_hash, reservation_id, action, expires_at_utc)
    VALUES (?, ?, 'confirm', ?), (?, ?, 'cancel', ?)
  `).bind(confirmationHash, reservationId, expiry, cancellationHash, reservationId, expiry));

  statements.push(env.DB.prepare(`
    INSERT INTO reservation_tables (reservation_id, table_id)
    VALUES ${slot.tableIds.map(() => "(?, ?)").join(", ")}
  `).bind(...slot.tableIds.flatMap(tableId => [reservationId, tableId])));

  const lockSlots = makeSlotTimes(Date.parse(slot.startsAtUtc), Date.parse(slot.endsAtUtc));
  statements.push(env.DB.prepare(`
    INSERT INTO reservation_table_slots (table_id, slot_start_utc, reservation_id)
    VALUES ${slot.tableIds.flatMap(() => lockSlots.map(() => "(?, ?, ?)" )).join(", ")}
  `).bind(...slot.tableIds.flatMap(tableId => lockSlots.map(slotStart => [tableId, slotStart, reservationId])).flat()));

  statements.push(env.DB.prepare(`
    INSERT INTO outbox_events (id, restaurant_id, event_type, aggregate_type, aggregate_id, payload_json)
    VALUES (?, ?, 'reservation.created', 'reservation', ?, ?)
  `).bind(crypto.randomUUID(), RESTAURANT_ID, reservationId, JSON.stringify({
    reservation_id: reservationId,
    guest_name: guestName,
    guest_phone_e164: phone,
    party_size: partySize,
    service_date_local: date,
    time_local: requestedTime,
    status,
    whatsapp_consent: whatsappConsent,
    confirm_url: actionUrl(request, "confirm", confirmationToken),
    cancel_url: actionUrl(request, "cancel", cancellationToken)
  })));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const repeated = await env.DB.prepare(`SELECT id, status, starts_at_utc FROM reservations WHERE restaurant_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(RESTAURANT_ID, idempotencyKey).first<{ id: string; status: string; starts_at_utc: string }>();
    if (repeated) return response({ ok: true, reservationId: repeated.id, status: repeated.status, startsAtUtc: repeated.starts_at_utc, repeated: true });
    if (error instanceof Error && /UNIQUE constraint failed: reservation_table_slots/.test(error.message)) {
      throw new ReservationHttpError("Ese horario se acaba de ocupar. Elige otra hora disponible.", 409);
    }
    throw error;
  }

  try {
    await env.EVENTS_QUEUE.send({ type: "reservation.created", reservation_id: reservationId });
  } catch (error) {
    console.error("Could not enqueue reservation notification", error instanceof Error ? error.message : "Unknown error");
  }

  return response({
    ok: true,
    reservationId,
    status,
    startsAtUtc: slot.startsAtUtc,
    time: requestedTime,
    partySize,
    confirmationUrl: actionUrl(request, "confirm", confirmationToken),
    cancellationUrl: actionUrl(request, "cancel", cancellationToken),
    notification: env.TWILIO_ACCOUNT_SID ? "queued" : "not_configured"
  }, 201);
}

async function updateActionToken(request: Request, env: Env, action: "confirm" | "cancel", token: string): Promise<Response> {
  if (token.length < 32 || token.length > 160) throw new ReservationHttpError("El enlace de reserva no es válido.", 404);
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const actionToken = await env.DB.prepare(`
    SELECT t.reservation_id, r.status, r.starts_at_utc, r.ends_at_utc,
           r.service_date_local, r.party_size, r.guest_name, r.hold_expires_at
    FROM reservation_action_tokens t
    JOIN reservations r ON r.id = t.reservation_id
    WHERE t.token_hash = ? AND t.action = ? AND t.used_at_utc IS NULL AND t.expires_at_utc > ?
    LIMIT 1
  `).bind(tokenHash, action, now).first<{
    reservation_id: string;
    status: string;
    starts_at_utc: string;
    ends_at_utc: string;
    service_date_local: string;
    party_size: number;
    guest_name: string;
    hold_expires_at: string | null;
  }>();
  if (!actionToken) throw new ReservationHttpError("El enlace ya se usó, ha caducado o no es válido.", 410);

  if (action === "confirm") {
    if (actionToken.status !== "pending") throw new ReservationHttpError("Esta reserva ya no está pendiente de confirmación.", 409);
    if (actionToken.hold_expires_at && actionToken.hold_expires_at <= now) throw new ReservationHttpError("El plazo para confirmar esta reserva ha terminado.", 410);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE reservation_action_tokens SET used_at_utc = ? WHERE token_hash = ? AND used_at_utc IS NULL`).bind(now, tokenHash),
      env.DB.prepare(`UPDATE reservations SET status = 'confirmed', confirmed_at = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(now, now, actionToken.reservation_id),
      env.DB.prepare(`INSERT INTO reservation_events (id, reservation_id, event_type, from_status, to_status, created_at) VALUES (?, ?, 'guest_confirmed', 'pending', 'confirmed', ?)`).bind(crypto.randomUUID(), actionToken.reservation_id, now)
    ]);
    if (Number(results[1].meta.changes) !== 1) throw new ReservationHttpError("No se pudo confirmar la reserva. Consulta su estado.", 409);
  } else {
    if (!["pending", "confirmed"].includes(actionToken.status)) throw new ReservationHttpError("Esta reserva ya no se puede cancelar desde este enlace.", 409);
    const rules = await loadRules(env);
    const cutoff = Date.parse(actionToken.starts_at_utc) - rules.cancellation_cutoff_minutes * 60000;
    if (Date.now() > cutoff) throw new ReservationHttpError("El plazo para cancelar online ha terminado. Contacta con el restaurante.", 409);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE reservation_action_tokens SET used_at_utc = ? WHERE token_hash = ? AND used_at_utc IS NULL`).bind(now, tokenHash),
      env.DB.prepare(`UPDATE reservations SET status = 'cancelled', cancelled_at = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','confirmed')`).bind(now, now, actionToken.reservation_id),
      env.DB.prepare(`DELETE FROM reservation_table_slots WHERE reservation_id = ?`).bind(actionToken.reservation_id),
      env.DB.prepare(`INSERT INTO reservation_events (id, reservation_id, event_type, from_status, to_status, created_at) VALUES (?, ?, 'guest_cancelled', ?, 'cancelled', ?)`).bind(crypto.randomUUID(), actionToken.reservation_id, actionToken.status, now)
    ]);
    if (Number(results[1].meta.changes) !== 1) throw new ReservationHttpError("No se pudo cancelar la reserva. Consulta su estado.", 409);
  }

  const verb = action === "confirm" ? "confirmada" : "cancelada";
  return response({
    ok: true,
    action,
    message: `La reserva de ${actionToken.guest_name} para ${actionToken.party_size} personas el ${actionToken.service_date_local} a las ${epochToLocalTime(Date.parse(actionToken.starts_at_utc))} está ${verb}.`
  });
}

async function listAdminReservations(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = isoDate(url.searchParams.get("date"));
  if (!date) throw new ReservationHttpError("Indica una fecha de servicio válida.", 400);
  const status = url.searchParams.get("status")?.trim();
  const validStatuses = new Set(["pending", "confirmed", "seated", "completed", "cancelled", "no_show", "rejected"]);
  if (status && !validStatuses.has(status)) throw new ReservationHttpError("El filtro de estado no es válido.", 400);
  const staff = await requireAdmin(request, env, READ_ROLES);
  const results = await env.DB.prepare(`
    SELECT r.id, r.guest_name, r.guest_phone_e164, r.guest_email, r.party_size,
           r.starts_at_utc, r.ends_at_utc, r.service_date_local, r.status, r.source,
           r.special_requests, r.internal_notes, r.hold_expires_at,
           GROUP_CONCAT(COALESCE(t.display_name, t.table_code), ', ') AS assigned_tables
    FROM reservations r
    LEFT JOIN reservation_tables rt ON rt.reservation_id = r.id
    LEFT JOIN dining_tables t ON t.id = rt.table_id
    WHERE r.restaurant_id = ? AND r.service_date_local = ? ${status ? "AND r.status = ?" : ""}
    GROUP BY r.id
    ORDER BY r.starts_at_utc, r.created_at
  `).bind(...(status ? [RESTAURANT_ID, date, status] : [RESTAURANT_ID, date])).all();
  return response({ date, reservations: results.results, viewer: { role: staff.role } });
}

async function updateAdminReservation(request: Request, env: Env, reservationId: string): Promise<Response> {
  const staff = await requireAdmin(request, env, WRITE_ROLES);
  let bodyValue: unknown;
  try { bodyValue = await request.json(); } catch { throw new ReservationHttpError("El cuerpo de la solicitud no es JSON válido.", 400); }
  if (!isPlainObject(bodyValue) || typeof bodyValue.status !== "string") throw new ReservationHttpError("Indica el nuevo estado de la reserva.", 400);
  const newStatus = bodyValue.status;
  const validStatuses = new Set(["pending", "confirmed", "seated", "completed", "cancelled", "no_show", "rejected"]);
  if (!validStatuses.has(newStatus)) throw new ReservationHttpError("El estado indicado no es válido.", 400);
  const reservation = await env.DB.prepare(`SELECT id, status, starts_at_utc FROM reservations WHERE id = ? AND restaurant_id = ? LIMIT 1`)
    .bind(reservationId, RESTAURANT_ID).first<{ id: string; status: string; starts_at_utc: string }>();
  if (!reservation) throw new ReservationHttpError("No encontramos esta reserva.", 404);
  if (reservation.status === newStatus) return response({ ok: true, status: newStatus, unchanged: true });
  const now = new Date().toISOString();
  const terminal = ["completed", "cancelled", "no_show", "rejected"].includes(newStatus);
  const extra: D1PreparedStatement[] = [];
  if (terminal) extra.push(env.DB.prepare(`DELETE FROM reservation_table_slots WHERE reservation_id = ?`).bind(reservationId));
  if (newStatus === "confirmed") {
    extra.push(env.DB.prepare(`UPDATE reservations SET confirmed_at = ?, hold_expires_at = NULL WHERE id = ?`).bind(now, reservationId));
  }
  if (newStatus === "cancelled") {
    extra.push(env.DB.prepare(`UPDATE reservations SET cancelled_at = ? WHERE id = ?`).bind(now, reservationId));
  }
  const statusStatement = env.DB.prepare(`
    UPDATE reservations SET status = ?, updated_at = ? WHERE id = ? AND status = ?
  `).bind(newStatus, now, reservationId, reservation.status);
  const eventStatement = env.DB.prepare(`
    INSERT INTO reservation_events (id, reservation_id, actor_staff_id, event_type, from_status, to_status, details_json, created_at)
    VALUES (?, ?, ?, 'admin_status_changed', ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), reservationId, staff.staffId, reservation.status, newStatus, JSON.stringify({ source: "admin_panel" }), now);
  const auditStatement = env.DB.prepare(`
    INSERT INTO audit_logs (id, restaurant_id, actor_staff_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (?, ?, ?, 'update_status', 'reservation', ?, ?, ?)
  `).bind(crypto.randomUUID(), RESTAURANT_ID, staff.staffId, reservationId, JSON.stringify({ status: reservation.status }), JSON.stringify({ status: newStatus }));
  const results = await env.DB.batch([statusStatement, ...extra, eventStatement, auditStatement]);
  if (Number(results[0].meta.changes) !== 1) throw new ReservationHttpError("La reserva cambió mientras la estabas editando. Actualiza la lista.", 409);
  return response({ ok: true, status: newStatus });
}

function handleReservationError(error: unknown): Response | null {
  if (error instanceof AdminAuthError) return response({ error: error.message }, error.status);
  if (error instanceof ReservationHttpError) return response({ error: error.message }, error.status);
  return null;
}

export async function handleReservationRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  try {
    if (url.pathname === "/api/public/availability" && method === "GET") return await getPublicAvailability(request, env);
    if (url.pathname === "/api/public/reservations" && method === "POST") return await createPublicReservation(request, env);

    const actionMatch = url.pathname.match(/^\/api\/public\/reservations\/([^/]+)\/(confirm|cancel)$/);
    if (actionMatch && method === "POST") return await updateActionToken(request, env, actionMatch[2] as "confirm" | "cancel", decodeURIComponent(actionMatch[1]));

    if (url.pathname === "/api/admin/reservations" && method === "GET") return await listAdminReservations(request, env);
    const adminReservationMatch = url.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/status$/);
    if (adminReservationMatch && method === "POST") return await updateAdminReservation(request, env, decodeURIComponent(adminReservationMatch[1]));

    return null;
  } catch (error) {
    const handled = handleReservationError(error);
    if (handled) return handled;
    throw error;
  }
}
