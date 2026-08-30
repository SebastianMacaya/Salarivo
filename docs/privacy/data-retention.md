# Retención y eliminación

> Estado: política técnica Proposed. Los plazos legales y comerciales exactos deben aprobarse antes de producción.

## Preferencias

### KEEP_ORIGINAL

Conserva el documento cifrado para descarga y reprocesamiento hasta que el usuario lo elimine o cierre la cuenta, sujeto a la política de backups.

### DELETE_AFTER_PROCESSING

Elimina el original y derivados temporales después de completar, revisar o alcanzar una decisión terminal definida. Conserva sólo información estructurada permitida, trazabilidad mínima y evidencia no sensible.

### DELETE_AFTER_N_DAYS

Capacidad futura. El número es configuración visible al usuario; no se habilita hasta implementar scheduler, advertencias, reconciliación y tests.

La preferencia global puede sobrescribirse por documento. Cambiarla hacia menor retención dispara cleanup; nunca restaura un original ya borrado.

## Objetos y lifecycle

| Dato | Fuente de verdad | Retención |
| --- | --- | --- |
| upload incompleto | storage + UploadSession | TTL corto configurable |
| original en cuarentena | storage + Document | hasta decisión de seguridad y cleanup |
| original aceptado | storage + preference | según policy del usuario |
| render/OCR/thumbnail temporal | storage/filesystem efímero | mínimo técnico, TTL y cleanup al finalizar |
| ExtractionRun | PostgreSQL | historial versionado mientras exista el dato estructurado |
| UserCorrection | PostgreSQL | mientras exista el campo corregido o hasta borrado solicitado |
| datos estructurados | PostgreSQL | hasta eliminación del documento/cuenta según elección |
| audit event | PostgreSQL/archivo seguro | plazo aprobado, metadata no sensible |
| aceptación legal | PostgreSQL | mientras exista la cuenta; la versión publicada permanece sin relación personal al borrar la cuenta |
| contribución de benchmark | no implementada | futura: hasta revocación/borrado; retirar mapping y recomputar agregados afectados |
| export | PostgreSQL + respuesta HTTPS autenticada | autorización breve; JSON generado bajo demanda |
| backup | backup cifrado | ventana declarada y purge diferido documentado |

Ningún temporal depende sólo de un happy path para borrarse. Un reconciliador encuentra objetos huérfanos por owner, tipo y expiración.

## Eliminar original

1. reautenticar cuando el riesgo lo requiera;
2. autorizar ownership;
3. impedir nuevas descargas y revocar autorizaciones;
4. cancelar jobs que necesitan el binario;
5. borrar original, renders, thumbnails y OCR temporales;
6. actualizar estado sólo tras confirmación/reconciliación;
7. conservar o borrar datos estructurados según elección;
8. registrar AuditEvent sin contenido sensible.

La operación es idempotente.

## Eliminar documento y datos

Además del original:

- elimina settlements, line items, extractions y corrections dentro del alcance;
- invalida cache, índices, exports y shares relacionados;
- cancela/reconcilia jobs;
- actualiza analytics;
- conserva sólo lo exigido por una política aprobada y sin payload salarial cuando sea posible.

La UI distingue claramente “eliminar original” de “eliminar documento y datos”.

## Eliminar cuenta

Una orquestación durable recorre:

- sesiones y acceso;
- imports y cola;
- DB y proyecciones;
- object storage;
- cache;
- temporales;
- exports y shares;
- índices;
- backups según ventana.

El usuario recibe estado y alcance; no se afirma borrado total instantáneo si existe retención de backup. Al restaurar un backup, se reaplica una lista de supresión para no resucitar cuentas eliminadas.

## Backups

Antes de producción se decide y comunica:

- frecuencia y ventana;
- cifrado y acceso;
- región;
- prueba de restore;
- plazo máximo de purge;
- lista de supresión tras restore.

Los backups no son un archivo histórico indefinido. No se editan objetos individuales de un backup si ello compromete integridad; la implementación debe garantizar expiración y no restauración lógica.

## Fallos y reconciliación

Un error deja la cuenta en `DELETION_PENDING`, no un falso borrado. El worker reintenta la misma operación y sólo elimina la fila de usuario después de vencer autorizaciones de upload y confirmar el cleanup de storage.

## Decisiones pendientes

- valores numéricos de TTL y retención;
- retención legal de auditoría;
- semántica exacta de borrado de ExtractionRun;
- proveedor y lifecycle de backups;
- plazos y comunicación del borrado diferido en producción.
- revisión legal de la retención de evidencia de aceptación antes de producción; el MVP prioriza borrado de cuenta y no conserva una identidad separada.

Estas decisiones requieren producto, seguridad y asesoramiento legal aplicable; no deben inventarse en código.
