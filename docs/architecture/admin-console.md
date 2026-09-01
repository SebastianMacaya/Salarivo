# Consola administrativa

> Estado: operaciones implementadas en código; su uso productivo requiere despliegue y verificación del entorno.

## Límite de autorización

La consola de plataforma usa dos controles server-side: `users.role = 'ADMIN'` habilita el contexto y `users.admin_role` resuelve un conjunto cerrado de capacidades. Estado, rol y garantía MFA se releen desde PostgreSQL en cada request privilegiado; las acciones críticas exigen además step-up vigente.

| Rol | Alcance principal |
| --- | --- |
| `SUPER_ADMIN` | todas las capacidades actuales, administración de roles y revisión de empleadores |
| `OPERATIONS` | diagnóstico de documentos/jobs y recuperación acotada |
| `SUPPORT` | metadata de usuario y contacto excepcional auditado |
| `SECURITY` | estados de cuenta, sesiones, cuarentena y eventos de seguridad |
| `FINANCE` | métricas agregadas de storage y límites visibles |
| `READ_ONLY` | vistas operativas no sensibles sin comandos |

La asignación exacta vive en `apps/api/src/admin-rbac.ts`; esta tabla sólo resume intención. Un valor desconocido falla cerrado. `/admin` filtra navegación por capacidad, pero la API repite siempre la autorización.

## Superficie actual

Las rutas `/api/v1/admin` cubren dashboard, usuarios, metadata de documentos y empleadores, jobs, salud/versiones/issues del pipeline, storage, operaciones de privacidad, seguridad, auditoría, configuración sanitizada y health. Listas y búsqueda usan filtros allowlisted, paginación server-side e índices; no cargan datasets completos en el navegador.

Los comandos actuales se limitan a estado de cuenta, revocación de sesiones, cambio de rol, cuarentena sin ejecución activa, retry de un job `RETRYABLE` en la misma versión, cancelación de jobs que aún no ejecutan, reproceso de candidatos, rollback a una corrida previamente activa y revisión de empleadores. `processing.reprocess` y `processing.rollback` están separados de lectura/retry/cancelación. Motivo y referencia son tipados; la mutación y su `admin_audit_events` se confirman en una transacción.

`employers.manage` pertenece sólo a `SUPER_ADMIN` y permite aprobar, rechazar, renombrar, agregar aliases, agregar/corregir CUIT y fusionar. Cada operación exige step-up y auditoría atómica. El CUIT se valida server-side, se cifra con AES-256-GCM y se busca mediante HMAC-SHA-256 con otra clave; la consola sólo recibe el sufijo enmascarado. El merge conserva el origen como `MERGED`, sigue el destino canónico, bloquea identificadores incompatibles o legacy no comparables y resuelve antes cualquier Employment exactamente redundante sin abrir documentos ni modificar montos.

Un administrador debe ser deprovisionado por otra persona autorizada antes de usar la baja personal. El flujo de privacidad rechaza cuentas que todavía conservan `role = 'ADMIN'`, por lo que tampoco puede retirar indirectamente al último `SUPER_ADMIN`.

## DTO y privacidad

Los DTO administrativos se consultan directamente para su propósito y no reutilizan un endpoint owner-only con bypass. Por defecto contienen metadata operativa: UUID internos, estados, timestamps, conteos, tamaños, versiones, outcomes y códigos sanitizados. La salud de procesamiento agrega conteos y distribuciones por status, versión e issue; nunca valores ni texto. El detalle de Employer agrega nombre normalizado y hasta 20 orígenes de detección ordenados: UUID de documento y lote, nombre interpretado o corregido, fuente, confianza y fecha. No incluye owner, filename, región, señales, texto OCR ni montos. El contacto completo está separado, requiere permiso, step-up y auditoría.

Nunca se serializan a la consola:

- PDF, filename original, object key, checksum o URL firmada;
- OCR, texto, campos extraídos, montos o conceptos;
- CUIT/CUIL/DNI completos u otros identificadores fiscales;
- tokens, cookies, secretos MFA, credenciales o configuración secreta.

`admin_audit_events` es append-only y conserva metadata allowlisted sin payload libre. Los comandos rechazados o fallidos registran sólo actor, capacidad, recurso, resultado y motivo validado; nunca el body ni el error. Los errores HTTP no exponen SQL, stack, paths ni detalles de proveedores.

## Operaciones no disponibles

No hay break-glass, impersonación, acceso al original o artefactos, inspección administrativa de resultados salariales, cancelación de jobs `RUNNING`, retry de fallos permanentes, baja administrativa de cuenta, tickets, flags ni settings editables. Reproceso y rollback operan sobre metadata y punteros validados, no conceden acceso al contenido. Queue, storage, OCR y OAuth se muestran como `UNKNOWN` cuando no existe una señal segura y comprobable; la UI no inventa telemetría.

Agregar cualquiera de esas operaciones requiere preservar las máquinas de estado, definir la base de autorización, minimizar el DTO y dejar una prueba que cubra permiso, IDOR, concurrencia y auditoría. Ver [ADR 0012](../adr/0012-granular-admin-console.md), [ADR 0014](../adr/0014-global-employer-resolution.md) y [ADR 0015](../adr/0015-active-processing-runs-and-safe-recovery.md).
