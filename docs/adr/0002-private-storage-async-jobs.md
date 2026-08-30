# ADR 0002 — Storage privado y jobs asíncronos

- Estado: Accepted
- Fecha: 2026-08-27

## Contexto

Un usuario puede cargar cientos de PDFs sensibles. Pasarlos por RAM de la API o procesarlos durante el upload impide escalar, aumenta exposición y hace que cerrar el navegador interrumpa el trabajo.

## Decisión

El navegador sube directamente a object storage privado mediante autorización breve emitida por la API para una key opaca. La API confirma metadata confiable y en la misma transacción persiste estado más un ProcessingJob pendiente. Un dispatcher publica ese intent en Redis y reconcilia pendientes. PostgreSQL es fuente de verdad del batch/trabajo; Redis coordina ejecución y backpressure.

Originales, cuarentena y temporales tienen policies/lifecycles separados. La descarga siempre reautoriza y firma por tiempo breve.

## Alternativas

- Proxy del binario por API: sólo se reconsidera si un entorno no soporta upload firmado y mantiene streaming/límites equivalentes.
- OCR síncrono: rechazado.
- Guardar PDFs en PostgreSQL: rechazado.
- Bucket público con URLs difíciles de adivinar: rechazado.

## Consecuencias

- Menor uso de memoria/egress en API.
- Upload y procesamiento tienen estados separados.
- Se necesita reconciliar DB, cola y objetos huérfanos.
- Idempotencia y cleanup son parte del flujo, no tareas posteriores.

## Evidencia

La integración de upload prueba key y tamaño firmados, ownership cross-user, confirmación concurrente idempotente y creación durable antes de Redis. El worker reconcilia publicación, leases agotados, uploads vencidos y borrados de cuenta; la prueba local completa procesa un PDF sintético sin transportar el binario por la API o Redis.
