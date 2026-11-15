PRAGMA foreign_keys = ON;

-- Special closures can cover a whole local date or only part of a service.
CREATE TABLE restaurant_closures (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  closure_date_local TEXT NOT NULL,
  starts_at_local TEXT,
  ends_at_local TEXT,
  reason TEXT,
  created_by_staff_id TEXT REFERENCES staff_users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (starts_at_local IS NULL AND ends_at_local IS NULL) OR
    (starts_at_local IS NOT NULL AND ends_at_local IS NOT NULL AND ends_at_local > starts_at_local)
  )
);
CREATE INDEX idx_restaurant_closures_date
  ON restaurant_closures(restaurant_id, closure_date_local);

-- Guest action links store only a hash of the random token sent to the guest.
CREATE TABLE reservation_action_tokens (
  token_hash TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'cancel')),
  expires_at_utc TEXT NOT NULL,
  used_at_utc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reservation_action_tokens_lookup
  ON reservation_action_tokens(reservation_id, action, expires_at_utc);

-- Phone lookup requires a short-lived verification code; phone number alone is not proof of identity.
CREATE TABLE reservation_otp_challenges (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('reservation_lookup')),
  code_hash TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at_utc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reservation_otp_phone
  ON reservation_otp_challenges(restaurant_id, phone_e164, created_at);

ALTER TABLE reservations ADD COLUMN confirmed_at TEXT;
ALTER TABLE reservations ADD COLUMN hold_expires_at TEXT;
ALTER TABLE reservation_rules ADD COLUMN pending_hold_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE reservation_rules ADD COLUMN cancellation_cutoff_minutes INTEGER NOT NULL DEFAULT 120;

INSERT INTO reservation_rules (restaurant_id)
VALUES ('camila-gastrobar')
ON CONFLICT(restaurant_id) DO NOTHING;

-- SQLite weekday numbering: Sunday=0, Monday=1 ... Saturday=6.
-- 00:00 after the Friday/Saturday dinner service means midnight of the following date.
INSERT INTO opening_hours (id, restaurant_id, weekday, service_name, opens_at_local, closes_at_local, active)
VALUES
  ('camila-hours-sun-lunch', 'camila-gastrobar', 0, 'Comida', '12:00', '16:00', 1),
  ('camila-hours-sun-dinner', 'camila-gastrobar', 0, 'Cena', '20:00', '23:00', 1),
  ('camila-hours-wed-lunch', 'camila-gastrobar', 3, 'Comida', '12:00', '16:00', 1),
  ('camila-hours-wed-dinner', 'camila-gastrobar', 3, 'Cena', '20:00', '23:00', 1),
  ('camila-hours-thu-lunch', 'camila-gastrobar', 4, 'Comida', '12:00', '16:00', 1),
  ('camila-hours-thu-dinner', 'camila-gastrobar', 4, 'Cena', '20:00', '23:00', 1),
  ('camila-hours-fri-lunch', 'camila-gastrobar', 5, 'Comida', '12:00', '16:00', 1),
  ('camila-hours-fri-dinner', 'camila-gastrobar', 5, 'Cena', '20:00', '00:00', 1),
  ('camila-hours-sat-lunch', 'camila-gastrobar', 6, 'Comida', '12:00', '16:00', 1),
  ('camila-hours-sat-dinner', 'camila-gastrobar', 6, 'Cena', '20:00', '00:00', 1);
