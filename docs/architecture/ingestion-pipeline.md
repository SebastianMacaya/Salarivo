# Pipeline de ingestión

> Estado: corte vertical implementado para PDF salarial argentino, con progreso recuperable, cancelación de uploads pendientes, revisión manual y reproceso explícito versionado. Pausa/reanudación, LLM y otros tipos siguen fuera del MVP.

## Objetivo

Aceptar desde un PDF hasta décadas de documentos sin procesarlos en el request HTTP, sin mantener batches completos en memoria y sin ejecutar trabajo caro antes de demostrar que el archivo es seguro y probablemente salarial.

## Flujo de upload

~~~mermaid
sequenceDiagram
    actor U as Usuario
    participant W as Web
    participant A as API
    participant S as Storage privado
    participant D as PostgreSQL
    participant X as Dispatcher
    participant Q as Cola
    participant K as Worker

    U->>W: selecciona archivos
    W->>W: preflight UX
    W->>A: crea sesión/batch
    A->>D: persiste batch + items
    A->>D: reserva sesión/capacidad
    A->>S: crea marcador condicional
    A->>D: persiste ETag + revalida capacidad
    A-->>W: key opaca + autorización If-Match breve
    loop concurrencia acotada
        W->>S: upload directo a cuarentena
        W->>A: confirma item
        A->>S: verifica objeto esperado
        A->>D: transacción UPLOADED + ProcessingJob pendiente
    end
    X->>D: reclama jobs pendientes
    X->>Q: publica job idempotente
    Q->>K: procesa un documento
    K->>D: persiste cada transición
~~~

El preflight del navegador mejora feedback, pero nunca reemplaza controles server-side. En R2, el primer PUT reemplaza atómicamente un marcador vacío ligado a la sesión; replays con su ETag anterior fallan. La API sólo completa un upload si key, owner, tamaño y metadata de storage coinciden con la sesión. La promoción crea otro marcador en la key canónica y condiciona tanto la fuente como el destino; una carrera se acepta como retry sólo si el objeto ganador coincide exactamente.

El dispatcher reserva como PUBLISHED sólo los slots disponibles y confirma esa transacción antes de publicar en Redis, para que un consumer nunca vea un job aún invisible en DB. Si Redis rechaza la publicación vuelve a PENDING los IDs no enviados; una caída intermedia puede duplicar el mensaje y la idempotencia del worker lo vuelve seguro. El reconciliador recupera reservas vencidas.

## Máquina de estados del documento

~~~mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> UPLOADED
    UPLOADED --> SECURITY_VALIDATION
    SECURITY_VALIDATION --> QUARANTINED
    SECURITY_VALIDATION --> FAILED_PERMANENT
    SECURITY_VALIDATION --> DOCUMENT_CLASSIFICATION
    DOCUMENT_CLASSIFICATION --> REJECTED_UNSUPPORTED
    DOCUMENT_CLASSIFICATION --> NEEDS_TYPE_CONFIRMATION
    DOCUMENT_CLASSIFICATION --> TEXT_EXTRACTION
    NEEDS_TYPE_CONFIRMATION --> TEXT_EXTRACTION: usuario confirma
    TEXT_EXTRACTION --> PARSING: texto útil
    TEXT_EXTRACTION --> OCR: texto insuficiente
    OCR --> PARSING
    PARSING --> NORMALIZATION
    NORMALIZATION --> VALIDATION
    VALIDATION --> COMPLETED
    VALIDATION --> NEEDS_REVIEW
    NEEDS_REVIEW --> COMPLETED: usuario verifica

    SECURITY_VALIDATION --> FAILED_RETRYABLE
    SECURITY_VALIDATION --> FAILED_PERMANENT
    DOCUMENT_CLASSIFICATION --> FAILED_RETRYABLE
    DOCUMENT_CLASSIFICATION --> FAILED_PERMANENT
    TEXT_EXTRACTION --> FAILED_RETRYABLE
    TEXT_EXTRACTION --> FAILED_PERMANENT
    OCR --> FAILED_RETRYABLE
    OCR --> FAILED_PERMANENT
    PARSING --> FAILED_RETRYABLE
    PARSING --> FAILED_PERMANENT
    NORMALIZATION --> FAILED_RETRYABLE
    NORMALIZATION --> FAILED_PERMANENT
    VALIDATION --> FAILED_RETRYABLE
    VALIDATION --> FAILED_PERMANENT
    FAILED_RETRYABLE --> RETRY_SCHEDULED
    FAILED_RETRYABLE --> FAILED_PERMANENT: retries o budget agotados
    RETRY_SCHEDULED --> SECURITY_VALIDATION: checkpoint de seguridad
    RETRY_SCHEDULED --> DOCUMENT_CLASSIFICATION: checkpoint de clasificación
    RETRY_SCHEDULED --> TEXT_EXTRACTION: checkpoint de extracción
    RETRY_SCHEDULED --> OCR: checkpoint de OCR
    RETRY_SCHEDULED --> PARSING: checkpoint de parsing
    RETRY_SCHEDULED --> NORMALIZATION: checkpoint de normalización
    RETRY_SCHEDULED --> VALIDATION: checkpoint de validación

    CREATED --> CANCELLED
    UPLOADED --> CANCELLED
    NEEDS_REVIEW --> CANCELLED
    COMPLETED --> DELETED
    REJECTED_UNSUPPORTED --> DELETED
    QUARANTINED --> DELETED
    NEEDS_TYPE_CONFIRMATION --> DELETED
    FAILED_RETRYABLE --> DELETED
    FAILED_PERMANENT --> DELETED
    NEEDS_REVIEW --> DELETED
    CANCELLED --> DELETED
