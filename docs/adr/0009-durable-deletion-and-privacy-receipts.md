# ADR 0009 — Borrado durable y constancias de privacidad

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

Marcar una fila como borrada no elimina una copia temporal, una autorización de upload todavía válida ni los datos derivados. Borrar la cuenta también elimina la FK que normalmente permitiría informar el resultado al titular.

## Decisión

- Original y datos estructurados conservan ciclos de vida separados.
- Borrar un original o documento registra primero un tombstone durable con sus keys canónica y temporal. La API bloquea el acceso de inmediato y el worker reintenta el borrado físico después de vencer la autorización de upload.
- El tombstone no tiene FK al documento o usuario y se elimina sólo después de que storage acepte ambos `DELETE`. Producción exige un bucket que nunca haya tenido versioning para que esa confirmación no sea sólo un delete marker.
- Borrar el documento elimina además item de importación, sesión de upload, jobs, extracciones, liquidaciones y correcciones por las cascadas verificadas del esquema.
- `DELETE_AFTER_PROCESSING` agenda el mismo cleanup para estados terminales; nunca para una revisión o retry pendiente.
- Un tipo no soportado fuerza esa política y conserva sólo ficha mínima más feedback owner-only opcional. Un upload binario exacto del mismo titular se descarta después de limpiar el temporal: el tombstone sobrevive al cascade hasta verificar storage, mientras el lote conserva sólo un conteo agregado y auditoría sanitaria sin identificadores del archivo.
- La baja de cuenta revoca sesiones y jobs que aún no se ejecutan, impide nuevos accesos y espera uploads, exports y ejecuciones vigentes. Un `execution_owner` se mantiene hasta limpiar el temporal del worker; recién después se borra storage y se elimina al usuario con sus relaciones.
- Al pedir la baja, las keys se materializan en tombstones mediante operaciones set-based. El worker los drena en lotes acotados y round-robin por usuario antes de completar la cuenta; no carga el inventario completo en memoria ni deja que una baja monopolice el ciclo.
- El navegador genera antes del pedido una constancia opaca que puede conservar aun si se pierde la respuesta. Sólo su hash sobrevive en `account_deletion_receipts`, sin FK ni PII; la pantalla pública permite reingresarla para consultar `PENDING` o `COMPLETED` después del cascade, sin persistirla en storage del navegador.
- El export de acceso se transmite paginado bajo snapshot repetible, con timeout de stream de diez minutos y un máximo local de dos streams simultáneos. Su formato v3 presenta cuenta, historia laboral, importaciones, documentos, liquidaciones, conceptos, correcciones, aceptaciones, sesiones y solicitudes de privacidad con contexto comprensible; no expone UUID/FK internos, identificadores del proveedor, checksums, tablas de ejecución, contraseñas, tokens, secretos MFA, object keys ni PDFs.

## Consecuencias

Un fallo de storage deja trabajo reintentable, no un falso éxito. La cuenta permanece `DELETION_PENDING` hasta terminar. El recibo demuestra el estado operativo, pero no sustituye una constancia jurídica ni resuelve copias de backup.

Backups cifrados, su ventana máxima y una lista de supresiones reaplicada después de cada restore son bloqueos independientes antes de producción.

## Evidencia

- Migraciones `007_deletion_tombstones_and_receipts.sql`, `008_minimize_sensitive_deductions.sql`, `009_minimize_all_deduction_descriptions.sql` y `011_track_worker_execution_quiescence.sql`.
- Rutas de privacidad en `apps/api/src/data-routes.ts` y reconciliación en `apps/worker-documents/src/index.ts`.
- Integración de ownership, URL firmada, borrado de original/documento, contrato user-facing del export, concurrencia y solicitud de baja.
- La integración ejecuta el worker real contra PostgreSQL, Redis y MinIO sintéticos, reintenta un upload firmado después del pedido de borrado y prueba que cada cuenta sólo termina cuando venció esa autorización, desaparecieron ambas keys y no queda una ejecución activa.
