# Worker de documentos

Proceso local asíncrono para los jobs `SECURITY_VALIDATION` y la reanudación `TEXT_EXTRACTION` autorizada por el usuario. Publica el outbox durable de PostgreSQL en Redis y consume exclusivamente mensajes `{"jobId":"<uuid>"}`. El PDF nunca viaja por Redis ni se escribe en logs.

## Pipeline implementado

1. reclama el job con lease e idempotencia en PostgreSQL;
2. descarga la key privada indicada por `documents.object_key`, con timeout y límite estricto de bytes;
3. calcula SHA-256 por streaming y valida `%PDF-` en los primeros 1024 bytes;
4. valida estructura, cifrado, páginas y dimensiones con `pdfinfo`;
5. escanea por ClamAV `INSTREAM` y falla cerrado;
6. rechaza JavaScript y adjuntos con `pdfinfo -js` y `pdfdetach`;
7. clasifica una muestra antes de extracción completa;
8. usa `pdftotext` o, sólo si hace falta, `pdftoppm` + Tesseract `spa`;
9. extrae período, empleador, montos y conceptos argentinos mediante reglas determinísticas;
10. persiste una corrida inmutable, campos trazables, 0..1 liquidación y sus conceptos.

Los procesos externos se lanzan sin shell y sin heredar credenciales, con stdout acotado, timeout y stderr descartado. Los temporales viven en un directorio aleatorio por job y se eliminan en `finally`.

## Contratos de infraestructura

- PostgreSQL: usa `pool` y `withTransaction` de `@salarivo/database`. Consume las tablas `documents`, `processing_jobs` e `import_batch_items`; escribe `extraction_runs`, `extracted_fields`, `payroll_settlements` y `payroll_line_items` según `packages/database/migrations/001_initial.sql`.
- Redis: lista `salarivo:processing-jobs:documents`; el dispatcher publica sólo después del ack. Re-publicar es seguro porque el claim compara estado y lease.
- Object storage: API S3 privada con path-style; la API debe haber confirmado previamente `object_key` y `size_bytes`.
- Host: requiere `pdfinfo`, `pdfdetach`, `pdftotext`, `pdftoppm`, `tesseract` y el idioma `spa`. ClamAV corre como servicio TCP privado.

El dispatcher ordena en rondas por `user_id`, y el claim serializa la cuota por usuario con advisory lock para que una importación grande no monopolice workers.

Una confirmación humana de tipo debe crear un job `TEXT_EXTRACTION` con un `processing_version` nuevo. El worker vuelve a ejecutar todos los gates de seguridad; la confirmación sólo reemplaza la decisión de clasificación y queda registrada como señal sanitizada.

## Configuración

En producción las variables comunes son obligatorias. Las credenciales adicionales dependen del proveedor seleccionado y los defaults existen sólo con `APP_ENV` distinto de `production`.

| Variable | Propósito |
| --- | --- |
| `DATABASE_URL` | conexión PostgreSQL, validada por `@salarivo/database` |
| `QUEUE_URL` | conexión Redis |
| `OBJECT_STORAGE_PROVIDER` | `aws` o `r2`; obligatorio en producción |
| `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET` | storage privado |
| `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY` | credenciales del worker |
| `PUBLIC_ORIGIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_R2_API_TOKEN` | validación fail-closed de la configuración privada de R2 en producción |
| `OBJECT_STORAGE_KMS_KEY_ID` | clave KMS obligatoria sólo con AWS en producción; R2 usa cifrado administrado por Cloudflare |
| `CLAMAV_HOST`, `CLAMAV_PORT` | scanner privado |
| `MAX_FILE_BYTES`, `MAX_PAGES`, `MAX_RENDER_PIXELS` | límites del documento |
| `MAX_PARSE_TIME_MS`, `MAX_OCR_TIME_MS`, `MAX_OCR_PAGES`, `MAX_EXTRACTED_TEXT_BYTES` | límites de procesos y output |
| `CLASSIFICATION_LOW_THRESHOLD`, `CLASSIFICATION_HIGH_THRESHOLD` | gates de clasificación |
| `WORKER_CONCURRENCY`, `WORKER_CONCURRENCY_PER_USER` | concurrencia global y por dueño |
| `JOB_TIMEOUT_MS` | lease; debe cubrir los timeouts del pipeline |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `PUBLISHED_RETRY_MS` | dispatcher y reconciliación |
| `UPLOAD_TTL_SECONDS` | vigencia compartida con la autorización emitida por la API |
| `UPLOAD_CLEANUP_GRACE_MS` | ventana de reborrado tras vencer un upload iniciado |

No se implementa IA/LLM: el MVP se detiene en reglas determinísticas y revisión humana.

El perfil `processing` ejecuta el worker como usuario no-root, con filesystem de sólo lectura, `/tmp` acotado y límites de CPU/RAM. El filtrado de egress y los límites administrados del proveedor se definen al preparar el despliegue.
