# Consola administrativa

> Estado: operaciones implementadas en código; su uso productivo requiere despliegue y verificación del entorno.

## Límite de autorización

La consola de plataforma usa dos controles server-side: `users.role = 'ADMIN'` habilita el contexto y `users.admin_role` resuelve un conjunto cerrado de capacidades. Estado, rol y garantía MFA se releen desde PostgreSQL en cada request privilegiado; las acciones críticas exigen además step-up vigente.

| Rol | Alcance principal |
| --- | --- |
| `SUPER_ADMIN` | todas las capacidades actuales, administración de roles, revisión de empleadores y publicación legal |
| `OPERATIONS` | diagnóstico de documentos/jobs y recuperación acotada |
| `SUPPORT` | metadata de usuario y contacto excepcional auditado |
| `SECURITY` | estados de cuenta, sesiones, cuarentena y eventos de seguridad |
| `FINANCE` | métricas agregadas de storage y límites visibles |
| `READ_ONLY` | vistas operativas no sensibles sin comandos |

La asignación exacta vive en `apps/api/src/admin-rbac.ts`; esta tabla sólo resume intención. Un valor desconocido falla cerrado. `/admin` filtra navegación por capacidad, pero la API repite siempre la autorización.

## Superficie actual

Las rutas `/api/v1/admin` cubren dashboard, usuarios, metadata de documentos y empleadores, jobs, salud/versiones/issues del pipeline, storage, operaciones de privacidad, seguridad, auditoría, historial/adopción legal, configuración sanitizada y health. Las listas operativas y búsquedas usan filtros allowlisted, paginación server-side e índices; el historial legal, de volumen excepcionalmente bajo, se carga completo para no agregar otro endpoint.

La presentación parte de 320 px y comparte los breakpoints de 768/1024 px de la aplicación. `AppNavigation` mantiene una única navegación: diálogo modal con foco contenido, Escape y scroll propio en mobile; sidebar persistente desde 1024 px. Las tablas conservan sus encabezados semánticos y `data-label`, con filas presentadas como cards en mobile y una tabla con scroll localizado en desktop cuando la cantidad de columnas lo exige. `PageHeader`, `QueryFilters`, las listas de metadata y `ActionDialog` se reutilizan en todas las secciones. Los filtros muestran su conteo activo y se pueden plegar; los diálogos tienen scroll interno y altura limitada por `100dvh`, incluidas las publicaciones legales extensas.

La navegación conserva URLs propias para secciones, detalles y filtros; cambiar de ruta renueva el estado de la pantalla para no arrastrar metadata del detalle anterior. Las consultas del navegador usan `cache: no-store`. La consola vuelve a verificar la sesión al recuperar foco, visibilidad o conexión y desmonta la metadata si el servidor informa `AUTHENTICATION_REQUIRED` o si la cuenta pierde acceso administrativo. Un fallo transitorio de red durante esa verificación no recarga formularios ni crea una copia local de los datos.

Los comandos actuales se limitan a estado de cuenta, revocación de sesiones, cambio de rol, cuarentena sin ejecución activa, retry de un job `RETRYABLE` en la misma versión, cancelación de jobs que aún no ejecutan, reproceso de candidatos, rollback a una corrida previamente activa y revisión de empleadores. `processing.reprocess` y `processing.rollback` están separados de lectura/retry/cancelación. Motivo y referencia son tipados; la mutación y su `admin_audit_events` se confirman en una transacción.

`employers.manage` pertenece sólo a `SUPER_ADMIN` y permite aprobar, rechazar, renombrar, agregar aliases, agregar/corregir CUIT y fusionar. Cada operación exige step-up y auditoría atómica. El CUIT se valida server-side, se cifra con AES-256-GCM y se busca mediante HMAC-SHA-256 con otra clave; la consola sólo recibe el sufijo enmascarado. El merge conserva el origen como `MERGED`, sigue el destino canónico, bloquea identificadores incompatibles o legacy no comparables y resuelve antes cualquier Employment exactamente redundante sin abrir documentos ni modificar montos.

La identidad exacta de Employment incluye país, subdivisión, régimen y tipo de relación además de usuario, empleador, fechas, rol, categoría, modalidad y moneda. Una fusión conserva relaciones distintas por cualquiera de esos datos. Al consolidar duplicados mantiene las confirmaciones de país, estado e ingreso; si ambos estados están confirmados y se contradicen, rechaza la operación antes de mover referencias hasta que se revisen.

