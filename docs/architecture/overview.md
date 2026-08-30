# Arquitectura general

> Estado: MVP local implementado. Las capacidades futuras del diagrama siguen siendo objetivo, no comportamiento actual.

## Estilo

La arquitectura objetivo es un monolito modular TypeScript con dos unidades de ejecución iniciales:

- web/API para interacción síncrona y coordinación;
- worker de documentos para seguridad, clasificación, extracción, OCR, parsing y normalización.

Comparten dominio y contratos. Separar el proceso pesado protege latencia y memoria de la API; no convierte cada etapa en un microservicio.

## Diagrama

~~~mermaid
flowchart TB
    U[Usuario / navegador] --> E[CDN + WAF]
    E --> W[Web]
    W --> A[API / BFF<br/>monolito modular]
    A --> P[(PostgreSQL)]
    A --> O[(Object storage privado)]
    W -. upload con autorización breve .-> O
    J[Dispatcher de jobs] --> P
    J --> Q[(Redis / cola)]
    Q --> K[Worker de documentos]
    K --> O
    K --> M[Malware scanner]
    K --> D[Clasificación + extracción]
    D -. sólo si hace falta .-> R[OCR]
    D -. último fallback minimizado .-> I[Proveedor IA]
    K --> P
~~~

El navegador nunca recibe credenciales permanentes ni una URL pública. El acceso directo a storage usa una autorización breve, limitada a una key opaca creada por la API.

## Responsabilidades

| Componente | Hace | No hace |
| --- | --- | --- |
| Web | preflight UX, upload directo, progreso y revisión | decidir seguridad o ownership |
| API/BFF | auth, ownership, sesiones de upload, batches, consultas y comandos | OCR síncrono o cargar PDFs completos |
| PostgreSQL | metadata, dominio estructurado, estados, job/outbox durable, auditoría e idempotencia | almacenar binarios |
| Redis/cola | scheduling, backpressure, retries y fairness | ser la única fuente de verdad del batch |
| Object storage | originales, cuarentena y objetos temporales controlados | exposición pública |
| Worker | pipeline pesado aislado, por documento y con budgets | confiar en metadata del upload |
| Proveedores | capacidades externas detrás de ports | gobernar reglas del dominio |

PostgreSQL conserva el estado recuperable. Al confirmar un upload, la misma transacción crea un ProcessingJob pendiente. Un dispatcher lo publica en Redis después del commit y un reconciliador republica pendientes; la cola entrega trabajo, pero no es la única copia del intent.

## Límites de confianza

1. Internet a edge: tráfico hostil.
2. Navegador a API: usuario autenticado no implica entrada confiable.
3. Navegador a storage: autorización por objeto, método, tamaño y expiración.
4. Storage a worker: el objeto sigue siendo hostil hasta completar seguridad.
5. Worker a parser/OCR: ejecución con CPU, RAM, tiempo, filesystem y red limitados.
6. Aplicación a proveedor externo: salida mínima, redactada y autorizada.
7. Aplicación a observabilidad: sólo IDs internos, códigos y métricas no sensibles.

## Módulos de dominio

- identity: usuarios, sesiones, MFA TOTP, step-up y recuperación;
- employment: empleadores, relaciones laborales y eventos;
- imports: sesiones, batches, items y progreso;
- documents: metadata, lifecycle, seguridad y retención;
- payroll: liquidaciones, conceptos y correcciones;
- analytics: proyecciones sobre datos estructurados;
- privacy: preferencias, exportación y eliminación;
- audit: eventos sensibles sin payload salarial.

Las dependencias apuntan hacia adentro:

~~~text
apps/adapters -> application services -> domain
                           |
                           v
                         ports
~~~

El dominio no importa framework web, ORM, SDK de storage, Redis, OCR o IA. Los adapters traducen esos detalles.

## Estructura objetivo mínima

Las carpetas se crearán cuando exista código que alojar; no se agregan placeholders vacíos.

~~~text
apps/
  web/
  api/
  worker-documents/
packages/
  domain/
  contracts/
  database/
  config/
  document-engine/
  payroll-engine/
  security/
infrastructure/
  docker/
docs/
tests/
  fixtures/
  integration/
  security/
  load/
~~~

No se separa worker-ingestion de worker-documents hasta que despliegue, permisos o escalado demuestren que aporta valor.

## Contrato HTTP

La API pública se versiona bajo /api/v1 y valida todo input server-side mediante schemas de Fastify. OpenAPI sigue pendiente; no se presenta todavía como contrato público implementado.

Recursos iniciales:

| Recurso | Operaciones MVP |
| --- | --- |
| upload-sessions | crear y confirmar upload |
| imports | crear, consultar, recuperar el lote activo y cancelar uploads pendientes; pausa/reanudación quedan pendientes |
| documents | listar, consultar, asociar masivamente a un empleo, corregir, cerrar revisión, eliminar y confirmar tipo; reproceso queda pendiente |
| employments | listar, crear y editar/finalizar |
| payroll-settlements | listar la proyección; las correcciones se aplican desde documents |
| analytics | evolución salarial estructurada |
| exports | solicitar y consultar export privado |
| privacy | eliminar cuenta; preferencias editables quedan pendientes |

Los errores usan códigos de dominio estables y mensajes sanitizados. Cuando se incorpore OpenAPI describirá auth, schemas, límites y respuestas; los detalles de proveedor quedarán fuera del contrato HTTP.

## Ports principales

Los siguientes son límites reales de infraestructura. Sus tipos exactos se definen con el primer consumidor, no en esta documentación.

