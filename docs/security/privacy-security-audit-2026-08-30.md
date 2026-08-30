# Auditoría de privacidad y seguridad — 2026-08-30

## Veredicto

El corte local cerró los gaps técnicos inmediatos de MFA, step-up, exportación, minimización y borrado durable. Salarivo todavía es **NO-GO para un servicio público con datos reales** y no debe afirmar “cumple Ley 25.326”: faltan decisiones legales, contratos e infraestructura de producción verificable.

## Alcance y referencia

Se revisó el flujo real de Salarivo y se comparó con las garantías reutilizables de CheNodo: sesión exacta, niveles de garantía, TOTP cifrado, recovery codes, rotación/revocación y baja idempotente. Se corrigieron MFA opcional para privilegios, CSP parcial y borrado relacional incompleto. La supresión posterior a un restore de backup sigue siendo un bloqueo explícito, no una garantía implementada.

La evaluación jurídica es técnica e informativa. Fuentes oficiales consultadas:

- [Ley 25.326 actualizada](https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion), en especial calidad/finalidad, información, datos sensibles, seguridad, acceso, rectificación/supresión y tratamiento por encargo;
- [Derechos de datos personales — AAIP](https://www.argentina.gob.ar/aaip/datospersonales/derechos), incluidos acceso en 10 días corridos y rectificación, actualización o supresión en 5 días hábiles;
- [Trámites de datos personales — AAIP](https://www.argentina.gob.ar/aaip/datospersonales/tramites), para la inscripción de bases;
- [Transferencias internacionales — AAIP](https://www.argentina.gob.ar/aaip/datospersonales/transferencias-internacionales).

## Controles demostrados en este corte

- MFA TOTP con secreto AES-GCM y keyring versionado, anti-replay, lock temporal y recovery codes hasheados.
- MFA obligatorio para `ADMIN`; step-up de diez minutos para exportar, descargar originales y borrar empleador, empleo, original, documento o cuenta.
- Rotación del token de la sesión exacta y revocación de las otras sesiones en cambios de MFA.
- Respuestas autenticadas `Cache-Control: no-store`, ownership server-side y URL de descarga firmada por 120 segundos.
- Export JSON v2 completo, paginado y bajo snapshot, con timeout de stream de diez minutos y máximo local de dos streams; sin PDF, credenciales, secretos, keys de storage ni payload salarial en logs.
- Borrado durable de keys `incoming/` y canónica mediante tombstones; baja de cuenta con constancia opaca consultable después del cascade.
- Baja masiva sin inventario en memoria: tombstones materializados en SQL y reconciliados en lotes round-robin por usuario.
- Aplicación efectiva de `DELETE_AFTER_PROCESSING` en decisiones terminales.
- Minimización de todas las deducciones individuales: sólo se conserva etiqueta genérica e importe. Un constraint impide persistir descripción, código, recurrencia o campo de origen.
- Configuración productiva fail-fast para TLS de PostgreSQL, endpoints HTTPS, clave MFA y bucket privado, KMS y nunca versionado; las operaciones de storage tienen timeout.
- CSP con origen explícito de upload, anti-framing, HSTS, `nosniff`, política de permisos y referrer mínimo en la web.

## Evidencia ejecutable

- Migraciones 001–012 aplicadas sobre PostgreSQL local.
- Unit tests de API, MFA, worker y migraciones.
- Integración HTTP con dos usuarios: IDOR, MFA, step-up, export, rectificación materializada, descarga y borrados.
- Worker real contra PostgreSQL, Redis y MinIO locales con fixtures sintéticos: un replay de upload firmado y una ejecución activa mantienen cada baja `PENDING`; al vencer el upload o liberar el marcador de ejecución se eliminan keys, usuarios y relaciones, y cada recibo sobrevive como `COMPLETED` sin cruzar cuentas. Otra prueba demuestra que B progresa en el mismo ciclo aunque A tenga 101 tombstones anteriores.
- Una descarga de export iniciada se aborta si se revoca su sesión antes de completar las páginas, y la operación vuelve a un estado reintentable.

## Bloqueos P0 antes de datos reales o acceso público

1. **Responsable y derechos.** La versión 1.1 está cerrada y aprobada por el titular sólo para acceso privado individual. Antes de habilitar terceros debe aprobarse con abogado identidad, domicilio, canal y procedimiento con constancia/SLA, e inscribir las bases que correspondan en el RNBDP; la aprobación operativa actual no equivale a cumplimiento jurídico general.
2. **Base legal y datos sensibles incidentales.** Resolver si el PDF original puede conservar datos de salud o afiliación sindical, qué finalidad/base corresponde y cómo responder ante hallazgos no necesarios. La minimización implementada reduce la extracción, no cambia el contenido del PDF.
3. **Proveedores y transferencias.** Inventariar hosting, DB, storage, backups, correo, OCR, observabilidad y subencargados; fijar países, DPA, no-training/no-retention y mecanismo válido de transferencia.
4. **Infraestructura.** Elegir proveedor/región y demostrar bucket privado que nunca haya tenido versioning, KMS, TLS, secretos mínimos separados, egress restringido y aislamiento real del parser sin credenciales ni red. También debe demostrarse que una carga iniciada antes del vencimiento no puede finalizar después de la ventana de gracia; si el proveedor no lo garantiza, se requiere inventario y reborrado posterior antes de marcar la baja como `COMPLETED`. API y worker verifican las primeras condiciones al arrancar, pero falta la evidencia del entorno elegido.
5. **Backups.** Definir ventana, cifrado, acceso, restore drill, expiración y ledger de supresiones reaplicado antes de reabrir tráfico.
6. **Recuperación y operación.** Implementar entrega productiva del reset de contraseña, alta/revocación segura de administradores, alertas y procedimiento de incidentes.

## Mejoras P1

- Forzar reaceptación cuando una nueva versión legal material lo requiera.
- Agregar workflow interno para solicitudes de acceso/rectificación/supresión y comunicación a cesionarios; el autoservicio no reemplaza esa operación.
- Usar rate limit compartido y validar `trustProxy` antes de ejecutar múltiples réplicas; el límite actual es por proceso.
- Auditar de forma durable intentos MFA denegados/bloqueados, con alertas sanitizadas.
- Alertar ante `execution_owner` huérfanos y aprobar un procedimiento seguro que verifique que el proceso y su temporal terminaron antes de liberar el marcador; mientras tanto la baja falla cerrada en `PENDING`.
- Evitar que el navegador materialice el export completo en un `Blob` cuando el volumen real justifique descarga directa.
- Reemplazar `unsafe-inline` por nonce/hash cuando el runtime de frontend lo permita.
- Añadir SAST, secret scan e image scan bloqueantes a CI y probar restauración + reaplicación de supresiones.
- Evaluar passkeys y exigir MFA a todas las cuentas sólo después de resolver recuperación sin abrir un bypass débil.

## Criterio de salida

Un frontend desplegado o una suite verde no elimina estos bloqueos. El GO público requiere evidencia conjunta de código, configuración efectiva, contratos, textos aprobados, registro, operación de derechos, backup/restore y pruebas del entorno productivo.
