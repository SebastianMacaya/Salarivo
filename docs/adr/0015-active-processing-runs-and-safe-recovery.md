# ADR 0015 — Resultado activo y recuperación versionada segura

- Estado: Accepted
- Fecha: 2026-08-31
- Supersede parcialmente: [ADR 0004](0004-versioned-extraction.md), en la selección de la corrida vigente; [ADR 0012](0012-granular-admin-console.md), en reproceso y rollback administrativo; [ADR 0013](0013-derived-salary-history-analytics.md), en la selección de datos para Analytics

## Contexto

Salarivo ya conserva varias `ExtractionRun` por documento, pero la corrida `COMPLETED` con mayor `processing_version` funciona como resultado activo implícito. Pedir un reproceso también cambia el estado global del documento. Durante la ejecución desaparece de Analytics el resultado anterior y, si el candidato termina peor o requiere revisión, pasa a ser visible sin una decisión de promoción.

Los issues recuperables existen sólo como señales JSON de campos; no se pueden consultar por código, severidad o versión. El texto extraído y el OCR se eliminan al terminar cada job, por lo que un cambio exclusivo de parser vuelve a descargar, validar y, a veces, ejecutar OCR sobre el PDF.

## Decisión

### Corridas y resultado activo

`ExtractionRun` continúa siendo la única entidad de procesamiento. Cada corrida registra origen, actor cuando existe, corrida base, versiones reales del pipeline, schema de resultado, estado terminal, issues y evaluación contra la corrida activa que observó al comenzar.

`Document.active_extraction_run_id` es la única autoridad para seleccionar la proyección estructurada en detalle, correcciones, historial salarial, Analytics y detecciones; nunca se infiere el activo por fecha o número de versión. Analytics y conceptos exigen además que el documento esté `COMPLETED`, por lo que un baseline activo sólo para revisión todavía no aporta importes. La exportación de privacidad conserva todas las revisiones y marca cuál está activa. El backfill asigna la última corrida `COMPLETED` histórica sin reescribir campos, liquidaciones ni correcciones.

Una nueva corrida se materializa como candidata. El worker bloquea el documento, vuelve a comprobar que el activo sea la corrida base y clasifica la diferencia de forma determinística:

- `IMPROVED`: sólo agrega información antes ausente, conserva los valores efectivos previos y mantiene las invariantes;
- `UNCHANGED`: la proyección efectiva es equivalente;
- `REVIEW_REQUIRED`: cambia identidad, período, moneda, tipo, un importe existente o conceptos;
- `REGRESSED`: elimina información o rompe completitud o invariantes.

No se usa un score numérico arbitrario. La promoción automática sólo ocurre para un baseline inicial válido o un resultado `IMPROVED`. `UNCHANGED`, `REVIEW_REQUIRED`, `REGRESSED` y `FAILED` conservan el activo anterior. La actualización del puntero usa compare-and-set dentro de la misma transacción que registra resultado y auditoría. Las correcciones humanas se heredan con su raíz, forman parte del valor efectivo comparado y nunca se sustituyen por una extracción automática.

Un rollback administrativo sólo puede apuntar a una corrida terminal del mismo titular y documento que haya sido activa previamente. Exige capacidad dedicada, step-up, motivo tipado, referencia y auditoría atómica. La consola continúa sin exponer PDF, filename, OCR, campos, conceptos ni salarios; muestra únicamente metadata de pipeline, estados e issues sanitizados. El titular puede inspeccionar y decidir sobre diferencias de contenido propias.

### Estados, issues y candidatos

Una corrida distingue ejecución, éxito completo, éxito con observaciones, revisión requerida, fallo y cancelación. Los issues son filas owner-scoped con código cerrado por el productor, severidad, recuperabilidad, campo afectado y metadata allowlisted sin valores salariales.

Las reglas de completitud viven en dominio compartido y dependen del tipo de liquidación. Un recibo `NORMAL` sin básico queda completo con observaciones; otros tipos no requieren básico sólo para satisfacer una forma común.

La disponibilidad de reproceso se decide en un único servicio. Requiere original disponible y limpio, issue o estado recuperable y una release actual que declare una corrección compatible. Una versión más nueva por sí sola no convierte un documento en candidato. El catálogo de releases es código versionado porque hoy existe una sola implementación; una tabla o plataforma de flags se agrega únicamente cuando haya configuración dinámica real.

### Jobs, batches y concurrencia

`ProcessingJob` sigue siendo outbox, unidad de retry y mensaje de cola. Registra trigger, actor, corrida base, pipeline objetivo y batch opcional. Todo trabajo nuevo entra por `DOCUMENT_PIPELINE_V2`; el dispatcher y el claim exigen el fingerprint exacto. La migración toma un lock exclusivo, falla si existe un lease en ejecución, convierte trabajo pendiente y reescribe inserts de la API anterior. Así un worker anterior no reconoce la etapa nueva y un worker con otro fingerprint no puede reclamarla durante un rollout gradual. Una restricción parcial impide más de un job activo por documento, incluso si dos requests usan claves distintas. Leases, backoff, fairness y límites por usuario se conservan.

