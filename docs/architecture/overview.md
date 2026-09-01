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
    U -. Authorization Code + PKCE .-> G[Google OIDC]
    E --> W[Web]
    W --> A[API / BFF<br/>monolito modular]
    G -. callback GET validado .-> A
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

El proveedor se selecciona explícitamente. La instancia productiva usa Cloudflare R2 Standard privado, con cifrado AES-256-GCM y claves administradas por Cloudflare; `r2.dev` y custom domains permanecen deshabilitados. API y worker comprueban esa configuración, CORS y lifecycle en modo read-only y fallan cerrados ante drift. El adapter AWS se conserva con sus controles SSE-KMS y Public Access Block. [ADR 0011](../adr/0011-cloudflare-r2-production-storage.md) registra la diferencia sin llevarla al dominio.

## Responsabilidades

| Componente | Hace | No hace |
| --- | --- | --- |
| Web | preflight UX, upload directo, progreso, revisión y consola admin filtrada por capacidades | decidir seguridad, ownership o autorización administrativa |
| API/BFF | auth local/Google, sesiones propias, ownership, RBAC admin, sesiones de upload, batches, consultas y comandos | OCR síncrono, cargar PDFs completos o delegar autorización al IdP |
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
8. Navegador/API a Google OIDC: `state`, `nonce` y PKCE por intento; callback, issuer, audience y redirects validados server-side.
9. Administrador a API: MFA y capacidad explícita por request; un rol administrativo nunca reemplaza ownership ni habilita payload Restricted.

## Módulos de dominio

- identity: usuarios internos, cuentas de autenticación, sesiones opacas, actividad y cliente coarse de sesión, Google OIDC, MFA TOTP, step-up y recuperación;
- employment: empleadores, relaciones laborales y eventos;
- imports: sesiones, batches, items y progreso;
- documents: metadata, lifecycle, seguridad y retención;
- payroll: liquidaciones, conceptos y correcciones;
- analytics: proyecciones `salary-analytics-v1` sobre liquidaciones estructuradas y verificadas, separadas por empleo y moneda;
- privacy: preferencias, exportación y eliminación;
- audit: eventos sensibles sin payload salarial.
- admin: consultas transversales de metadata, capacidades fijas y comandos operativos auditados.

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
| auth | alta e inicio/callback Google, onboarding, logout, listado y revocación owner-only de sesiones, MFA y step-up |
| upload-sessions | crear y confirmar upload |
| imports | crear, consultar, recuperar el lote activo y cancelar uploads pendientes; pausa/reanudación quedan pendientes |
| documents | listar, consultar, asociar masivamente a un empleo, corregir, cerrar revisión, eliminar, confirmar tipo, reprocesar y consultar/decidir historial de corridas |
| reprocessing | candidatos owner-only, batch asincrónico, progreso y resumen |
| employments | listar, crear y editar/finalizar mediante el resolver global de Employer; confirmar detecciones inequívocas |
| payroll-settlements | listar la proyección; las correcciones se aplican desde documents |
| salary-history | resumen, evolución y anual agregados; comparación y conceptos paginados owner-only; posibles duplicados sólo como advertencia |
| exports | solicitar y consultar export privado |
| privacy | eliminar cuenta; preferencias editables quedan pendientes |
| admin | dashboard, metadata paginada, salud del pipeline, reproceso/rollback auditados, revisión/merge de Employer y comandos acotados por capacidad; sin acceso a contenido privado |

Los errores usan códigos de dominio estables y mensajes sanitizados. Cuando se incorpore OpenAPI describirá auth, schemas, límites y respuestas; los detalles de proveedor quedarán fuera del contrato HTTP.

### Analytics salarial

`GET /api/v1/salary-history` deriva `salary-analytics-v1` exclusivamente desde `Document.active_extraction_run_id` de documentos `COMPLETED`; una corrida candidata, fallida o pendiente nunca desplaza el resultado publicado y un baseline `NEEDS_REVIEW` queda fuera hasta su cierre. Su payload es agregado, añade contexto de completitud/reproceso y no envía conceptos históricos. `GET /api/v1/salary-history/concepts` aplica el mismo gate y pagina directamente en SQL sólo los haberes normalizados de un contexto y moneda owner-scoped, con páginas de hasta 100 filas y filtros por año/categoría; no expone descripciones originales y un concepto desconocido no oculta los normalizados del mismo recibo. `GET /api/v1/salary-history/comparison` exige contexto laboral, currencyCode y dos períodos. Ningún cálculo cruza empleos o monedas, y varias liquidaciones del mismo mes se conservan. Una explicación sólo atribuye la variación neta cuando los conceptos están completos, la porción regular permanece estable y extraordinarios menos descuentos reconcilian exactamente; de lo contrario declara evidencia insuficiente o variación no explicada.

