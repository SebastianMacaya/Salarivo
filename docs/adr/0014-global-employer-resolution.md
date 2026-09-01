# ADR 0014 — Empleador global, resolución conservadora y merge auditable

- Estado: Accepted
- Fecha: 2026-08-31
- Supersede parcialmente: [ADR 0012](0012-granular-admin-console.md), sólo en la exclusión de administración y merge de empleadores

## Contexto

`Employer` nació ligado a `user_id`. Ese diseño permite que dos altas del mismo usuario, dos usuarios o un recibo todavía no asociado creen representaciones distintas de la misma organización. En analytics, un `Employment` confirmado y una detección por nombre se muestran como contextos distintos aunque describan la misma relación laboral.

Un `Employer` identifica una organización; la relación privada de una persona con ella vive en `Employment`. Resolver identidad por similitud de texto o fusionar filas existentes sólo porque normalizan igual puede mezclar homónimos y mover historia salarial a la organización incorrecta.

## Decisión

### Identidad y estados

`Employer` es una entidad global con UUID interno, nombre visible, nombre normalizado, país y estado `PENDING`, `VERIFIED`, `MERGED` o `REJECTED`. `created_by_user_id` conserva procedencia mínima y no concede ownership. Un empleador `MERGED` referencia al canónico y no vuelve a usarse como destino.

Los nombres alternativos viven en `EmployerAlias`. Los identificadores fiscales se modelan por país y tipo, cifrados y versionados, con una huella HMAC-SHA-256 derivada mediante una clave separada para coincidencia exacta y un valor enmascarado para operación. Nunca se guardan ni registran en claro y la base admite como máximo uno por Employer, país y tipo. El primer adapter habilitado es AR/CUIT: normaliza formatos razonables, valida el dígito verificador y cifra con AES-256-GCM antes de persistir. Las claves de cifrado, fingerprint y MFA son dedicadas y distintas; producción falla al iniciar si falta alguna.

La escritura de CUIT se habilita sólo en la consola administrativa. El worker todavía no extrae CUIT del OCR; incorporarlo exige una señal documental confiable y reutilizar este mismo protector, sin persistir ni registrar el valor crudo.

`Employment` sigue siendo owner-scoped. Documentos y liquidaciones conservan `user_id` como autoridad primaria; cuando tienen `employment_id`, el servidor valida además que pertenezca al mismo usuario. Analytics y operaciones de privacidad mantienen ese mismo boundary. Conocer un `employer_id` global no concede acceso a ninguna persona ni a su historia.

### Resolución

Toda creación de un empleo y toda detección del worker pasan por un único resolver transaccional e idempotente. Bajo un advisory lock derivado de país y nombre normalizado, aplica este orden:

1. redirigir un UUID conocido que haya sido fusionado;
2. coincidencia exacta de huella fiscal válida;
3. coincidencia única de nombre canónico o alias dentro del país, recuperada por nombre normalizado pero confirmada con una comparación conservadora que preserva la puntuación;
4. crear un `Employer` `PENDING` cuando no existe una coincidencia inequívoca.

La normalización Unicode, espacios y puntuación sólo produce candidatos; no se eliminan sufijos societarios. No existe fuzzy merge automático ni una restricción global por nombre normalizado: dos organizaciones homónimas son válidas. Una ambigüedad queda pendiente para revisión.

Una asociación owner-scoped ya existente puede aportar un `preferredEmployerId`: sólo desambigua cuando, después de seguir merges, ese Employer canónico integra los candidatos exactos de nombre o alias. Nunca elige un Employer ajeno a esos candidatos, no reemplaza la precedencia del identificador fiscal y no autoriza un merge por nombre.

La migración conserva cada empleador previo como una fila global `PENDING`; no fusiona por nombre. De este modo cambia el modelo sin reatribuir historia existente.

### Asociación de recibos

