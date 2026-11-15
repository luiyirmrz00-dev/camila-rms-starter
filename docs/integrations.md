# Camila RMS — contratos de integración

## Loyverse

Fuente de catálogo: items, categories, variants y store-specific pricing.

- Secretos previstos: `LOYVERSE_ACCESS_TOKEN`, `LOYVERSE_STORE_ID`.
- Webhook: recibir eventos como disparador, guardar una clave de idempotencia y volver a consultar la API. No tratar el cuerpo del webhook como autoridad de precios.
- Sincronización: primera carga completa, lecturas delta con `updated_at_min` y reconciliación programada cada cinco minutos. Los precios públicos se leen de D1 y se actualizan al terminar cada sincronización.
- No pedir permisos de escritura si la integración solo publica carta.

## Twilio SMS y WhatsApp

- Secretos: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, remitentes.
- Envío desde el Worker/cola; registrar `provider_message_id`.
- Endpoint de callback para estados: accepted/sent/delivered/read/failed/undelivered.
- Webhook entrante para respuestas SMS/WhatsApp. Validar `X-Twilio-Signature` con la URL pública y los parámetros originales.
- WhatsApp requiere remitente habilitado y plantillas aprobadas cuando corresponda. Guardar consentimiento y finalidad.
- Los mensajes son transaccionales; el marketing requiere consentimiento diferenciado.
- Enviar confirmaciones/cancelaciones mediante enlaces de un solo uso. No revelar detalles de una reserva usando sólo el número de teléfono.

## Google Reserve with Google

- Para una primera versión, el Perfil de Empresa de Google puede dirigir al cliente a la página propia de reservas.
- Las reservas End-to-End dentro de Maps/Search requieren aceptación en Google Actions Center; exigen inventario completo y disponibilidad en tiempo real, además de políticas de cancelación en línea.
- Mantener un adaptador independiente para conectar Google al mismo motor interno si el restaurante es aceptado como partner.

## Webhook contract

Todos los webhooks deben:

1. Validar autenticidad antes de aceptar eventos.
2. Crear una fila `webhook_events` con idempotencia.
3. Responder rápidamente al proveedor.
4. Encolar el trabajo pesado.
5. Reintentar con backoff y dead-letter queue.
6. Guardar sólo los datos personales necesarios y limitar retención.