El comparable inicial es únicamente basicAmount de una liquidación `NORMAL` recurrente verificada; falta o ambigüedad devuelven N/D. Cuando ese N/D proviene de un issue recuperable, la respuesta lo señala sin inferir un monto y ofrece el mismo batch centralizado que el detalle del documento. Dinero y porcentajes se calculan con BigInt/decimal exacto y variación compuesta, no con FLOAT ni suma de porcentajes. El agregado incluye remunerativo/no remunerativo, categorías anuales, totales normalizados y posibles duplicados sujetos a confirmación; nunca expone categorías ni descripciones crudas de deducciones minimizadas.

La cobertura usa los límites confirmados del empleo cuando existen y, en una detección, sólo el rango observado; los huecos son siempre `possibleMissingPeriods`. Sin un contexto laboral determinable no inventa rango ni faltantes. La lista de documentos devuelve total y revisión pendiente bajo los mismos filtros owner-only, se pagina con cursor opaco que conserva la precisión del timestamp y admite búsqueda, año/período, empleo, estado/grupo, clase y tipo de liquidación. `UNSUPPORTED` es una categoría de consulta sobre clasificación/estado, no un `document_type` persistido.

La decisión, sus alternativas y el límite deliberado de IPC están en el [ADR 0013](../adr/0013-derived-salary-history-analytics.md).

### Identidad externa y sesión interna

Google usa OIDC Authorization Code con PKCE, `state` y `nonce`; el callback es `GET`. Cada intento es breve, de un solo uso y queda ligado al navegador por una cookie y estado server-side. El redirect posterior sólo puede apuntar a destinos internos allowlisted.

La respuesta válida se resuelve por `(provider, sub)` en `auth_accounts`. El email recibido es un atributo verificable del perfil, no una clave de login ni de vinculación: una colisión nunca auto-vincula una cuenta. No se persisten access, refresh ni ID tokens. Google termina en el UUID y la sesión opaca interna ya usados por los guards y por ownership.

Para una identidad nueva, el callback deja un onboarding pendiente, pero no crea una cuenta activa. El segundo paso crea usuario, aceptación legal, `auth_account`, sesión y auditoría en una única transacción. `BLOCKED` y `SUSPENDED` fallan cerrados. En una cuenta Google-only, el step-up inicia otra autorización con selección explícita de la misma cuenta, ligada a la sesión actual, y rota esa sesión cuando termina; la persona también puede revocar el resto de sus sesiones. [ADR 0010](../adr/0010-google-oidc-and-external-identities.md) conserva sin cambios el modelo de ownership.

El titular puede listar sus sesiones activas y revocar una distinta de la actual o todas las demás. La API determina la sesión actual desde el token opaco ya autenticado y vuelve a validar ownership y step-up al revocar; nunca acepta un `userId` del navegador. La metadata visible se reduce a categorías allowlisted de dispositivo, navegador y sistema operativo, sin guardar user-agent crudo, versiones, IP, ubicación o fingerprint.

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
| Google OIDC | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI |
| Database | DATABASE_URL, DB_POOL_MIN, DB_POOL_MAX |
| Queue | QUEUE_URL, OUTBOX_POLL_INTERVAL_MS, WORKER_CONCURRENCY, WORKER_CONCURRENCY_PER_USER, JOB_TIMEOUT_MS, JOB_MAX_RETRIES |
| Storage | OBJECT_STORAGE_PROVIDER, OBJECT_STORAGE_REGION, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY, OBJECT_STORAGE_SECRET_KEY; API: OBJECT_STORAGE_INTERNAL_ENDPOINT y OBJECT_STORAGE_PUBLIC_ENDPOINT; worker: OBJECT_STORAGE_ENDPOINT y STORAGE_DELETE_VERIFY_DELAY_MS; para AWS: OBJECT_STORAGE_KMS_KEY_ID; para R2: PUBLIC_ORIGIN, CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_R2_API_TOKEN |
| Web | NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_STORAGE_ORIGIN (origen exacto de R2 para CSP, nunca una URL firmada) |
| Upload | MAX_FILE_BYTES, MAX_FILES_PER_BATCH, MAX_BATCH_BYTES, MAX_ACTIVE_IMPORTS_PER_USER, MAX_USER_DOCUMENTS, MAX_USER_STORAGE_BYTES |
| Parsing | MAX_PARSE_TIME_MS, MAX_OCR_TIME_MS, MAX_RENDER_PIXELS, MAX_WORKER_MEMORY_BYTES |
| Classification | CLASSIFICATION_HIGH_THRESHOLD, CLASSIFICATION_LOW_THRESHOLD, BATCH_REJECTION_SAMPLE_SIZE, BATCH_REJECTION_RATIO |
| Cost | DOCUMENT_BUDGET, USER_DAILY_BUDGET, BATCH_BUDGET |
| Privacy | DEFAULT_RETENTION_POLICY, DELETE_AFTER_DAYS, TEMP_RETENTION_HOURS |
| Security | CLAMAV_HOST, CLAMAV_PORT, MFA_ENCRYPTION_KEY_VERSION, MFA_ENCRYPTION_KEY_BASE64, EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_VERSION, EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_BASE64, EMPLOYER_IDENTIFIER_FINGERPRINT_KEY_BASE64 |
| Observability | OTEL_ENDPOINT, ERROR_REPORTING_DSN, PII_REDACTION_ENABLED |

