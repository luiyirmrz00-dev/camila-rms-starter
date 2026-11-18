import type { Env } from "../index";

export type StaffRole = "owner" | "manager" | "host" | "server" | "kitchen" | "finance";

export interface AdminIdentity {
  staffId: string;
  email: string;
  displayName: string;
  role: StaffRole;
}

export class AdminAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

interface AccessClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

let jwksCache: { domain: string; expiresAt: number; keys: AccessJwk[] } | null = null;

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
}

async function getAccessKeys(domain: string): Promise<AccessJwk[]> {
  const now = Date.now();
  if (jwksCache?.domain === domain && jwksCache.expiresAt > now) return jwksCache.keys;

  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true }
  } as RequestInit);
  if (!response.ok) throw new AdminAuthError("No se pudo validar el acceso del panel.", 503);

  const payload = await response.json() as { keys?: AccessJwk[] };
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new AdminAuthError("Cloudflare Access no devolvió claves de verificación.", 503);
  }

  jwksCache = { domain, expiresAt: now + 60 * 60 * 1000, keys: payload.keys };
  return payload.keys;
}

async function verifyAccessJwt(token: string, env: Env): Promise<AccessClaims> {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = env.ACCESS_AUD?.trim();
  if (!domain || !audience) throw new AdminAuthError("Cloudflare Access no está configurado para el panel.", 503);

  const parts = token.split(".");
  if (parts.length !== 3) throw new AdminAuthError("Acceso no válido.", 401);

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
  } catch {
    throw new AdminAuthError("Acceso no válido.", 401);
  }

  if (header.alg !== "RS256" || !header.kid) throw new AdminAuthError("Acceso no válido.", 401);
  const key = (await getAccessKeys(domain)).find(candidate => candidate.kid === header.kid && (!candidate.alg || candidate.alg === "RS256"));
  if (!key) throw new AdminAuthError("La clave de acceso ha cambiado. Vuelve a iniciar sesión.", 401);

  let validSignature = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    throw new AdminAuthError("No se pudo validar el acceso del panel.", 503);
  }
  if (!validSignature) throw new AdminAuthError("Acceso no válido.", 401);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokenAudience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${domain}` || !tokenAudience.includes(audience)) {
    throw new AdminAuthError("La sesión no pertenece a esta aplicación.", 401);
  }
  if (!claims.exp || claims.exp <= nowSeconds || (claims.nbf && claims.nbf > nowSeconds)) {
    throw new AdminAuthError("La sesión ha caducado. Vuelve a iniciar sesión.", 401);
  }
  if (!claims.email || !claims.sub) throw new AdminAuthError("La sesión no incluye una identidad autorizada.", 401);
  return claims;
}

export async function requireAdmin(
  request: Request,
  env: Env,
  allowedRoles?: StaffRole[]
): Promise<AdminIdentity> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new AdminAuthError("Inicia sesión con Cloudflare Access para continuar.", 401);
  const claims = await verifyAccessJwt(assertion, env);

  const staff = await env.DB.prepare(`
    SELECT id, access_email, display_name, role
    FROM staff_users
    WHERE restaurant_id = ? AND access_email = ? COLLATE NOCASE AND is_active = 1
    LIMIT 1
  `).bind("camila-gastrobar", claims.email).first<{
    id: string;
    access_email: string;
    display_name: string;
    role: StaffRole;
  }>();
  if (!staff) throw new AdminAuthError("Tu cuenta no tiene acceso al panel de Camila.", 403);
  const subjectBinding = await env.DB.prepare(`
    UPDATE staff_users SET access_subject = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND access_subject IS NULL
  `).bind(claims.sub, staff.id).run();
  const currentStaff = await env.DB.prepare(`
    SELECT access_subject FROM staff_users WHERE id = ? LIMIT 1
  `).bind(staff.id).first<{ access_subject: string | null }>();
  if (subjectBinding.meta.changes !== 1 && currentStaff?.access_subject !== claims.sub) {
    throw new AdminAuthError("Esta cuenta de Cloudflare Access no coincide con el administrador autorizado.", 403);
  }
  if (allowedRoles && !allowedRoles.includes(staff.role)) {
    throw new AdminAuthError("Tu rol no permite realizar esta acción.", 403);
  }

  return {
    staffId: staff.id,
    email: staff.access_email,
    displayName: staff.display_name,
    role: staff.role
  };
}

export async function bootstrapFirstOwner(request: Request, env: Env): Promise<Response> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new AdminAuthError("Inicia sesión con Cloudflare Access para continuar.", 401);
  const claims = await verifyAccessJwt(assertion, env);
  if (!claims.email || !claims.sub) throw new AdminAuthError("La sesión no incluye una identidad autorizada.", 401);
  const bootstrapEmails = (env.ACCESS_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map(email => email.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (!bootstrapEmails.includes(claims.email.toLocaleLowerCase("en-US"))) {
    throw new AdminAuthError("Esta cuenta no está autorizada para configurar un administrador.", 403);
  }

  const email = claims.email;
  const displayName = email.split("@")[0].replace(/[._-]+/g, " ").trim() || email;
  const existing = await env.DB.prepare(`
    SELECT id FROM staff_users WHERE restaurant_id = ? AND access_email = ? COLLATE NOCASE LIMIT 1
  `).bind("camila-gastrobar", email).first<{ id: string }>();
  if (existing) throw new AdminAuthError("Esta cuenta ya está configurada para el panel.", 409);

  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`
    INSERT INTO staff_users
      (id, restaurant_id, access_email, access_subject, display_name, role, is_active)
    SELECT ?, 'camila-gastrobar', ?, ?, ?,
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM staff_users WHERE restaurant_id = 'camila-gastrobar' AND role = 'owner'
      ) THEN 'owner' ELSE 'manager' END,
      1
  `).bind(id, email, claims.sub, displayName).run();

  if (result.meta.changes !== 1) {
    throw new AdminAuthError("No se pudo configurar la cuenta del administrador.", 409);
  }
  return Response.json({ ok: true, message: "Cuenta de administrador configurada." }, {
    headers: { "cache-control": "no-store" }
  });
}

export async function requireBootstrapOwner(request: Request, env: Env): Promise<void> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new AdminAuthError("Inicia sesión con Cloudflare Access para continuar.", 401);
  const claims = await verifyAccessJwt(assertion, env);
  const bootstrapEmails = (env.ACCESS_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map(email => email.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (!claims.email || !bootstrapEmails.includes(claims.email.toLocaleLowerCase("en-US"))) {
    throw new AdminAuthError("Esta cuenta no está autorizada para configurar un administrador.", 403);
  }
  const existing = await env.DB.prepare(`
    SELECT id FROM staff_users WHERE restaurant_id = ? AND access_email = ? COLLATE NOCASE LIMIT 1
  `).bind("camila-gastrobar", claims.email).first<{ id: string }>();
  if (existing) throw new AdminAuthError("Esta cuenta ya está configurada para el panel.", 404);
}