| Port | Contrato mínimo |
| --- | --- |
| ObjectStorageProvider | autorizar upload, inspeccionar metadata confiable, abrir stream, borrar objeto y crear descarga breve |
| QueueProvider | publicar por document/job/version, retry, cancelar y consultar salud |
| MalwareScanner | escanear un stream/objeto limitado y devolver clean, infected, error o timeout |
| DocumentClassifier | tipo, confidence, señales y versión |
| OCRProvider | extraer texto paginado con versión, costo y confidence |
| PayrollExtractor | producir 0..N liquidaciones candidatas y campos trazables |
| AIProvider | fallback minimizado con purpose, budget, versión y auditoría |
| EncryptionProvider | cifrar/descifrar datos permitidos y exponer key version, nunca material de clave |
| EconomicIndexProvider | valor, período, fuente y versión; fuera del MVP |
| MarketCalibrationProvider | referencia externa versionada y opcional para calibración; futuro, no fuente principal |

Cada llamada externa acepta idempotency key, timeout y contexto mínimo. Los SDK concretos viven en adapters.

## Configuración

Toda variable se valida al arranque y se obtiene de entorno/secret manager. No hay defaults silenciosos en producción.

| Grupo | Variables previstas |
| --- | --- |
| Runtime | APP_ENV, LOG_LEVEL, PUBLIC_ORIGIN |
| Database | DATABASE_URL, DB_POOL_MIN, DB_POOL_MAX |
| Queue | QUEUE_URL, OUTBOX_POLL_INTERVAL_MS, WORKER_CONCURRENCY, WORKER_CONCURRENCY_PER_USER, JOB_TIMEOUT_MS, JOB_MAX_RETRIES |
| Storage | OBJECT_STORAGE_ENDPOINT, REGION, BUCKET, ACCESS_KEY, SECRET_KEY, SIGNED_URL_TTL_SECONDS |
| Upload | MAX_FILE_BYTES, MAX_FILES_PER_BATCH, MAX_BATCH_BYTES, MAX_ACTIVE_IMPORTS_PER_USER, MAX_USER_DOCUMENTS, MAX_USER_STORAGE_BYTES |
| Parsing | MAX_PARSE_TIME_MS, MAX_OCR_TIME_MS, MAX_RENDER_PIXELS, MAX_WORKER_MEMORY_BYTES |
| Classification | CLASSIFICATION_HIGH_THRESHOLD, CLASSIFICATION_LOW_THRESHOLD, BATCH_REJECTION_SAMPLE_SIZE, BATCH_REJECTION_RATIO |
| Cost | DOCUMENT_BUDGET, USER_DAILY_BUDGET, BATCH_BUDGET |
| Privacy | DEFAULT_RETENTION_POLICY, DELETE_AFTER_DAYS, TEMP_RETENTION_HOURS |
| Security | CLAMAV_HOST, CLAMAV_PORT, ENCRYPTION_KEY_ID |
| Observability | OTEL_ENDPOINT, ERROR_REPORTING_DSN, PII_REDACTION_ENABLED |

Los valores del archivo .env.example sólo levantan infraestructura local. Límites de producto se fijarán junto con tests de abuso y carga, no por intuición.

Los límites vigentes son defaults globales. En una evolución futura, un entitlement server-side resolverá capacidades y cuotas efectivas sin acoplar el dominio a billing. Un downgrade limitará nuevas operaciones, pero no borrará datos existentes.

El benchmark futuro agregará, fuera del historial privado, sólo contribuciones consentidas y revocables derivadas de settlements verificados. Consultará cohortes predefinidas por familia de rol, seniority, Argentina o región amplia, industria y período, sin filtro por empresa ni filas individuales. k mínimo, bandas/percentiles, sample size redondeado, anti-differencing, query budget, demora y recomputación por retiro protegen la privacidad. Datos externos quedan como calibración opcional e IA no es necesaria al inicio. Ver [ADR 0006](../adr/0006-entitlements-and-market-benchmarking.md).

## Degradación

- OCR caído: API disponible; jobs quedan retryable.
- Cola caída: uploads ya confirmados permanecen en DB/storage y se reconcilian.
- Worker caído: el lease lógico expira, pero el marcador de ejecución queda fail-closed y bloquea retry y baja hasta verificar que el proceso y su temporal terminaron; la recuperación operativa segura sigue pendiente.
- Proveedor externo caído: no tumba el dominio; se usa fallback permitido o estado visible.
- Storage caído: no se marca upload como completo.
- Malware scanner no disponible: fail closed; el objeto no avanza.

## Estrategia de verificación

- Unit: invariantes de dominio, estados, dinero y precedencia de correcciones.
- Integration: PostgreSQL, cola, storage, idempotencia y cleanup.
- Security: ownership/IDOR, MIME falso, magic bytes, malware, PDF corrupto/cifrado, límites y URLs firmadas.
- Load: un usuario con 500 documentos y varios usuarios simultáneos; la memoria API debe mantenerse acotada.
- Fixtures: sólo PDFs sintéticos válidos, SAC, bono, factura, corrupto, renombrado, vacío, escaneado, sobredimensionado, cifrado y ambiguo.

Pipeline CI objetivo:

~~~text
lint -> typecheck -> unit -> integration -> security -> build -> dependency/secret scan
~~~

El workflow `.github/workflows/ci.yml` ejecuta lint, typecheck, unit, build web, validación de Compose, migraciones e integración local sintética. SAST, secret scan e image scan bloqueantes siguen pendientes.

## Decisiones abiertas

El corte vertical usa React/Vinext, Fastify, PostgreSQL mediante `pg`, Redis, sesiones propias y MFA TOTP. Siguen abiertos el proveedor cloud, región, cifrado y backups de producción. Las decisiones materiales se registran mediante ADR.
