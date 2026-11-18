-- Keep Loyverse stock tracking flags for items imported before migration 0004.
UPDATE catalog_items
SET track_stock = CASE
  WHEN json_valid(raw_source_json)
    AND COALESCE(json_extract(raw_source_json, '$.track_stock'), 0) = 1
  THEN 1
  ELSE 0
END;

-- Public-facing groups are independent of Loyverse categories, which remain
-- intact as editable subcategories in the restaurant's menu.
ALTER TABLE menu_categories
ADD COLUMN public_section TEXT NOT NULL DEFAULT 'food'
CHECK (public_section IN ('drinks', 'starters', 'food', 'desserts'));

UPDATE menu_categories
SET public_section = CASE
  WHEN lower(name) IN ('postres', 'postre', 'dulces', 'dulce', 'postres y dulces') THEN 'desserts'
  WHEN lower(name) IN ('pinchos', 'pincho', 'entrantes', 'entrante', 'extras', 'extra', 'aperitivos', 'aperitivo') THEN 'starters'
  WHEN lower(name) IN (
    'bebidas', 'bebida', 'brandys', 'cafés', 'cafes', 'cervezas', 'cerveza',
    'cocktails', 'cocktail', 'cócteles', 'cocteles', 'ginebra', 'ginebras',
    'mezcales', 'mezcal', 'otros licores', 'licores', 'refrescos y h2o',
    'refrescos', 'ron', 'rones', 'sidras', 'sidra', 'tequilas', 'tequila',
    'vermouth', 'vino x botella', 'vinos chateo', 'vodkas', 'vodka', 'whiskeys',
    'whiskey', 'whiskies', 'brandy', 'destilados'
  ) THEN 'drinks'
  ELSE 'food'
END;
