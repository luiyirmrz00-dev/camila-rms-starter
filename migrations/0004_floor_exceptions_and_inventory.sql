-- Restaurant floor-plan fixtures, date-specific opening hours, and Loyverse stock.
CREATE TABLE dining_floor_elements (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  area_id TEXT NOT NULL REFERENCES dining_areas(id),
  kind TEXT NOT NULL CHECK (kind IN ('wall','bar','entrance','window','column')),
  label TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL CHECK (x BETWEEN 0 AND 100),
  y REAL NOT NULL CHECK (y BETWEEN 0 AND 100),
  width REAL NOT NULL CHECK (width > 0 AND width <= 100),
  height REAL NOT NULL CHECK (height > 0 AND height <= 100)
);
CREATE INDEX idx_floor_elements_area ON dining_floor_elements(restaurant_id, area_id);

CREATE TABLE restaurant_special_openings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  opening_date_local TEXT NOT NULL,
  service_name TEXT NOT NULL,
  opens_at_local TEXT NOT NULL,
  closes_at_local TEXT NOT NULL,
  CHECK (closes_at_local > opens_at_local OR closes_at_local = '00:00')
);
CREATE INDEX idx_special_openings_date ON restaurant_special_openings(restaurant_id, opening_date_local);

ALTER TABLE catalog_items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1));
ALTER TABLE catalog_variants ADD COLUMN in_stock REAL;
