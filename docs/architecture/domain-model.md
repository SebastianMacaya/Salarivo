# Modelo de dominio

> Estado: el modelo vigente existe en las migraciones 001–011. PositionPeriod y documentos laborales secundarios siguen Proposed.

## Separaciones centrales

1. Original: objeto recibido y su metadata.
2. Extracción: resultado automático inmutable y versionado.
3. Verificación: corrección/confirmación humana con precedencia.
4. Proyección: datos estructurados actuales usados por analytics.

Cada procesamiento completado conserva su ExtractionRun. El reproceso explícito y la precedencia de correcciones entre corridas siguen propuestos en el ADR 0004.

## Relaciones

~~~mermaid
erDiagram
    USER ||--o{ EMPLOYMENT : owns
    EMPLOYER ||--o{ EMPLOYMENT : participates
    USER ||--o{ IMPORT_BATCH : starts
    IMPORT_BATCH ||--o{ IMPORT_BATCH_ITEM : contains
    IMPORT_BATCH ||--o{ UPLOAD_SESSION : authorizes
    UPLOAD_SESSION ||--o{ IMPORT_BATCH_ITEM : scopes
    USER ||--o{ DOCUMENT : owns
    EMPLOYMENT o|--o{ DOCUMENT : groups
    IMPORT_BATCH_ITEM o|--o| DOCUMENT : becomes
    DOCUMENT ||--o{ EXTRACTION_RUN : processed_as
    DOCUMENT ||--o{ PROCESSING_JOB : schedules
    DOCUMENT ||--o{ PAYROLL_SETTLEMENT : supports
    EXTRACTION_RUN ||--o{ PAYROLL_SETTLEMENT : produces
    EXTRACTION_RUN ||--o{ EXTRACTED_FIELD : records
    EMPLOYMENT o|--o{ PAYROLL_SETTLEMENT : receives
    PAYROLL_SETTLEMENT ||--o{ PAYROLL_LINE_ITEM : contains
    NORMALIZED_CONCEPT o|--o{ PAYROLL_LINE_ITEM : classifies
    USER ||--o{ USER_CORRECTION : makes
    EXTRACTION_RUN ||--o{ USER_CORRECTION : contextualizes
    EXTRACTED_FIELD o|--o{ USER_CORRECTION : corrects
    USER ||--o{ MFA_FACTOR : protects
    MFA_FACTOR ||--o{ MFA_RECOVERY_CODE : issues
    USER ||--o{ AUDIT_EVENT : scopes
~~~

## Agregados

### User

Propietario y boundary de aislamiento. Conserva preferencias de privacidad y referencia a identidad; no debe acumular metadata documental.

### Employer y Employment

Employer representa una organización con nombre, país y 0..N identificadores fiscales tipados. Employment representa una relación del usuario con ese empleador. Un usuario puede tener varias relaciones simultáneas o sucesivas con el mismo Employer.

Campos esenciales de Employment:

- userId y employerId;
- startDate y endDate opcional;
- role, category y modality opcionales;
- countryCode y currencyCode;
- status y metadata mínima.

El puesto actual vive todavía en Employment. Una futura PositionPeriod conservará cambios de puesto/categoría con vigencia sin sobrescribir historia; no está implementada.

### ImportBatch

Coordina una importación persistente. ImportBatchItem existe antes de que haya Document para representar autorización, upload, rechazo temprano y error independiente.

### UploadSession

Autorización breve creada por la API y ligada a userId, batchId e items concretos. Conserva opaqueObjectKey, restricciones esperadas, expiresAt, status y timestamps de confirmación. No contiene credenciales permanentes; una sesión expirada o confirmada no se reutiliza.

### ProcessingJob

Registro durable que funciona como intent/outbox del trabajo asíncrono:

- documentId, userId, stage y processingVersion;
- idempotencyKey única;
- PENDING, PUBLISHED, RUNNING, RETRYABLE, COMPLETED o FAILED;
- availableAt, attempt, lease y timestamps;
- errorCode sanitizado.

Se inserta en la misma transacción que la transición que requiere trabajo. Un dispatcher publica su ID en Redis y un reconciliador recupera PENDING/PUBLISHED vencidos. El worker aplica compare-and-set/lease y sigue siendo idempotente ante delivery duplicado.

### Document

Representa un archivo recibido, no un recibo ni una liquidación.

Metadata mínima:

- id, userId y employmentId opcional;
- opaqueObjectKey; nunca filename original como path;
- originalFilename sólo como metadata sanitizada;
- declaredMimeType y detectedMimeType separados;
- sizeBytes, pageCount y checksum;
- securityStatus, classificationStatus, documentType y confidence;
- processingStatus y retentionPolicy;
- createdAt, processedAt y deletedAt.

El nombre visible del recibo se deriva de la proyección vigente (`payrollPeriod` y empresa efectiva); no reemplaza `originalFilename` ni la key opaca del objeto.

La asociación con Employment puede definirse al importar o después del procesamiento. El cambio posterior actualiza en una sola transacción el Document y sus PayrollSettlement; nunca se asocia por nombre sin confirmación humana.

No hay deduplicación física global. La advertencia de checksum se consulta por userId para evitar un canal lateral.

El tipo implementado sigue siendo PAYROLL. Contratos y adendas son una expansión propuesta con allowlist, Employment obligatorio, original privado y sin OCR inicial; ver [ADR 0005](../adr/0005-employment-history-and-evidence.md).

### PayrollSettlement

Una liquidación estructurada producida por una ExtractionRun. El esquema admite 0..N PayrollSettlement por Document y un período puede contener varias liquidaciones; el worker actual produce como máximo una por PDF.

Tipos iniciales:

- NORMAL;
- SAC;
- VACACIONES;
- BONO;
- RETROACTIVO;
- COMISION;
- HORAS_EXTRA;
- LIQUIDACION_FINAL;
- INDEMNIZACION;
- AJUSTE;
- OTRO_LABORAL.

Además del tipo se registra si el ingreso es recurrente o extraordinario. Montos: básico, bruto, neto, remunerativo, no remunerativo y descuentos, todos decimales y con currencyCode.

### PayrollLineItem y NormalizedConcept

PayrollLineItem conserva rawDescription y el concepto normalizado opcional. Un concepto desconocido no se descarta ni se fuerza a una categoría incorrecta.

Campos:

- rawDescription;
- normalizedConceptId opcional;
- exactAmount y currencyCode;
- EARNING, DEDUCTION o INFORMATIONAL;
- confidence, sourcePage y sourceField;
- recurrencia cuando sea inferible.

### ExtractionRun

Registro inmutable de cada procesamiento:

- processingVersion;
- parser/extractor/normalizer/classifier/OCR provider y versión;
- startedAt y finishedAt;
- confidence y resultado bruto permitido;
- errores sanitizados;
- costo computacional aproximado.

El resultado bruto no debe duplicar PII innecesaria. Los artefactos grandes o temporales no viven indefinidamente en PostgreSQL.

### ExtractedField

Evidencia por campo dentro de una ExtractionRun. Puede materializarse como filas o una estructura validada mientras conserve consultas y trazabilidad.

- fieldPath y entidad candidata;
- rawValue e interpretedValue;
- confidence;
- source: PDF_TEXT, OCR, RULE, TEMPLATE o AI_FALLBACK;
- page y región opcional;
- extractor/version y señales sanitizadas.

Empresa, período, básico, bruto, neto y total de descuentos pasan por esta representación. Los conceptos se conservan directamente como PayrollLineItem trazable dentro de la misma ExtractionRun. No alcanza con un confidence global de la corrida.

### UserCorrection

Corrección append-only que conserva documentId, extractionRunId, fieldPath, extractedValue, correctedValue y timestamp. Puede referenciar un ExtractedField o completar un monto ausente sin fingir que fue extraído. La proyección actual elige la corrección vigente dentro de la ExtractionRun seleccionada; la precedencia entre corridas aún no está implementada.

### Timeline laboral (propuesto)

Ingreso/egreso provienen de Employment, los cambios de puesto de PositionPeriod y los aumentos/bonos de PayrollSettlement. La timeline será una proyección; no se duplica todavía en SalaryEvent.

### AuditEvent

Registro separado de logs técnicos:

- actorId, action, resourceType, resourceId;
- timestamp, result y metadataNoSensitive.

Nunca contiene salario, OCR, documento, token o identificador fiscal completo.

### LegalDocumentVersion y LegalAcknowledgement

LegalDocumentVersion conserva una versión append-only de Términos o Aviso de Privacidad con locale, contenido, publicación, vigencia y aprobación explícita para producción. LegalAcknowledgement vincula un usuario con la versión exacta y un `acceptedAt` generado por servidor: para Términos representa aceptación; para el Aviso, lectura confirmada. El registro resuelve la versión vigente y compara las versiones mostradas; el navegador no selecciona IDs legales.

User tiene sólo `USER` o `ADMIN`. `ADMIN` habilita rutas explícitas de métricas sanitizadas y no altera ownership ni concede acceso a recursos de otra cuenta. El rol se relee desde DB en cada request privilegiado.

### MFAFactor, sesión y constancias de privacidad

MFAFactor conserva un secreto TOTP cifrado y versionado, estado pendiente/activo, contador anti-replay y lock temporal. Los recovery codes se guardan sólo como hashes. `mfaVerifiedAt` y `stepUpExpiresAt` pertenecen a la sesión exacta; elevar garantía rota su token.

StorageDeletionTombstone sobrevive a cascades y conserva únicamente las dos keys opacas necesarias para reconciliar un borrado físico. AccountDeletionReceipt conserva el hash de una constancia opaca y el estado de la baja sin email, nombre, userId ni FK personal después de completarse.

## Dinero

- PostgreSQL NUMERIC/DECIMAL; nunca FLOAT.
- currencyCode ISO explícito por monto/agregado.
- Las operaciones redondean sólo en un límite definido y testeado.
- Analytics distingue suma de ingresos del salario mensual recurrente.

## Fechas

Se modelan por separado:

- payrollPeriod, como mes/año de negocio;
- paymentDate;
- issueDate;
- employment start/end;
- uploadedAt y processedAt.

No se infiere que sean equivalentes. Timestamps técnicos se almacenan en UTC.

## País

countryCode es explícito. Un adapter de nómina contiene reglas locales; AR es el primero. Identificadores fiscales se representan como tipo + valor protegido, no como una columna CUIT universal.

## Integridad e índices

Las migraciones vigentes materializan:

- FK y ownership coherentes entre user, employment, document y settlement;
- unique por userId + checksum para duplicado lógico vigente;
- unique por documentId + processingVersion;
- unique de ProcessingJob por documentId + processingVersion + stage;
- unique por extractionRunId + settlementOrdinal;
- amount decimal y currencyCode obligatorio cuando existe monto;
- endDate no anterior a startDate;
- confidence dentro de 0..1;
- estados restringidos al vocabulario permitido; los servicios aplican las transiciones.

Índices:

- Document por userId + createdAt y userId + processingStatus;
- Employment por userId + status;
- PayrollSettlement por userId/employmentId + payrollPeriod;
- ImportBatchItem por batchId + status;
- ProcessingJob por state + availableAt y userId;
- AuditEvent por userId + timestamp.

Las políticas de row-level security pueden ser defensa adicional, nunca reemplazo de autorización en servicios.

## Borrado

Original y estructura tienen lifecycle separado:

- borrar original elimina object storage y derivados, pero puede conservar settlements;
- borrar documento elimina o anonimiza toda relación según elección/política;
- borrar cuenta coordina hoy DB, storage, cola, exports y temporales; cualquier cache externa, share o índice futuro deberá sumarse a esa orquestación antes de habilitarse.

Los detalles están en [Retención](../privacy/data-retention.md).

## Analytics

Analytics sólo consume proyecciones estructuradas y verificadas. No abre PDFs ni texto OCR. Sus cálculos guardan fuente y versión cuando dependen de índices económicos futuros.