`legal.manage` también pertenece sólo a `SUPER_ADMIN`. Permite programar una o dos versiones legales en un lote atómico con una vigencia compartida de entre un minuto y un año, número estrictamente creciente y confirmación explícita de aprobación profesional. Una corrección previa a la activación usa una versión superior con la misma vigencia; el número superior gana el desempate. Las versiones permanecen append-only; no hay edición, borrado, drafts ni rollback. La auditoría conserva tipo, versión, vigencia y flags, nunca título o contenido. La consola muestra el historial, las constancias por versión y el texto exacto programado antes de hacerlo público; ese conteo representa cuentas existentes, no un total histórico inmutable.

Un administrador debe ser deprovisionado por otra persona autorizada antes de usar la baja personal. El flujo de privacidad rechaza cuentas que todavía conservan `role = 'ADMIN'`, por lo que tampoco puede retirar indirectamente al último `SUPER_ADMIN`.

## DTO y privacidad

Los DTO administrativos se consultan directamente para su propósito y no reutilizan un endpoint owner-only con bypass. Por defecto contienen metadata operativa: UUID internos, estados, timestamps, conteos, tamaños, versiones, outcomes y códigos sanitizados. La salud de procesamiento agrega conteos y distribuciones por status, versión e issue; nunca valores ni texto. El detalle de Employer agrega nombre normalizado y hasta 20 orígenes de detección ordenados: UUID de documento y lote, nombre interpretado o corregido, fuente, confianza y fecha. No incluye owner, filename, región, señales, texto OCR ni montos. El contacto completo está separado, requiere permiso, step-up y auditoría.

Nunca se serializan a la consola:

- PDF, filename original, object key, checksum o URL firmada;
- OCR, texto, campos extraídos, montos o conceptos;
- CUIT/CUIL/DNI completos u otros identificadores fiscales;
- tokens, cookies, secretos MFA, credenciales o configuración secreta.

`admin_audit_events` es append-only y conserva metadata allowlisted sin payload libre. Los comandos rechazados o fallidos después de autenticar registran sólo actor, capacidad, recurso, resultado y motivo validado; nunca el body ni el error. Los errores de parsing previos a la autenticación no se atribuyen a una cuenta. Los errores HTTP no exponen SQL, stack, paths ni detalles de proveedores.

## Diagnóstico OCR

El diagnóstico de OCR se consulta con `processing.read` en `/api/v1/admin/processing/ocr` y se muestra en Procesamiento. Agrega el mes UTC actual: resultados y cobertura por documento, errores, bloqueos, cache, tokens reportados, reportes ausentes, duración y costos de infraestructura. El detalle por cuenta usa sólo UUID internos y se pagina; los tokens y costos viajan como strings exactos. El total presupuestario diario sobrevive a las bajas sin mantener IDs, por lo que puede superar la suma de cuentas todavía existentes. Cada corrida muestra su última operación OCR, sin respuesta externa ni identificador de request. Ver [OCR externo](ocr.md).

La salud del proveedor se infiere de la última respuesta real en 24 horas: éxito `HEALTHY`, fallo `DEGRADED`, ausencia o antigüedad `UNKNOWN`. No acredita configuración viva ni genera llamadas de health. No hay comando para forzar una nueva llamada paga ni saltear cache.

## Operaciones no disponibles

No hay break-glass, impersonación, acceso al original o artefactos, inspección administrativa de resultados salariales, cancelación de jobs `RUNNING`, retry de fallos permanentes, baja administrativa de cuenta, tickets, flags ni settings editables. Reproceso y rollback operan sobre metadata y punteros validados, no conceden acceso al contenido. Queue, storage y OAuth se muestran como `UNKNOWN` cuando no existe una señal segura y comprobable; la UI no inventa telemetría.

Agregar cualquiera de esas operaciones requiere preservar las máquinas de estado, definir la base de autorización, minimizar el DTO y dejar una prueba que cubra permiso, IDOR, concurrencia y auditoría. Ver [ADR 0012](../adr/0012-granular-admin-console.md), [ADR 0014](../adr/0014-global-employer-resolution.md), [ADR 0015](../adr/0015-active-processing-runs-and-safe-recovery.md) y [ADR 0017](../adr/0017-guarded-admin-legal-publication.md).
