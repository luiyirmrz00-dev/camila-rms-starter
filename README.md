# Camila Gastrobar — Restaurant Management System (starter)

Base técnica inicial para una plataforma propia alojada en Cloudflare. Este repositorio **no es todavía un sistema listo para producción**: deja definida la base de datos, la carcasa del Worker, una primera carta pública y los contratos de integración. Las conexiones externas permanecen desactivadas hasta configurar credenciales, validaciones, aprobaciones y pruebas.

## Decisiones arquitectónicas

- Cloudflare Workers: API y lógica del backend.
- Cloudflare D1: datos operativos. La configuración solicita jurisdicción `eu`.
- Cloudflare R2: fotos y medios.
- Cloudflare Queues: trabajos asíncronos y reintentos.
- Cron Triggers: reconciliaciones y tareas periódicas.
- Cloudflare Access: protección del panel privado; el RBAC de la aplicación se aplica además en cada endpoint.
- Twilio: SMS/WhatsApp con adaptador reemplazable.
- Loyverse: fuente de verdad para artículos, categorías, variantes y precios del TPV.
- Google Actions Center: enlace propio de reservas como primer paso; reservas End-to-End sólo tras aceptación como partner.

## Requisitos

- Node.js LTS
- npm
- Cuenta Cloudflare con Workers, D1, R2 y Queues habilitados
- Wrangler CLI (incluido como dependencia de desarrollo)

## Puesta en marcha local

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

La página pública presenta el catálogo de Loyverse. En un entorno nuevo, configura `LOYVERSE_ACCESS_TOKEN` y `LOYVERSE_STORE_ID` en `.dev.vars` y sincroniza el catálogo; en producción, el cron configurado refresca categorías, artículos y variantes cada 5 minutos usando cambios desde la última lectura. El endpoint público expone la hora de la última sincronización.

La sincronización automática requiere `LOYVERSE_ACCESS_TOKEN` y `LOYVERSE_STORE_ID` como Worker Secrets en Cloudflare. En local, las rutas `/api/dev/loyverse/*` permiten descubrir la tienda y sincronizar el catálogo; esas rutas sólo están disponibles con `APP_ENV=development`.

## Crear recursos en Cloudflare

1. Ejecuta `npx wrangler d1 create camila-rms-db`.
2. Copia el `database_id` devuelto a `wrangler.jsonc`.
3. Crea el bucket `camila-rms-media` y las queues `camila-rms-events` y `camila-rms-events-dlq` (por ejemplo, con `npx wrangler r2 bucket create camila-rms-media`, `npx wrangler queues create camila-rms-events` y `npx wrangler queues create camila-rms-events-dlq`).
4. Ejecuta `npm run db:migrate:remote`.
5. Añade los secretos con `npx wrangler secret put NOMBRE_DEL_SECRETO`.
6. Configura Cloudflare Access antes de publicar cualquier panel o endpoint administrativo.

## Endpoints incluidos

- `GET /api/health`
- `GET /api/public/restaurant`
- `GET /api/public/menu`

Las rutas `/api/admin/*` y `/webhooks/*` devuelven 503 intencionadamente hasta implementar autenticación, RBAC, validación de proveedores e idempotencia. No se deben activar reservas reales con un motor de disponibilidad incompleto.

## Siguientes hitos de desarrollo

1. Configuración Cloudflare real y control de acceso (Access + JWT + RBAC).
2. Adaptador Loyverse: sincronización completa y por eventos, respetando tienda y variantes.
3. Administrador de carta: fotos en R2, descripciones, alérgenos, visibilidad y destacados.
4. Motor de reservas transaccional: disponibilidad, duración, bloqueos de slots, combinaciones de mesas y lista de espera.
5. Plano visual de sala y panel operativo.
6. Mensajería Twilio: plantillas, consentimiento, callbacks, respuestas e idempotencia.
7. Google Actions Center: solicitar acceso a Reservations End-to-End cuando el motor de reservas esté operativo.

## Documentación adicional

- `docs/data-model.md`: entidades, relaciones y reglas de reserva.
- `docs/integrations.md`: límites y requisitos de cada proveedor.
- `docs/api-contract.md`: rutas previstas y comportamiento de la API.
- `docs/reservations-roadmap.md`: alcance, fases y datos pendientes del sistema de reservas.

## Seguridad y datos personales

No introduzcas tokens reales en archivos del proyecto, commits o chat. Usa Worker Secrets. No almacenar datos de tarjeta. Configurar política de privacidad, conservación, acceso y supresión de datos conforme al RGPD antes de usarlo con clientes reales.
