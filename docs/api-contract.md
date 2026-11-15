# API contract — planned endpoints

This list is the target API surface. Only `/api/health`, `/api/public/restaurant`, and `/api/public/menu` are implemented in the starter. Protected and webhook routes intentionally return 503 until their security and processing layers are complete.

## Public

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/public/restaurant` | Public restaurant details |
| GET | `/api/public/menu` | Public menu, visible items and variant prices |
| GET | `/api/public/availability?date=YYYY-MM-DD&party=4` | Available time slots and table capacity |
| POST | `/api/public/reservations` | Create a pending/confirmed reservation; idempotency key required |
| POST | `/api/public/reservation-lookup/request-code` | Send an OTP to verify the reservation phone |
| POST | `/api/public/reservation-lookup/verify-code` | Verify the phone and return guest-safe reservations |
| POST | `/api/public/reservations/:token/confirm` | Confirm by random, single-use action link |
| POST | `/api/public/reservations/:token/cancel` | Cancel by random, single-use action link |

## Admin — Cloudflare Access + RBAC required

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/admin/dashboard` | Today's operating overview |
| GET/POST/PATCH | `/api/admin/reservations` | Search/create/update reservations |
| POST | `/api/admin/reservations/:id/assign-tables` | Assign or move table(s) |
| POST | `/api/admin/reservations/:id/status` | Check-in, seat, complete, no-show, cancel |
| GET/POST/PATCH | `/api/admin/floorplan/*` | Dining areas, table layout and combinations |
| GET/POST/PATCH/DELETE | `/api/admin/opening-hours/*` | Weekly services, special closures and reservation rules |
| GET/POST/PATCH | `/api/admin/waitlist` | Waitlist and notification offers |
| GET/PATCH | `/api/admin/customers/*` | Guest history, notes, labels and message consent |
| POST | `/api/admin/integrations/loyverse/sync` | Force an immediate catalog and price refresh |
| GET/POST/PATCH | `/api/admin/menu/*` | Web-only presentation and visibility |
| GET | `/api/admin/reports/operations` | Reservation, capacity, and service reporting |
| GET | `/api/admin/audit` | Staff action history |

## Provider webhooks

| Method | Route | Purpose |
|---|---|---|
| POST | `/webhooks/loyverse` | Item/category events; API re-fetch is authoritative |
| POST | `/webhooks/twilio/messages` | Inbound SMS/WhatsApp replies |
| POST | `/webhooks/twilio/status` | Outbound delivery status callbacks |

## Response conventions

- JSON responses use UTF-8 and no-store for operational endpoints.
- Mutating endpoints must require an idempotency key where retries are possible.
- Public endpoints expose only guest-safe fields; never expose internal notes, staff details, raw provider payloads or phone numbers of other guests.
- Every admin mutation writes an audit event.
- External side effects (message sends, provider API calls) are dispatched asynchronously after the primary database write.
