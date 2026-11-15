PRAGMA foreign_keys = ON;

-- Restaurant and staff access -------------------------------------------------
CREATE TABLE restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  currency TEXT NOT NULL DEFAULT 'EUR',
  phone_e164 TEXT,
  email TEXT,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  access_email TEXT NOT NULL COLLATE NOCASE,
  access_subject TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','host','server','kitchen','finance')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (restaurant_id, access_email)
);
CREATE INDEX idx_staff_restaurant_active ON staff_users(restaurant_id, is_active, role);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  actor_staff_id TEXT REFERENCES staff_users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);

-- Floor plan -----------------------------------------------------------------
CREATE TABLE dining_areas (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE dining_tables (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  area_id TEXT NOT NULL REFERENCES dining_areas(id),
  table_code TEXT NOT NULL,
  display_name TEXT,
  min_capacity INTEGER NOT NULL DEFAULT 1 CHECK (min_capacity >= 1),
  max_capacity INTEGER NOT NULL CHECK (max_capacity >= min_capacity),
  shape TEXT NOT NULL DEFAULT 'round' CHECK (shape IN ('round','square','rectangle','booth')),
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  rotation REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (restaurant_id, table_code)
);
CREATE INDEX idx_tables_area ON dining_tables(area_id, active);

CREATE TABLE table_combinations (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  max_capacity INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE table_combination_members (
  combination_id TEXT NOT NULL REFERENCES table_combinations(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  PRIMARY KEY (combination_id, table_id),
  UNIQUE (combination_id, table_id)
);

-- Opening hours and reservation rules ---------------------------------------
CREATE TABLE opening_hours (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  service_name TEXT NOT NULL DEFAULT 'general',
  opens_at_local TEXT NOT NULL,
  closes_at_local TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (restaurant_id, weekday, service_name, opens_at_local)
);

CREATE TABLE reservation_rules (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id),
  default_duration_minutes INTEGER NOT NULL DEFAULT 105,
  slot_interval_minutes INTEGER NOT NULL DEFAULT 15,
  max_party_size_online INTEGER NOT NULL DEFAULT 8,
  min_lead_time_minutes INTEGER NOT NULL DEFAULT 60,
  max_days_in_advance INTEGER NOT NULL DEFAULT 60,
  auto_confirm INTEGER NOT NULL DEFAULT 0 CHECK (auto_confirm IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Customers and consent -------------------------------------------------------
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  full_name TEXT NOT NULL,
  phone_e164 TEXT,
  email TEXT,
  notes TEXT,
  sms_consent_at TEXT,
  whatsapp_consent_at TEXT,
  marketing_consent_at TEXT,
  consent_source TEXT,
  last_visit_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_customers_phone ON customers(restaurant_id, phone_e164);

-- Reservations ---------------------------------------------------------------
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  customer_id TEXT REFERENCES customers(id),
  guest_name TEXT NOT NULL,
  guest_phone_e164 TEXT,
  guest_email TEXT,
  party_size INTEGER NOT NULL CHECK (party_size >= 1),
  starts_at_utc TEXT NOT NULL,
  ends_at_utc TEXT NOT NULL,
  service_date_local TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','seated','completed','cancelled','no_show','rejected')),
  source TEXT NOT NULL CHECK (source IN ('website','google','phone','walk_in','staff','covermanager_import','other')),
  channel_reference TEXT,
  special_requests TEXT,
  internal_notes TEXT,
  high_chair_count INTEGER NOT NULL DEFAULT 0,
  accessibility_needs TEXT,
  assigned_by_staff_id TEXT REFERENCES staff_users(id),
  checked_in_at TEXT,
  seated_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (ends_at_utc > starts_at_utc),
  UNIQUE (restaurant_id, idempotency_key)
);
CREATE INDEX idx_reservations_service_date ON reservations(restaurant_id, service_date_local, starts_at_utc);
CREATE INDEX idx_reservations_status ON reservations(restaurant_id, status, starts_at_utc);

CREATE TABLE reservation_tables (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  assigned_by_staff_id TEXT REFERENCES staff_users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (reservation_id, table_id)
);
CREATE INDEX idx_reservation_tables_table ON reservation_tables(table_id, reservation_id);

-- A table is locked in 15-minute UTC slots. Unique(table_id, slot_start_utc)
-- prevents two concurrent bookings from claiming the same table/slot.
CREATE TABLE reservation_table_slots (
  table_id TEXT NOT NULL REFERENCES dining_tables(id),
  slot_start_utc TEXT NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  PRIMARY KEY (table_id, slot_start_utc)
);
CREATE INDEX idx_reservation_slots_reservation ON reservation_table_slots(reservation_id);

CREATE TABLE reservation_events (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  actor_staff_id TEXT REFERENCES staff_users(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reservation_events ON reservation_events(reservation_id, created_at);

CREATE TABLE waitlist_entries (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  customer_id TEXT REFERENCES customers(id),
  guest_name TEXT NOT NULL,
  guest_phone_e164 TEXT,
  party_size INTEGER NOT NULL,
  requested_date_local TEXT NOT NULL,
  preferred_time_local TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Loyverse catalogue mirror and web-only presentation ------------------------
CREATE TABLE menu_categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  loyverse_category_id TEXT UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_synced_at TEXT
);

CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  loyverse_item_id TEXT NOT NULL UNIQUE,
  category_id TEXT REFERENCES menu_categories(id),
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  available_for_sale INTEGER NOT NULL DEFAULT 1 CHECK (available_for_sale IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  source_updated_at TEXT,
  last_synced_at TEXT,
  raw_source_json TEXT
);
CREATE INDEX idx_catalog_category ON catalog_items(category_id, active);

CREATE TABLE catalog_variants (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  loyverse_variant_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sku TEXT,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  store_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_synced_at TEXT
);
CREATE INDEX idx_variants_item ON catalog_variants(item_id, active);

CREATE TABLE menu_item_presentation (
  item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  public_description TEXT,
  image_key TEXT,
  visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0,1)),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  dietary_tags_json TEXT NOT NULL DEFAULT '[]',
  allergens_json TEXT NOT NULL DEFAULT '[]',
  spice_level INTEGER CHECK (spice_level BETWEEN 0 AND 3),
  updated_by_staff_id TEXT REFERENCES staff_users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Delivery orders (Glovo now; other channels can be added later) -------------
CREATE TABLE delivery_orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  provider TEXT NOT NULL CHECK (provider IN ('glovo','other')),
  external_order_id TEXT NOT NULL,
  order_status TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discounts_minor INTEGER NOT NULL DEFAULT 0,
  delivery_fee_minor INTEGER NOT NULL DEFAULT 0,
  commission_minor INTEGER,
  other_fees_minor INTEGER,
  payout_minor INTEGER,
  total_minor INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  ready_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  external_created_at TEXT,
  last_synced_at TEXT,
  raw_payload_json TEXT,
  UNIQUE (provider, external_order_id)
);
CREATE INDEX idx_delivery_orders_date ON delivery_orders(restaurant_id, external_created_at, provider);

CREATE TABLE delivery_order_items (
  id TEXT PRIMARY KEY,
  delivery_order_id TEXT NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  external_item_id TEXT,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_minor INTEGER NOT NULL DEFAULT 0,
  total_price_minor INTEGER NOT NULL DEFAULT 0,
  modifiers_json TEXT
);

-- Messaging: one record per attempt/message; callbacks update status ----------
CREATE TABLE communication_messages (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  customer_id TEXT REFERENCES customers(id),
  reservation_id TEXT REFERENCES reservations(id),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  channel TEXT NOT NULL CHECK (channel IN ('sms','whatsapp')),
  provider TEXT NOT NULL DEFAULT 'twilio',
  template_key TEXT,
  provider_message_id TEXT UNIQUE,
  to_phone_e164 TEXT NOT NULL,
  from_address TEXT,
  body_preview TEXT,
  message_status TEXT NOT NULL CHECK (message_status IN ('queued','accepted','sent','delivered','read','received','failed','undelivered','unknown')),
  error_code TEXT,
  error_message TEXT,
  segments INTEGER,
  price_minor INTEGER,
  currency TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_reservation ON communication_messages(reservation_id, created_at);
CREATE INDEX idx_messages_status ON communication_messages(message_status, created_at);

-- Webhook idempotency, integration status, and transactional outbox ----------
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  provider TEXT NOT NULL CHECK (provider IN ('loyverse','glovo','twilio','google')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured','pending','connected','error','disabled')),
  last_success_at TEXT,
  last_error_at TEXT,
  last_error_code TEXT,
  metadata_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (restaurant_id, provider)
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processing','processed','failed','ignored')),
  payload_json TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  error_message TEXT,
  UNIQUE (provider, external_event_id)
);
CREATE INDEX idx_webhook_events_status ON webhook_events(processing_status, received_at);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, available_at);

-- Seed the single restaurant record. Replace details in a controlled setup step.
INSERT INTO restaurants (id, name, timezone, currency)
VALUES ('camila-gastrobar', 'Camila Gastrobar', 'Europe/Madrid', 'EUR');