~~~

Cada transición usa compare-and-set o transacción equivalente. El estado del documento describe exclusivamente el resultado activo y no retrocede al pedir un reproceso. El progreso de una nueva versión vive en `ProcessingJob` y `ExtractionRun`, de modo que el resultado anterior continúa disponible.

## Máquina de estados de una corrida

~~~mermaid
stateDiagram-v2
    [*] --> PROCESSING
    PROCESSING --> COMPLETED
    PROCESSING --> COMPLETED_WITH_WARNINGS
    PROCESSING --> REVIEW_REQUIRED
    PROCESSING --> FAILED
    PROCESSING --> CANCELLED
    COMPLETED --> ACTIVE: baseline o mejora inequívoca
    COMPLETED_WITH_WARNINGS --> ACTIVE: baseline utilizable o mejora sin regresiones
    REVIEW_REQUIRED --> ACTIVE: decisión explícita del titular
    ACTIVE --> HISTORICAL: promoción o rollback posterior
~~~

`ACTIVE` e `HISTORICAL` representan la relación con `Document.active_extraction_run_id`, no valores mutables de `ExtractionRun.status`. Promoción y rollback cambian sólo el puntero bajo lock y dejan auditoría.

## Etapas y gates

| Orden | Etapa | Resultado |
| --- | --- | --- |
| 1 | tamaño y sesión | abortar objetos inesperados |
| 2 | extensión declarada | señal, nunca prueba |
| 3 | MIME detectado y magic bytes | sólo PDF permitido |
| 4 | parse estructural limitado | corrupto, cifrado, objetos/páginas anormales |
| 5 | malware scan | clean o QUARANTINED |
| 6 | inspección activa | rechazar JavaScript, adjuntos y acciones no permitidas |
| 7 | clasificación barata | texto mínimo o primera página limitada |
| 8 | extracción directa | preferida si existe texto confiable; conserva página/región de coincidencias literales únicas |
| 9 | OCR | sólo para páginas necesarias y con budget; conserva TSV espacial cuando existe |
| 10 | parsing/normalización | determinístico y versionado |
| 11 | IA futura | fallback mínimo, redactado y presupuestado |
| 12 | validación | corrida completa, completa con observaciones o que requiere revisión |
| 13 | comparación/promoción | promover sólo baseline válido o mejora sin regresiones |

El parser no inventa montos. El neto sólo puede derivarse de los totales de una tabla salarial reconocida cuando además existe una etiqueta explícita de neto, siempre con aritmética decimal exacta. Un valor ausente queda como issue trazable. La completitud depende del tipo: un `NORMAL` sin básico queda con observaciones; si bruto, descuentos y neto no balancean, el candidato requiere revisión y no desplaza al activo.

Confirmar manualmente el tipo nunca salta malware, límites ni parse seguro.

