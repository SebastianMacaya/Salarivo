# ADR 0017 — Publicación legal administrativa protegida

- Estado: Accepted
- Fecha: 2026-09-02

## Contexto

Salarivo ya conserva Términos y Avisos de Privacidad versionados, append-only y ligados a constancias exactas. La restricción original del [ADR 0007](0007-versioned-legal-acceptance-and-minimal-admin.md) exigía crear cada versión por migración revisada. Eso preservaba la integridad, pero dejaba la operación legal fuera de la consola y ocultaba historial y adopción que la API ya calculaba.

Publicar un documento inmediatamente y luego el otro tampoco es seguro: la primera vigencia puede activar el gate de reaceptación antes de completar el conjunto. La interfaz no sustituye la revisión profesional ni corrige la brecha conocida de la versión 1.0.

## Decisión

La consola puede consultar el historial completo y el conteo de constancias de cuentas existentes. Sólo `SUPER_ADMIN` recibe la nueva capacidad fija `legal.manage`; el panel administrativo sigue exigiendo MFA y cada publicación exige step-up, motivo y referencia.

Una publicación agrega, en una única transacción, una o ambas versiones para `es-AR`. Cuando incluye Términos y Privacidad, ambas comparten una vigencia de entre un minuto y un año de anticipación. Cada número tiene formato `N.N` y debe ser estrictamente posterior al mayor ya registrado para su tipo; su vigencia no puede retroceder respecto de otra versión del mismo documento. Una corrección previa a la activación usa una versión superior con la misma vigencia, y ese número superior es el desempate canónico. Términos requiere reaceptación; el Aviso registra confirmación. Todo texto debe marcarse expresamente como aprobado para producción, respetar límites cerrados y no contener indicadores obvios de borrador o revisión pendiente.

La API serializa estas publicaciones con un advisory lock, vuelve a validar actor y capacidad dentro de la transacción e inserta tanto las versiones como sus eventos append-only. La auditoría guarda únicamente tipo, versión, vigencia y flags legales; no copia título ni contenido. Las versiones no se editan ni se eliminan y los triggers bloquean `UPDATE`, `DELETE` y `TRUNCATE` como autoridad final.

Las páginas públicas continúan resolviendo la versión vigente o una versión histórica exacta desde PostgreSQL. Sus respuestas son `no-store` y la web falla cerrada si la API no puede entregar el texto; no existe una copia estática que pueda presentarse como vigente. Antes de la activación, sólo `legal.manage` puede recuperar desde el panel el texto exacto ya guardado para verificarlo.

## Alternativas descartadas

- Editar la versión vigente: invalida la evidencia exacta ya aceptada.
- Mantener publicación sólo por migración: agrega fricción sin una protección que no pueda conservarse en la transacción administrativa.
- Incorporar drafts, aprobadores, rollback o un CMS: no existe todavía una necesidad que justifique esos estados y superficies.
- Publicar con vigencia inmediata: puede dejar incompleto el conjunto legal y bloquear al operador entre acciones.

## Consecuencias

- Una corrección sigue requiriendo una versión nueva y deja intactas todas las constancias previas.
- El operador debe obtener el texto aprobado fuera de Salarivo; marcar el checkbox no constituye revisión jurídica.
- La vigencia futura permite coordinar el conjunto y preparar la reaceptación, pero no notifica por sí sola a las cuentas.
- El conteo administrativo refleja constancias de cuentas existentes; disminuye cuando una cuenta se elimina.

## Evidencia

`apps/api/src/admin-routes.ts` implementa la transacción, validación, lock y auditoría; `apps/api/src/admin-rbac.ts` limita la capacidad y la migración `025_legal_document_versions_no_truncate.sql` completa la protección append-only. `apps/web/app/admin-app.tsx` expone historial, adopción y publicación coordinada. `apps/api/test/admin-legal.test.ts` verifica orden de versiones, lote, flags y ausencia de contenido en auditoría; las pruebas RBAC y de base de datos cubren el acceso cerrado y la inmutabilidad.

Esta decisión supersede únicamente la restricción de “publicación sólo por migración” del ADR 0007. El modelo de aceptación exacta, reaceptación y append-only permanece vigente.
