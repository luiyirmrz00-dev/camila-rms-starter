# Camila RMS — modelo de datos v1

## Principios

1. Loyverse es la fuente de verdad de nombre comercial, categoría, variantes y precio de venta del TPV.
2. La web mantiene una capa de presentación propia (`menu_item_presentation`): foto, descripción pública, orden, destacado, alérgenos y etiquetas.
3. Las reservas, clientes, mesas y comunicaciones pertenecen a Camila RMS.
4. Los importes se guardan en unidades menores (céntimos) como enteros; los instantes se guardan en UTC y las reglas/fechas de servicio usan `Europe/Madrid`.
5. No guardar contraseñas de proveedores en D1. Utilizar Cloudflare Worker Secrets.

## Entidades principales

- `restaurants`: tenant/establecimiento y zona horaria.
- `staff_users`: identidad autorizada por Cloudflare Access y rol interno.
- `dining_areas`, `dining_tables`, `table_combinations`: plano editable y combinaciones de mesas.
- `opening_hours`, `restaurant_closures`, `reservation_rules`: turnos semanales, cierres excepcionales y políticas ajustables.
- `customers`: ficha de cliente, teléfono normalizado E.164 y consentimientos separados para SMS, WhatsApp y marketing.
- `reservations`: reserva y ciclo de vida, canal de origen e identificador externo.
- `reservation_tables`: una reserva puede ocupar una o varias mesas.
- `reservation_table_slots`: bloqueos por intervalos de 15 minutos; la clave primaria `(table_id, slot_start_utc)` impide asignaciones solapadas a nivel de base de datos.
- `reservation_events`: historial inmutable de cambios de estado.
- `reservation_action_tokens`: hashes de enlaces de un solo uso para confirmar o cancelar reservas.
- `reservation_otp_challenges`: códigos temporales para verificar el teléfono antes de revelar datos de una reserva.
- `menu_categories`, `catalog_items`, `catalog_variants`: espejo del catálogo de Loyverse, incluyendo variantes y precio específico de tienda.
- `menu_item_presentation`: personalización de la carta pública sin alterar Loyverse.
- `communication_messages`: SMS/WhatsApp entrantes y salientes, callbacks y estados.
- `webhook_events`: idempotencia para no procesar el mismo evento dos veces.
- `outbox_events`: patrón outbox para publicar tareas asíncronas después de persistir cambios.
- `audit_logs`: trazabilidad de acciones del personal.

## Configuración inicial de Camila

- Miércoles, jueves y domingo: 12:00–16:00 y 20:00–23:00.
- Viernes y sábado: 12:00–16:00 y 20:00–00:00 (medianoche del día siguiente).
- Lunes y martes: cerrado.
- El aforo se calcula con mesas activas y combinaciones configuradas en el plano; no se inventan capacidades para las 14 mesas.

## Regla de reservas

El motor de reservas debe:

1. Convertir la hora local elegida en `Europe/Madrid` a UTC.
2. Calcular la duración aplicable y los slots de 15 minutos.
3. Seleccionar una mesa o combinación compatible con el número de comensales y el aforo disponible.
4. Insertar reserva, asignaciones y slots dentro de una transacción/batch D1.
5. Si una inserción colisiona con la clave única de una mesa/slot, descartar la asignación y probar otra combinación.
6. Mantener pendiente la reserva que requiera confirmación, retener su capacidad durante el plazo configurado y liberarla al caducar.
7. Registrar el evento y emitir notificación mediante outbox/queue después de persistir la reserva.

La reserva debe fallar de forma cerrada si no se puede garantizar que la mesa y el horario están libres. Para mostrar una mesa asignada al cliente, verificar primero que controla el teléfono de la reserva; el número por sí solo no autentica.

## Seguridad y RGPD

- Cloudflare Access para el panel privado y verificación del JWT `Cf-Access-Jwt-Assertion` en el Worker.
- RBAC por rol en cada endpoint; ocultar un botón no constituye autorización.
- Secretos exclusivamente en Worker Secrets.
- Validar las firmas de Twilio y las credenciales/firma disponibles de cada webhook; para proveedores sin firma se debe volver a consultar la API con credenciales del servidor.
- Consentimiento y finalidad separados para mensajes transaccionales y marketing.
- Definir plazos de conservación y mecanismos de acceso, rectificación y supresión de datos personales.
