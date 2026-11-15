# Reservas y operación de sala

## Objetivo

Construir un sistema propio con los flujos útiles de un gestor de reservas: motor de disponibilidad, plano de sala, asignación de mesas, lista de espera, comunicaciones y seguimiento operativo. La interfaz y el código serán propios y adaptados a Camila.

## Configuración confirmada

- Miércoles, jueves y domingo: comida 12:00–16:00; cena 20:00–23:00.
- Viernes y sábado: comida 12:00–16:00; cena 20:00–00:00 del día siguiente.
- Lunes y martes: cerrado.
- El local tiene 14 mesas de distintas capacidades y una barra junto a la ventana.
- Una reserva puede ocupar una mesa o una combinación configurada en el plano.
- La disponibilidad debe descontar todas las reservas activas que coincidan en horario y calcular capacidad antes de aceptar otra.
- La confirmación/cancelación se ofrece mediante enlaces de un solo uso enviados al cliente.

## Fases

### 1. Reserva web y disponibilidad

- Selector de fecha, comensales y horarios disponibles.
- Cálculo por zona horaria `Europe/Madrid`, turnos, cierres excepcionales, duración y mesas libres.
- Bloqueo transaccional de mesas para evitar dobles reservas con solicitudes concurrentes.
- Las reservas que requieren confirmación quedan pendientes y retienen la capacidad durante un plazo configurable.
- Enlaces aleatorios de un solo uso para confirmar o cancelar.
- Consulta de reserva por teléfono con código de verificación enviado al mismo número; el teléfono por sí solo no permite ver la mesa asignada.

### 2. Panel protegido de sala

- Acceso mediante Cloudflare Access y roles internos.
- Plano editable con zonas, las 14 mesas, capacidades, formas, posiciones y uniones permitidas.
- Vista operativa por turno con reservas, lista de espera, llegadas, mesas asignadas y estados.
- Alta telefónica y presencial, reasignación, check-in, sentar, completar, cancelar y marcar no-show.
- Editor de horarios semanales, turnos, cierres completos o parciales, duración y límites de reserva.
- Registro de cambios para saber quién modificó reservas, mesas y horarios.

### 3. Mensajería y CRM

- Confirmaciones, cancelaciones, recordatorios y ofertas de lista de espera mediante Twilio.
- WhatsApp como canal preferido cuando el cliente haya dado consentimiento y la cuenta disponga de remitente y plantillas aprobadas; SMS como alternativa configurada.
- Historial de visitas, notas operativas, etiquetas y preferencias de contacto.
- Comunicación transaccional separada del consentimiento comercial.

### 4. Actualizaciones en vivo y análisis

- Actualización del panel sin recargar toda la página cuando se crea, cambia o cancela una reserva.
- Usar WebSockets hibernables con Cloudflare Durable Objects para invalidaciones en vivo; D1 conserva la fuente de verdad y los clientes vuelven a consultar sólo los datos que cambian.
- Métricas de ocupación por turno, cubiertos, cancelaciones, no-shows, lista de espera y origen de reservas.
- Exportación operativa con campos mínimos y controles de acceso.

## Entrada desde Google

El primer paso es añadir al Perfil de Empresa el enlace propio de reservas. Así Google puede enviar al cliente al flujo web de Camila. La reserva completa dentro de Maps/Search es otra integración: Google Actions Center requiere aprobación de partner y disponibilidad en tiempo real, entre otros requisitos. Se implementará contra el mismo motor sólo después de la aceptación.

## Datos pendientes para activar el plano

Las 14 capacidades, nombres/zonas de cada mesa, capacidad de la barra, tiempo de retención de reservas pendientes, duración de cada servicio y tamaño máximo de grupo se deben configurar en el panel. No se incluyen capacidades inventadas en la migración.