El documento conserva por separado el empleador detectado y el `employment_id` confirmado. El worker puede autoasociar sólo si hay exactamente un `Employment` propio, del empleador resuelto, con la misma moneda y cuyo rango de fechas cubre el período salarial. Cero o más de una coincidencia deja el recibo sin asociar y visible como detección; no se elige por orden, antigüedad ni similitud.

Un reproceso automático nunca elimina un `employment_id` existente porque el modelo vigente no distingue todavía asociación automática de confirmación humana. Si la nueva detección apunta a otro Employer, conserva las tres referencias laborales, actualiza la detección y fuerza `NEEDS_REVIEW` con auditoría mínima.

La asociación manual y la reparación de datos actualizan en una transacción `ImportBatchItem`, `Document` y `PayrollSettlement` cuando corresponda. Una restricción de base impide duplicar una relación laboral exactamente igual, sin impedir períodos o roles distintos con el mismo empleador.

### Administración

`employers.manage` pertenece sólo a `SUPER_ADMIN` y exige MFA, step-up vigente, motivo tipado y referencia operativa. Aprobar, rechazar, renombrar, agregar un alias, agregar/corregir un CUIT o fusionar empleadores persiste el cambio y su `AdminAuditEvent` en la misma transacción. La respuesta de CUIT contiene sólo tipo, país y sufijo enmascarado; logs y auditoría reciben únicamente metadata allowlisted.

Un merge bloquea origen y destino, sigue la cadena canónica, mueve referencias y conserva el origen como `MERGED`. Identificadores iguales se deduplican; valores diferentes del mismo país/tipo o un identificador legacy sin fingerprint bloquean la operación para revisión. Si produce dos `Employment` exactamente equivalentes del mismo usuario, primero mueve items, documentos y liquidaciones al destino y recién entonces elimina la relación redundante. No toca montos, OCR ni originales.

Los DTO administrativos exponen sólo UUID, estados, país, nombres, aliases, procedencia mínima y conteos. Nunca serializan identificadores completos, documentos, OCR, salarios ni conceptos.

## Alternativas consideradas

- **Mantener Employer por usuario y disimular etiquetas duplicadas:** rechazado porque preserva la causa y diverge entre cada flujo de alta.
- **`UNIQUE(country, normalized_name)`:** rechazado porque nombres iguales no prueban identidad y bloquearían homónimos reales.
- **Merge automático por fuzzy matching:** rechazado por riesgo de corrupción silenciosa de historia privada.
- **Compartir Employment entre usuarios:** rechazado porque mezcla la organización global con la relación laboral owner-scoped.
- **Reutilizar la clave MFA para identificadores:** rechazado por falta de separación criptográfica y por ampliar el impacto de una rotación o incidente.

## Consecuencias

- El nombre deja de ser autoridad y pasa a ser una señal de resolución.
- Un recibo inequívoco deja de crear un contexto duplicado; un caso ambiguo permanece visible y requiere decisión humana.
- El merge es recuperable por evidencia porque la fila origen y la auditoría permanecen.
- Nuevos países o tipos requieren su propio validador; sólo AR/CUIT está habilitado.
- Cambiar reglas de normalización o asociación exige fixtures sintéticos, pruebas de concurrencia, aislamiento entre usuarios y ambigüedad.
- La migración 019 no es compatible con un rolling deploy junto a procesos antiguos: producción requiere comprobar que no haya jobs `RUNNING`, detener temporalmente API y worker, respaldar, iniciar la API nueva para migrar y recién después converger API, worker y web al mismo commit.

## Evidencia

- Migración `019_global_employers.sql` y restricciones de PostgreSQL.
- Resolver compartido de `@salarivo/database`, usado por API y worker.
- Rutas owner-only de empleos y rutas administrativas de empleadores.
- Tests de migración histórica y rollback de preflight, resolución conservadora/concurrente, ownership, protección CUIT, conflicto y merge administrativo.
