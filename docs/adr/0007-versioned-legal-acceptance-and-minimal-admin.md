# ADR 0007 — Aceptación legal versionada y administración mínima

- Estado: Accepted
- Fecha: 2026-08-29

## Contexto

Crear una cuenta requiere evidencia de qué Términos se aceptaron y qué Aviso de Privacidad se mostró. La operación local también necesita visibilidad básica sin abrir acceso transversal a recibos, salarios o PII.

## Decisión

Términos y Aviso se publican como versiones inmutables con tipo, locale, vigencia y contenido. El registro exige aceptación de Términos y confirmación de lectura del Aviso; el servidor resuelve las versiones vigentes y persiste usuario, ambos registros, sesión y evento de auditoría en una transacción. El cliente nunca elige IDs ni versiones.

`USER` y `ADMIN` son los únicos roles actuales. Cada request de administración vuelve a leer el rol desde PostgreSQL. El panel inicial es sólo lectura y expone conteos operativos y adopción de versiones legales; excluye personas, emails, documentos, filenames, OCR, importes, conceptos, identificadores fiscales, tokens y URLs. El rol no se puede solicitar durante el registro ni administrar desde la API.

Las nuevas versiones se incorporan por migración revisada. No se agrega todavía publicación desde UI, reaceptación de versiones nuevas, soporte, impersonación ni RBAC por capacidades. MFA quedó fuera de esta decisión y fue incorporado después por el [ADR 0008](0008-session-assurance-and-totp-mfa.md).

## Consecuencias

- La evidencia queda ligada a la versión exacta y se exporta con los datos de la cuenta.
- La eliminación de cuenta borra sus acknowledgements personales; las versiones publicadas permanecen.
- Revocar un rol en DB quita acceso en el siguiente request.
- Promover administradores es una acción explícita de operador, fuera de endpoints públicos.
- La versión inicial 1.0 tiene aprobación operativa del titular sólo para acceso privado individual. Abrir cuentas a terceros requiere texto nuevo, identificación completa y revisión legal. La administración exige MFA según el ADR 0008.

## Evidencia

Las migraciones `004_legal_acceptance_and_admin.sql` y `005_legal_policy_integrity.sql` crean el modelo y su protección. Antes del primer despliegue, `013_google_identity_foundation.sql` consolida las revisiones pre-lanzamiento sólo si la instancia no tiene usuarios ni aceptaciones y deja los textos aprobados como primera versión 1.0; luego restaura el trigger append-only. Las pruebas rechazan registro sin aceptación, con versión obsoleta, documentos no aprobados o escalamiento de rol; la integración acepta la 1.0 aprobada y verifica tipo, versión y timestamp de ambas evidencias; también niega el panel a `USER`, refleja promoción/revocación en la sesión existente y comprueba el shape sanitizado de la respuesta administrativa.
