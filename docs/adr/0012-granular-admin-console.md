# ADR 0012 — Consola administrativa granular y privada por defecto

- Estado: Accepted
- Fecha: 2026-08-30
- Supersede parcialmente: [ADR 0007](0007-versioned-legal-acceptance-and-minimal-admin.md), sólo en su decisión de administración mínima

## Contexto

Los conteos agregados del panel inicial no alcanzan para diagnosticar usuarios, documentos, storage y procesamiento ni para ejecutar recuperaciones operativas seguras. Ampliar ese acceso con un único booleano `isAdmin`, reutilizar rutas del titular o entregar objetos completos al navegador convertiría la consola en un bypass transversal de ownership sobre datos laborales y financieros.

La operación necesita separación de funciones, autorización server-side, acceso mínimo, paginación y una evidencia durable de las acciones privilegiadas. No necesita acceso general a PDFs, OCR, salarios ni identificadores fiscales.

## Decisión

### Acceso y capacidades

`users.role` conserva el límite grueso `USER`/`ADMIN`. Todo `ADMIN` tiene además exactamente un `admin_role`: `SUPER_ADMIN`, `OPERATIONS`, `SUPPORT`, `SECURITY`, `FINANCE` o `READ_ONLY`. Los administradores existentes migran a `READ_ONLY`; el primer `SUPER_ADMIN` se provisiona fuera de la API pública sobre una cuenta activa que ya tenga MFA.

Las capacidades son un vocabulario cerrado en código y su asignación a roles también es estática y revisable:

- `dashboard.read`;
- `users.read_metadata`, `users.read_contact`, `users.status.update`;
- `sessions.revoke`;
- `documents.read_metadata`, `documents.quarantine`;
- `employers.read_metadata`;
- `processing.read`, `processing.retry`, `processing.cancel`;
- `storage.read`, `privacy.read`, `security.read`, `audit.read`;
- `settings.read`, `system.health.read`;
- `roles.manage`.

Un rol o capacidad desconocidos no conceden acceso. Cada request administrativo vuelve a leer en PostgreSQL estado, rol, `admin_role` y garantía de la sesión; requiere MFA verificado y valida la capacidad concreta. Ocultar una opción en la web es sólo UX, nunca autorización.

La consola interna vive bajo `/admin` y la API bajo `/api/v1/admin`. Un futuro contexto empresarial o de RRHH usará otro límite de autorización y no heredará capacidades de plataforma.

### Límite de datos

Las consultas administrativas son rutas y DTO propios: no reutilizan rutas del titular con una excepción de ownership. Devuelven únicamente IDs internos, estados, timestamps, conteos, tamaños, versiones y códigos de error sanitizados necesarios para la operación. Las listas enmascaran el contacto; leer el email completo exige `users.read_contact`, step-up vigente, motivo tipado, referencia operativa y auditoría atómica.

La consola no devuelve PDFs, URLs firmadas, filenames originales, object keys, checksums, OCR, campos extraídos, salarios, conceptos, identificadores fiscales completos, tokens, secretos MFA ni payloads de proveedores. Conocer un UUID no autoriza una capacidad ni habilita contenido privado.

Las listas se filtran, ordenan y paginan en servidor con columnas allowlisted, tamaño máximo acotado e índices para sus recorridos principales. Configuración y health son vistas sanitizadas de sólo lectura; no exponen secretos ni errores internos.

### Comandos operativos

El corte actual permite sólo comandos que respetan las máquinas de estado existentes:

- cambiar estado de una cuenta y revocar sus sesiones;
- cambiar `admin_role`, revocando sesiones del destinatario;
- poner en cuarentena un documento que no tenga una ejecución activa;
- adelantar un job `RETRYABLE` sin cambiar su `processing_version` y sólo si no conserva `execution_owner`;
- cancelar jobs `PENDING`, `PUBLISHED` o `RETRYABLE`, nunca `RUNNING`.

Los cambios críticos usan transacción y lock de las filas relevantes, exigen step-up, motivo de un enum cerrado y una referencia sin texto libre. No se permite cambiar el propio rol o estado, quitar el último `SUPER_ADMIN` activo ni promover una cuenta sin MFA. Las precondiciones y el evento administrativo se confirman en la misma transacción.

Una cuenta con `role = 'ADMIN'` tampoco puede iniciar su baja desde el flujo personal: otra persona con `roles.manage` debe retirar primero su acceso administrativo. Esto evita que el lifecycle de privacidad eluda la protección del último `SUPER_ADMIN`; una vez deprovisionada, la persona conserva el mismo derecho de baja que cualquier usuario.

Cada evento privilegiado persiste actor, `admin_role`, capacidad, acción, recurso, resultado, motivo, referencia y metadata sanitizada en `admin_audit_events`. La tabla es append-only y no depende de una FK que pueda borrar la evidencia junto con la cuenta. Su plazo definitivo de retención sigue pendiente de la política aplicable.

### Exclusiones deliberadas

No se implementan reproceso con una versión nueva, retry de fallos permanentes, cancelación de ejecuciones activas, baja o reversión de baja iniciada por un administrador, merge global de empleadores, soporte/tickets, feature flags, configuración dinámica, búsqueda por CUIT, estado vivo de workers ni acceso excepcional a documentos. En particular, no existe `break glass`: esa necesidad requiere otra decisión, doble control y consentimiento/base legal antes de ampliar la superficie Restricted.

El reproceso permanece fuera mientras el [ADR 0004](0004-versioned-extraction.md) sea Proposed y no exista una regla probada que preserve correcciones humanas entre corridas. La baja de cuenta conserva su orquestación del titular definida por el [ADR 0009](0009-durable-deletion-and-privacy-receipts.md).

## Alternativas consideradas

- **Un único `ADMIN` con todos los permisos:** rechazado por falta de separación de funciones y blast radius excesivo.
- **Permisos y roles editables en tablas:** pospuesto; el vocabulario fijo resuelve el corte actual con menos estados inválidos y una revisión de código explícita.
- **Reutilizar endpoints owner-only con bypass:** rechazado porque vuelve implícito el acceso transversal y facilita IDOR.
- **Acceso general a contenido para soporte:** rechazado; administrar metadata no justifica abrir datos Restricted.
- **Microservicio administrativo:** rechazado; el monolito modular actual ya ofrece el límite necesario.

## Consecuencias

- Una promoción ya no basta con `role = 'ADMIN'`: requiere `admin_role` coherente y MFA activo.
- Agregar una capacidad o ampliar un DTO es un cambio de seguridad y privacidad que exige código, tests y documentación revisados juntos.
- `READ_ONLY` es el fallback de menor privilegio para administradores preexistentes; no hay permisos implícitos.
- La auditoría administrativa sobrevive a cascades, pero su archivo externo, retención y revisión operativa siguen pendientes antes de producción.
- La consola mejora diagnóstico y recuperación sin modificar ownership ni habilitar datos reales o un despliegue público.

## Evidencia

- Migración `015_granular_admin_console.sql`: `admin_role`, coherencia con `role`, índices y auditoría append-only.
- `apps/api/src/admin-rbac.ts`: vocabulario cerrado, asignación explícita y deny-by-default.
- Rutas `/api/v1/admin`: DTO administrativos, paginación, guards, step-up y comandos transaccionales.
- Tests unitarios de RBAC, migraciones e integración administrativa; el frontend `/admin` consume únicamente esos contratos.