## Resolución de empleador y empleo

Antes de comparar, el worker resuelve el Employer con el mismo servicio transaccional que usa la API y conserva la detección en la corrida candidata. El resolver admite un identificador fiscal ya validado y protegido con precedencia, pero el worker vigente sólo le entrega el nombre extraído: ingerir CUIT requiere todavía adapter por país y configuración criptográfica dedicada. Sin identificador, recupera candidatos por normalización y sólo reutiliza una coincidencia conservadora y única de nombre o alias dentro del país. Si el documento ya tiene un Employment owner-scoped, su Employer canónico puede desambiguar únicamente cuando integra esos candidatos exactos; en cualquier otro caso la ambigüedad no dispara OCR adicional, IA ni fuzzy matching y conserva revisión pendiente. Durante un reproceso, Document e ImportBatchItem no cambian hasta una promoción.

El Employer detectado queda en Document como procedencia aunque `employment_id` permanezca nulo. La autoasociación exige exactamente un Employment del owner, para ese Employer y moneda, cuyo intervalo cubra `payrollPeriod`. Cero o varias filas dejan el documento sin asociar. Cuando hay una única coincidencia, ImportBatchItem, Document y PayrollSettlement convergen transaccionalmente al mismo Employment.

Si un reproceso detecta otro Employer para un documento ya asociado, no borra la decisión existente ni modifica la detección activa: conserva el candidato como `REVIEW_REQUIRED`. La comparación owner-only muestra el empleador detectado en ambas corridas; una promoción explícita cambia la detección activa bajo lock, pero preserva la asociación laboral confirmada.

## Clasificación por costo

1. Extraer una muestra de texto ya presente y combinar múltiples señales laborales.
2. Si no hay texto, renderizar una primera página/thumbnail dentro de límites y ejecutar OCR ligero.
3. Si sigue ambiguo, usar clasificador especializado.
4. Sólo high confidence avanza automáticamente; medium solicita confirmación; low rechaza antes del OCR completo.

Los thresholds son configuración versionada. La salida guarda tipo candidato, confidence, señales, versión y costo.

## ImportBatch

ImportBatch es la fuente de progreso agregado y la web recupera el lote activo al volver. Cada ImportBatchItem conserva su estado y error de dominio; un item fallido no revierte otros. El porcentaje visible cuenta items terminales sobre el total y no inventa una ETA por etapa. Durante la transferencia directa, el navegador muestra además el porcentaje real de bytes por archivo y advierte antes de abandonar la página; sólo después de confirmar un archivo su procesamiento continúa sin el navegador. Un upload interrumpido queda visible como pendiente, pero sus bytes locales no son recuperables: el MVP permite cancelarlo y volver a seleccionarlo, no reanudarlo.

Contadores derivados:

- total;
- PENDING_UPLOAD;
- UPLOADED;
- PROCESSING;
- COMPLETED;
- NEEDS_REVIEW;
- REJECTED;
- FAILED;
- CANCELLED.

La implementación actual completa el lote automáticamente cuando todos sus items son terminales, admite un solo lote activo por usuario y permite cancelar items que aún no terminaron el upload. El reproceso agrupado usa `ReprocessingBatch`: sólo correlaciona jobs existentes del mismo titular y deriva progreso y resumen sin crear otra cola. Pause y resume manuales siguen fuera del MVP.

## Idempotencia

Claves mínimas:

- uploadSessionId + itemId para completar upload;
- userId + checksum para descartar un segundo binario exacto sólo dentro del usuario; el tombstone precede al cascade y el lote conserva únicamente un conteo agregado;
- documentId + processingVersion + stage para jobs;
- userId + documentId + clave de idempotencia del titular para replay de la misma solicitud;
- un único job activo por documentId y fingerprint de pipeline para carreras entre acciones individuales y batch;
- providerOperationId para OCR/IA facturable;
- documentId + extractionRunId para materializar resultados.
- countryCode + nombre normalizado dentro de un advisory lock para resolver o crear Employer.

Restricciones de DB y transacciones son la última defensa. Un ack perdido o un mensaje duplicado no puede crear otra liquidación.

