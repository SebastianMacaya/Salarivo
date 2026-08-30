# Consola administrativa

> Estado: corte local implementado. No habilita un backend público ni el uso de datos reales.

## Límite de autorización

La consola de plataforma usa dos controles server-side: `users.role = 'ADMIN'` habilita el contexto y `users.admin_role` resuelve un conjunto cerrado de capacidades. Estado, rol y garantía MFA se releen desde PostgreSQL en cada request privilegiado; las acciones críticas exigen además step-up vigente.

| Rol | Alcance principal |
| --- | --- |
| `SUPER_ADMIN` | todas las capacidades actuales y administración de roles |
| `OPERATIONS` | diagnóstico de documentos/jobs y recuperación acotada |
| `SUPPORT` | metadata de usuario y contacto excepcional auditado |
| `SECURITY` | estados de cuenta, sesiones, cuarentena y eventos de seguridad |
| `FINANCE` | métricas agregadas de storage y límites visibles |
| `READ_ONLY` | vistas operativas no sensibles sin comandos |

La asignación exacta vive en `apps/api/src/admin-rbac.ts`; esta tabla sólo resume intención. Un valor desconocido falla cerrado. `/admin` filtra navegación por capacidad, pero la API repite siempre la autorización.

## Superficie actual

Las rutas `/api/v1/admin` cubren dashboard, usuarios, metadata de documentos y empleadores, jobs, storage, operaciones de privacidad, seguridad, auditoría, configuración sanitizada y health. Listas y búsqueda usan filtros allowlisted, paginación server-side e índices; no cargan datasets completos en el navegador.

Los comandos actuales se limitan a estado de cuenta, revocación de sesiones, cambio de rol, cuarentena sin ejecución activa, retry de un job `RETRYABLE` en la misma versión y cancelación de jobs que aún no ejecutan. Motivo y referencia son tipados; la mutación y su `admin_audit_events` se confirman en una transacción.

Un administrador debe ser deprovisionado por otra persona autorizada antes de usar la baja personal. El flujo de privacidad rechaza cuentas que todavía conservan `role = 'ADMIN'`, por lo que tampoco puede retirar indirectamente al último `SUPER_ADMIN`.

## DTO y privacidad

Los DTO administrativos se consultan directamente para su propósito y no reutilizan un endpoint owner-only con bypass. Por defecto contienen metadata operativa: UUID internos, estados, timestamps, conteos, tamaños, versiones y códigos sanitizados. El contacto completo está separado, requiere permiso, step-up y auditoría.

Nunca se serializan a la consola:

- PDF, filename original, object key, checksum o URL firmada;
- OCR, texto, campos extraídos, montos o conceptos;
- CUIT/CUIL/DNI completos u otros identificadores fiscales;
- tokens, cookies, secretos MFA, credenciales o configuración secreta.

`admin_audit_events` es append-only y conserva metadata allowlisted sin payload libre. Los comandos rechazados o fallidos registran sólo actor, capacidad, recurso, resultado y motivo validado; nunca el body ni el error. Los errores HTTP no exponen SQL, stack, paths ni detalles de proveedores.

## Operaciones no disponibles

No hay break-glass, impersonación, acceso al original, reproceso completo, cancelación de jobs `RUNNING`, retry de fallos permanentes, baja administrativa de cuenta, merge de empleadores, tickets, flags ni settings editables. Queue, storage, OCR y OAuth se muestran como `UNKNOWN` cuando no existe una señal segura y comprobable; la UI no inventa telemetría.

Agregar cualquiera de esas operaciones requiere preservar las máquinas de estado, definir la base de autorización, minimizar el DTO y dejar una prueba que cubra permiso, IDOR, concurrencia y auditoría. Ver [ADR 0012](../adr/0012-granular-admin-console.md).