Un batch de reproceso sólo agrupa jobs existentes de un titular; no crea otra cola ni carga documentos en memoria. Su resumen se deriva de los jobs y corridas, por lo que un fallo individual no cancela los demás. Los batches administrativos se dividen por titular para mantener ownership y fairness.

El estado global del documento representa el resultado activo. Una corrida candidata expone su progreso mediante job/run y no modifica el documento ni el item de importación. Un rechazo de seguridad sigue siendo fail-closed y puede invalidar el acceso al documento aunque exista historia previa.

### Reutilización privada de texto

Cada extracción completa puede guardar un artefacto opaco con texto y evidencia espacial comprimidos en el mismo storage privado y cifrado usado por documentos. PostgreSQL conserva sólo key opaca, checksum, tamaño, fuente y versiones. El contenido no se devuelve por API, no se firma, no se exporta como diagnóstico y nunca entra en logs, métricas, traces ni IA externa.

Un reproceso conserva la etapa de cola `DOCUMENT_PIPELINE_V2` y salta internamente a parsing sólo cuando el artefacto pertenece al mismo titular/documento, está completo, su checksum coincide y las etapas de texto/OCR siguen siendo compatibles. Un cambio de seguridad, extracción u OCR vuelve al PDF. Un artefacto alterado falla cerrado. Si no hay artefacto histórico, el worker ejecuta el pipeline completo una vez.

El artefacto tiene el ciclo de vida del original, no el de la historia estructurada. Su metadata `writeState=PENDING` se registra antes del `PUT`; un timeout conserva la incertidumbre. Borrar el original, el documento o la cuenta copia las keys inciertas al tombstone antes de cualquier cascade. El reconciliador repite `DELETE`, confirma ausencia mediante `HEAD` y nunca retira un tombstone con un write incierto, aunque eso requiera intervención operativa. `DELETE_AFTER_PROCESSING` no conserva texto reutilizable después de eliminar el original.

## Alternativas consideradas

- **Mantener “última corrida completada”:** rechazado porque una corrida pendiente, dudosa o peor no es una decisión de publicación.
- **Sobrescribir la liquidación activa y restaurarla al fallar:** rechazado porque crea ventanas inconsistentes y pierde carreras contra correcciones o reprocesos paralelos.
- **Reprocesar toda versión vieja:** rechazado por costo y porque una release puede no afectar al documento.
- **Persistir OCR en PostgreSQL:** rechazado para no ampliar datos Restricted en la base ni mezclar contenido con metadata consultable.
- **No persistir texto y repetir OCR siempre:** rechazado porque mantiene un costo evitable para cambios sólo de parser.
- **Crear otra cola o event sourcing:** rechazado; jobs, corridas y auditoría existentes cubren durabilidad y trazabilidad.

## Consecuencias

- El historial estructurado permanece inmutable y una corrida fallida también queda explicable.
- Analytics cambia inmediatamente al promover o hacer rollback porque no hay cache persistida.
- Un documento sigue utilizable durante reproceso, retry o revisión del candidato.
- La detección de candidatos y los reportes por issue/version requieren índices nuevos y paginación.
- El texto reutilizable aumenta storage Restricted; minimización, borrado durable y pruebas de aislamiento pasan a ser condiciones de aceptación.
- Un despliegue requiere drenar leases antes de la migración; luego la etapa y el fingerprint hacen fail-closed cualquier convivencia temporal de binarios. API, worker y web igualmente deben converger en el mismo commit antes de declarar el despliegue completo.

## Condiciones para aceptar

- Migración y backfill preservan la proyección existente y sus constraints de ownership.
- Tests cubren mejora, fallo, regresión, doble solicitud, batch parcial, aislamiento, Analytics activo y rollback.
- Exportación y eliminación usan el nuevo puntero/ciclo de vida sin filtrar contenido técnico.
- Los consumidores dejan de consultar “última corrida completada”.
- El render mobile cubre sin candidatos, uno/múltiples, pending, success, unchanged, failed y review.
- Logs y panel admin no contienen OCR, valores salariales, filenames, object keys ni URLs.

## Evidencia

Implementado en la migración 020, dominio compartido, API, worker y web del mismo cambio. Verificación local del 2026-08-31:

- migración 020 aplicada desde una base vacía;
- integración completa de upload/reproceso/promoción/revisión/rollback/batches/cuarentena/borrado: 1/1;
- tests unitarios: API 41/41, web 25/25, worker 26/26 y database 15/15;
- typecheck de todos los workspaces, lint web, build web/worker, `docker compose config --quiet` y `git diff --check`;
- revisión final de seguridad sin hallazgos P1 de pérdida o exposición.

Esta evidencia no afirma que el cambio esté desplegado en producción.
