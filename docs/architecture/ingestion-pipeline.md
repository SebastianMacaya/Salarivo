# Pipeline de ingestión

> Estado: corte vertical implementado para PDF salarial argentino, con progreso recuperable, cancelación de uploads pendientes y revisión manual. Pausa/reanudación, LLM y otros tipos siguen fuera del MVP.

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

Cada transición usa compare-and-set o transacción equivalente. Estados terminales no retroceden salvo un comando explícito de reprocesamiento que crea una nueva versión.

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
| 8 | extracción directa | preferida si existe texto confiable |
| 9 | OCR | sólo para páginas necesarias y con budget |
| 10 | parsing/normalización | determinístico y versionado |
| 11 | IA futura | fallback mínimo, redactado y presupuestado |
| 12 | validación | COMPLETED o NEEDS_REVIEW; el usuario puede completar montos ausentes y cerrar la revisión |

El parser no inventa montos. El neto sólo puede derivarse de los totales de una tabla salarial reconocida cuando además existe una etiqueta explícita de neto, siempre con aritmética decimal exacta. Un valor ausente queda como evidencia trazable; si bruto, descuentos y neto no balancean, los valores extraídos se conservan pero el documento pasa a NEEDS_REVIEW y no puede cerrarse hasta corregirlos.

Confirmar manualmente el tipo nunca salta malware, límites ni parse seguro.

## Clasificación por costo

1. Extraer una muestra de texto ya presente y combinar múltiples señales laborales.
2. Si no hay texto, renderizar una primera página/thumbnail dentro de límites y ejecutar OCR ligero.
3. Si sigue ambiguo, usar clasificador especializado.
4. Sólo high confidence avanza automáticamente; medium solicita confirmación; low rechaza antes del OCR completo.

Los thresholds son configuración versionada. La salida guarda tipo candidato, confidence, señales, versión y costo.

## ImportBatch

ImportBatch es la fuente de progreso agregado y la web recupera el lote activo al volver. Cada ImportBatchItem conserva su estado y error de dominio; un item fallido no revierte otros. El porcentaje visible cuenta items terminales sobre el total y no inventa una ETA por etapa.

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

La implementación actual completa el lote automáticamente cuando todos sus items son terminales, admite un solo lote activo por usuario y permite cancelar items que aún no terminaron el upload. Pause, resume, cancelación de trabajo ya iniciado y retry operados por el usuario siguen siendo objetivo; no se describen como disponibles.

## Idempotencia

Claves mínimas:

- uploadSessionId + itemId para completar upload;
- userId + checksum para advertir duplicado sólo dentro del usuario;
- documentId + processingVersion + stage para jobs;
- providerOperationId para OCR/IA facturable;
- documentId + extractionRunId para materializar resultados.

Restricciones de DB y transacciones son la última defensa. Un ack perdido o un mensaje duplicado no puede crear otra liquidación.

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