El reproceso bloquea el Document, rechaza originales ausentes o no limpios, captura `active_extraction_run_id` como baseline y calcula `processingVersion` sobre jobs y corridas previas. Las corridas anteriores permanecen inmutables; la última corrección humana por `fieldPath` se copia con referencia a su raíz y se aplica a la nueva proyección. Al terminar, la comparación vuelve a bloquear el documento y sólo promociona por compare-and-set si el activo no cambió.

Todo job nuevo entra por `DOCUMENT_PIPELINE_V2` con fingerprint exacto. Cuando existe un artefacto completo, owner-scoped, con checksum válido y versiones compatibles de texto/OCR, el worker puede saltar internamente a parsing. Si cambia una etapa anterior o el artefacto no existe, parte del PDF. El texto comprimido permanece en storage privado cifrado, nunca en la cola ni en logs, y se elimina durablemente junto con el original.

La migración de protocolo toma un lock exclusivo sobre jobs, exige que no haya leases ni `execution_owner`, transforma pendientes y reescribe inserts de la API previa. Los workers anteriores no conocen `DOCUMENT_PIPELINE_V2`; los posteriores sólo despachan y reclaman su fingerprint. Esto evita que una convergencia gradual publique una corrida con semántica de otro binario.

## Backpressure y fairness

La implementación actual aplica:

- concurrencia global y por usuario; el dispatcher publica sólo los slots realmente disponibles;
- máximo de imports activos, documentos/bytes por batch y cuota de documentos/bytes por usuario;
- round-robin o scheduling equivalente entre usuarios;
- timeout por etapa;
- retry con backoff y jitter.

Quedan como objetivo la prioridad por etapa, dead-letter y budgets de costo por documento, usuario y batch.

No se crean 400 procesos OCR para 400 archivos. Se crean items persistentes y una cantidad acotada de jobs ejecutables.

## Circuit breaker de batch (futuro)

Tras una muestra configurable, si la proporción de unsupported supera el umbral configurado:

1. pausar nuevos items;
2. conservar los ya seguros;
3. mostrar la razón sin afirmar tipos con certeza insuficiente;
4. permitir revisar, eliminar o continuar explícitamente.

El breaker evita selección accidental de carpetas, uso como OCR genérico y ataques económicos.

## Errores visibles

- DOCUMENT_UNSUPPORTED
- DOCUMENT_TOO_LARGE
- DOCUMENT_TOO_MANY_PAGES
- DOCUMENT_ENCRYPTED
- DOCUMENT_MALWARE_DETECTED
- DOCUMENT_CORRUPTED
- DOCUMENT_LOW_CONFIDENCE
- PROCESSING_TIMEOUT
- OCR_TEMPORARILY_UNAVAILABLE

Los detalles internos se sanitizan. La UI traduce códigos; no muestra sólo error 500.

## Cleanup y borrado

Temporales, renders y OCR intermedio tienen TTL corto y owner/documentId. Al cancelar o borrar se cierran sesiones y jobs pendientes. En R2, el delete fuerte del marcador/objeto invalida el `If-Match` y permite cerrar el cleanup tras confirmar el borrado; AWS/local conserva el reborrado hasta vencer TTL y gracia. Cada acción registra auditoría sin contenido sensible. La política completa está en [Retención](../privacy/data-retention.md).

## Observabilidad

Se registran IDs internos, stage, versión, duración, costo aproximado, resultado y errorCode. Nunca contenido, salario, identificadores fiscales, texto OCR o URL firmada.

Métricas iniciales:

- documents_uploaded_total;
- documents_rejected_total;
- documents_processed_total;
- documents_ocr_required_total;
- document_processing_seconds;
- queue_depth;
- worker_failures_total;
- classification_unknown_total.

## Verificación mínima antes del MVP

- ejecutable renombrado a PDF;
- MIME falso, PDF corrupto, cifrado, vacío, sobredimensionado y con demasiadas páginas;
- factura, resumen bancario, imagen renombrada y documento ambiguo;
- duplicado del mismo usuario sin leak cross-user;
- archivo de prueba antivirus;
- batch válido, inválido y mixto;
- retry duplicado;
- caída de cola/worker/OCR;
- usuario A intentando leer o borrar documento de B;
- carga sintética de 500 documentos sin crecimiento de memoria de API proporcional al batch.
