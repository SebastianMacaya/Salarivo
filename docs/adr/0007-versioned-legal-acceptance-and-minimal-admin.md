# ADR 0007 — Aceptación legal versionada y administración mínima

- Estado: Accepted
- Fecha: 2026-08-29

> La decisión de aceptación legal continúa vigente. La administración mínima fue supersedida el 2026-08-30 por el [ADR 0012](0012-granular-admin-console.md).
> Actualización 2026-09-01: se incorpora reaceptación obligatoria ante versiones vigentes no reconocidas; esta capacidad no publica por sí sola una versión nueva.
> Actualización 2026-09-02: el [ADR 0017](0017-guarded-admin-legal-publication.md) supersede únicamente la restricción de crear versiones nuevas sólo mediante migraciones.

## Contexto

Crear una cuenta requiere evidencia de qué Términos se aceptaron y qué Aviso de Privacidad se mostró. La operación local también necesita visibilidad básica sin abrir acceso transversal a recibos, salarios o PII.

## Decisión

Términos y Aviso se publican como versiones inmutables con tipo, locale, vigencia y contenido. El registro exige aceptación de Términos y confirmación de lectura del Aviso; el servidor resuelve las versiones vigentes y persiste usuario, ambos registros, sesión y evento de auditoría en una transacción. El navegador informa las versiones que mostró, pero el servidor vuelve a resolverlas, valida que sigan vigentes y nunca acepta IDs elegidos por el cliente.

Una sesión que no reconoció ambas versiones vigentes puede consultar su estado y completar MFA, step-up y gestión de sesiones, pero las funciones del producto fallan cerradas con `LEGAL_ACCEPTANCE_REQUIRED`. La persona puede aceptar/confirmar las versiones actuales en una operación idempotente o, sin hacerlo, exportar sus datos y solicitar la eliminación de la cuenta. Esas excepciones usan guards explícitos; no existe un bypass por prefijo de ruta.

`USER` y `ADMIN` son los únicos roles actuales. Cada request de administración vuelve a leer el rol desde PostgreSQL. El panel inicial es sólo lectura y expone conteos operativos y adopción de versiones legales; excluye personas, emails, documentos, filenames, OCR, importes, conceptos, identificadores fiscales, tokens y URLs. El rol no se puede solicitar durante el registro ni administrar desde la API.

La decisión original incorporaba versiones nuevas sólo por migración revisada y excluía publicación desde UI; ese canal fue reemplazado por la publicación protegida del [ADR 0017](0017-guarded-admin-legal-publication.md). Soporte e impersonación continúan fuera de alcance. MFA quedó fuera de esta decisión y fue incorporado después por el [ADR 0008](0008-session-assurance-and-totp-mfa.md); RBAC por capacidades fue incorporado por el [ADR 0012](0012-granular-admin-console.md).

## Consecuencias

- La evidencia queda ligada a la versión exacta y se exporta con los datos de la cuenta.
- Una versión nueva no falsifica ni reemplaza evidencia anterior: cada cuenta debe registrar las dos constancias vigentes antes de volver al producto.
- Rechazar los cambios no condiciona exportación, eliminación, cierre de sesión ni controles necesarios para asegurar la cuenta.
- La eliminación de cuenta borra sus acknowledgements personales; las versiones publicadas permanecen.
- Revocar un rol en DB quita acceso en el siguiente request.
- Promover administradores es una acción explícita de operador, fuera de endpoints públicos.
- La versión inicial 1.0 tiene aprobación operativa del titular sólo para acceso privado individual. Abrir cuentas a terceros requiere texto nuevo, identificación completa y revisión legal. La administración exige MFA según el ADR 0008.

## Evidencia

Las migraciones `004_legal_acceptance_and_admin.sql` y `005_legal_policy_integrity.sql` crean el modelo y su protección. Antes del primer despliegue, `013_google_identity_foundation.sql` consolida las revisiones pre-lanzamiento sólo si la instancia no tiene usuarios ni aceptaciones y deja los textos aprobados como primera versión 1.0; luego restaura el trigger append-only. La API calcula en cada sesión si existen ambas constancias vigentes y la web aplica el gate antes de onboarding y producto. Las pruebas rechazan registro sin aceptación, con versión obsoleta, documentos no aprobados o escalamiento de rol; la integración verifica las constancias exactas, el bloqueo de producto, las excepciones de privacidad y la idempotencia de la reaceptación.