Los valores del archivo .env.example sólo levantan infraestructura local. Límites de producto se fijarán junto con tests de abuso y carga, no por intuición.

Para R2, un límite global no configurable de `8.000.000.000` bytes se evalúa dentro de la transacción que reserva cuota para nuevos uploads. Evita que dos requests concurrentes sobrepasen el límite por separado y falla cerrado; complementa, pero no reemplaza, las cuotas por usuario y batch.

Los límites vigentes son defaults globales. En una evolución futura, un entitlement server-side resolverá capacidades y cuotas efectivas sin acoplar el dominio a billing. Un downgrade limitará nuevas operaciones, pero no borrará datos existentes.

El benchmark futuro agregará, fuera del historial privado, sólo contribuciones consentidas y revocables derivadas de settlements verificados. Consultará cohortes predefinidas por familia de rol, seniority, Argentina o región amplia, industria y período, sin filtro por empresa ni filas individuales. k mínimo, bandas/percentiles, sample size redondeado, anti-differencing, query budget, demora y recomputación por retiro protegen la privacidad. Datos externos quedan como calibración opcional e IA no es necesaria al inicio. Ver [ADR 0006](../adr/0006-entitlements-and-market-benchmarking.md).

## Degradación

- OCR caído: API disponible; jobs quedan retryable.
- Cola caída: uploads ya confirmados permanecen en DB/storage y se reconcilian.
- Worker caído: el lease lógico expira, pero el marcador de ejecución queda fail-closed y bloquea retry y baja hasta verificar que el proceso y su temporal terminaron; la recuperación operativa segura sigue pendiente.
- Proveedor externo caído: no tumba el dominio; se usa fallback permitido o estado visible.
- Google caído: no se abre ni eleva una sesión mediante ese proveedor; las sesiones internas ya válidas conservan sus controles normales.
- Storage caído: no se marca upload como completo.
- Malware scanner no disponible: fail closed; el objeto no avanza.

## Estrategia de verificación

- Unit: invariantes de dominio, estados, dinero y precedencia de correcciones.
- Integration: PostgreSQL, cola, storage, idempotencia y cleanup.
- Security: ownership/IDOR por cada método de login, colisiones de identidad OIDC, replay/callback/redirect, MIME falso, magic bytes, malware, PDF corrupto/cifrado, límites y URLs firmadas.
- Admin: deny-by-default, capacidad por endpoint, MFA/step-up, DTO mínimos, IDOR transversal, concurrencia de comandos y auditoría atómica.
- Load: un usuario con 500 documentos y varios usuarios simultáneos; la memoria API debe mantenerse acotada.
- Fixtures: sólo PDFs sintéticos válidos, SAC, bono, factura, corrupto, renombrado, vacío, escaneado, sobredimensionado, cifrado y ambiguo.

Pipeline CI objetivo:

~~~text
lint -> typecheck -> unit -> integration -> security -> build -> dependency/secret scan
~~~

El workflow `.github/workflows/ci.yml` ejecuta lint, typecheck, unit, build web, validación de Compose, migraciones e integración local sintética. SAST, secret scan e image scan bloqueantes siguen pendientes.

## Decisiones abiertas

El corte vertical usa React/Vinext, Fastify, PostgreSQL mediante `pg`, Redis, sesiones propias, Google OIDC, MFA TOTP y una [consola administrativa](admin-console.md) privada por defecto. Cloudflare R2 fue elegido para object storage productivo con cifrado administrado por el proveedor; siguen abiertos la evaluación operativa/jurídica de ubicación y subencargados, el aislamiento final del parser y los backups de producción. La consola y las integraciones con Google/R2 no levantan el NO-GO para un backend público ni para datos reales. Las decisiones materiales se registran mediante ADR.
