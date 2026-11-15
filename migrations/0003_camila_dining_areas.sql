INSERT INTO dining_areas (id, restaurant_id, name, sort_order, active)
VALUES
  ('camila-area-salon', 'camila-gastrobar', 'Salón', 0, 1),
  ('camila-area-barra-ventana', 'camila-gastrobar', 'Barra junto a la ventana', 1, 1)
ON CONFLICT(id) DO NOTHING;
