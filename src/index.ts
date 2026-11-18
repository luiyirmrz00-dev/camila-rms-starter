import {
  getLoyverseSyncCheckpoint,
  handleLoyverseDevRoute,
  LoyverseError,
  recordLoyverseSyncFailure,
  syncCatalog
} from "./integrations/loyverse";
import { AdminAuthError, bootstrapFirstOwner, requireAdmin, requireBootstrapOwner } from "./integrations/access";
import { handleAdminSetupRoute } from "./admin-setup";
import { handleReservationRoute } from "./reservations";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  EVENTS_QUEUE: Queue;
  ASSETS: Fetcher;
  APP_ENV: string;
  RESTAURANT_TIMEZONE: string;
  CURRENCY: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_BOOTSTRAP_EMAILS?: string;
  LOYVERSE_ACCESS_TOKEN?: string;
  LOYVERSE_STORE_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  TWILIO_WHATSAPP_FROM?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === "/api/admin/bootstrap") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      return await bootstrapFirstOwner(request, env);
    } catch (error) {
      if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
      throw error;
    }
  }

  if (url.pathname === "/api/health" && method === "GET") {
    return json({
      ok: true,
      service: "camila-gastrobar-rms",
      environment: env.APP_ENV,
      timestamp: new Date().toISOString()
    });
  }

  if (url.pathname === "/api/public/restaurant" && method === "GET") {
    const restaurant = await env.DB.prepare(
      "SELECT name, timezone, currency, phone_e164, email, address FROM restaurants WHERE id = ? LIMIT 1"
    ).bind("camila-gastrobar").first();
    return restaurant ? json(restaurant) : json({ error: "Restaurant not configured" }, 404);
  }

  if (url.pathname === "/api/public/menu" && method === "GET") {
    const [{ results }, sync] = await Promise.all([
      env.DB.prepare(`
      SELECT
        c.id AS category_id,
        c.name AS category_name,
        c.sort_order AS category_sort_order,
        i.id AS item_id,
        i.name AS item_name,
        COALESCE(p.public_description, i.description, '') AS description,
        p.image_key AS image_key,
        p.featured AS featured,
        p.sort_order AS item_sort_order,
        p.dietary_tags_json AS dietary_tags_json,
        p.allergens_json AS allergens_json,
        p.spice_level AS spice_level,
        v.id AS variant_id,
        v.name AS variant_name,
        v.price_minor AS price_minor,
        v.currency AS currency
      FROM catalog_items i
      JOIN menu_item_presentation p ON p.item_id = i.id AND p.visible = 1
      LEFT JOIN menu_categories c ON c.id = i.category_id AND c.active = 1
      LEFT JOIN catalog_variants v ON v.item_id = i.id AND v.active = 1
        AND (i.track_stock = 0 OR COALESCE(v.in_stock, 0) > 0)
      WHERE i.restaurant_id = ? AND i.active = 1 AND i.available_for_sale = 1
        AND (i.track_stock = 0 OR EXISTS (
          SELECT 1 FROM catalog_variants stock_variant
          WHERE stock_variant.item_id = i.id AND stock_variant.active = 1
            AND COALESCE(stock_variant.in_stock, 0) > 0
        ))
      ORDER BY c.sort_order, c.name, p.sort_order, i.name, v.name
      `).bind("camila-gastrobar").all(),
      env.DB.prepare(`
        SELECT last_success_at
        FROM integrations
        WHERE restaurant_id = ? AND provider = 'loyverse'
        LIMIT 1
      `).bind("camila-gastrobar").first<{ last_success_at: string | null }>()
    ]);
    return json({ items: results, currency: env.CURRENCY, lastSyncedAt: sync?.last_success_at ?? null });
  }

  if (url.pathname === "/api/admin/integrations/loyverse/sync" && method === "POST") {
    try {
      const staff = await requireAdmin(request, env, ["owner", "manager"]);
      if (!env.LOYVERSE_STORE_ID) return json({ error: "Falta configurar LOYVERSE_STORE_ID para este establecimiento." }, 503);
      const checkpoint = await getLoyverseSyncCheckpoint(env);
      const updatedAtMin = checkpoint
        ? new Date(Date.parse(checkpoint) - 2 * 60 * 1000).toISOString()
        : undefined;
      const result = await syncCatalog(env, env.LOYVERSE_STORE_ID, updatedAtMin);
      await env.DB.prepare(`
        INSERT INTO audit_logs (id, restaurant_id, actor_staff_id, action, entity_type, entity_id, after_json)
        VALUES (?, 'camila-gastrobar', ?, 'sync', 'loyverse_catalog', ?, ?)
      `).bind(
        crypto.randomUUID(), staff.staffId, result.store.id,
        JSON.stringify({ categories: result.categories, items: result.items, variants: result.variants })
      ).run();
      return json({ ok: true, message: "Carta actualizada desde Loyverse.", ...result });
    } catch (error) {
      if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
      if (error instanceof LoyverseError) return json({ error: error.message }, error.status >= 400 && error.status <= 599 ? error.status : 502);
      throw error;
    }
  }

  const reservationRoute = await handleReservationRoute(request, env);
  if (reservationRoute) return reservationRoute;

  // Development-only diagnostics and initial catalogue import. These routes are
  // deliberately unavailable outside APP_ENV=development until admin auth/RBAC exists.
  const loyverseRoute = await handleLoyverseDevRoute(request, env);
  if (loyverseRoute) return loyverseRoute;

  if (url.pathname.startsWith("/api/admin/")) {
    const setupRoute = await handleAdminSetupRoute(request, env);
    if (setupRoute) return setupRoute;

    // Admin routes remain disabled until Cloudflare Access JWT verification
    // and per-role authorization are configured. Do not rely on a hidden URL.
    return json({ error: "Admin API not enabled. Configure Cloudflare Access and RBAC first." }, 503);
  }

  if (url.pathname.startsWith("/webhooks/")) {
    // Provider webhooks must validate provider authenticity and idempotency
    // before processing. Do not accept live events until each adapter is configured.
    return json({ error: "Webhook adapter not configured" }, 503);
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const isBootstrapPage = url.pathname === "/admin/bootstrap" || url.pathname === "/admin/bootstrap.html";
      try {
        if (isBootstrapPage) await requireBootstrapOwner(request, env);
        else {
          try {
            await requireAdmin(request, env);
          } catch (error) {
            if (error instanceof AdminAuthError && error.status === 403) {
              try {
                await requireBootstrapOwner(request, env);
                return Response.redirect(new URL("/admin/bootstrap", url).toString(), 302);
              } catch {
                // Preserve the original admin authorization error for non-bootstrap users.
              }
            }
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
        return json({ error: "No se pudo validar el acceso al panel." }, 503);
      }
      if (url.pathname === "/admin") return Response.redirect(new URL("/admin/", url).toString(), 302);
      return env.ASSETS.fetch(request);
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/webhooks/")) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error("API request failed", error);
        return json({ error: "Internal server error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.LOYVERSE_ACCESS_TOKEN || !env.LOYVERSE_STORE_ID) return;

    ctx.waitUntil((async () => {
      try {
        const checkpoint = await getLoyverseSyncCheckpoint(env);
        const updatedAtMin = checkpoint
          ? new Date(Date.parse(checkpoint) - 2 * 60 * 1000).toISOString()
          : undefined;
        const result = await syncCatalog(env, env.LOYVERSE_STORE_ID!, updatedAtMin);
        console.log("Loyverse catalog sync completed", JSON.stringify({
          categories: result.categories,
          changedItems: result.items,
          changedVariants: result.variants,
          unavailable: result.unavailable
        }));
      } catch (error) {
        try {
          await recordLoyverseSyncFailure(env, error);
        } catch {
          console.error("Could not record Loyverse sync failure");
        }
        console.error("Loyverse scheduled sync failed", error instanceof Error ? error.message : "Unknown error");
      }
    })());
  },

  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    // Queue consumer intentionally does not perform side effects yet.
    // Implement typed handlers and dead-letter observability before connecting
    // production providers. Acknowledge only after successful processing.
    for (const message of batch.messages) {
      console.log("Received unconfigured queue message", message.id);
      message.retry();
    }
  }
} satisfies ExportedHandler<Env>;
