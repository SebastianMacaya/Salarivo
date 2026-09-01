# Retención y eliminación

> Estado: política técnica Proposed. Los plazos legales y comerciales exactos deben aprobarse antes de producción.

## Preferencias

### KEEP_ORIGINAL

Conserva el documento cifrado para descarga y reprocesamiento hasta que el usuario lo elimine o cierre la cuenta, sujeto a la política de backups.

### DELETE_AFTER_PROCESSING

Cuando el procesamiento termina —sin revisión o cuando el usuario la completa—, se rechaza como no soportado o falla de forma permanente, bloquea el acceso al original y agenda su borrado durable. El delete físico ocurre después de vencer la autorización de upload y su ventana de gracia. No agenda mientras existe revisión o retry pendiente. Conserva sólo información estructurada permitida, trazabilidad mínima y evidencia no sensible.

### DELETE_AFTER_N_DAYS

Capacidad futura. El número es configuración visible al usuario; no se habilita hasta implementar scheduler, advertencias, reconciliación y tests.

El esquema ya conserva una política por cuenta y la copia al documento, pero el producto actual crea cuentas con `KEEP_ORIGINAL` y todavía no ofrece ruta ni UI para cambiarla. `DELETE_AFTER_PROCESSING` sólo se ejecuta si una operación interna revisada dejó esa política en el documento. Hacer editable la preferencia global o por documento requiere contrato, UX y pruebas; nunca podrá restaurar un original ya borrado.

## Objetos y lifecycle

| Dato | Fuente de verdad | Retención |
| --- | --- | --- |
| upload incompleto | storage + UploadSession | TTL corto configurable |
| original en cuarentena | storage + Document | hasta decisión de seguridad y cleanup |
| original aceptado | storage + `Document.retentionPolicy` | según la política persistida; `KEEP_ORIGINAL` por defecto actual |
| render/thumbnail y archivos de trabajo OCR | filesystem efímero | mínimo técnico y cleanup al finalizar |
| artefacto de texto reutilizable | storage privado cifrado + metadata `ProcessingArtifact` | sólo mientras el original siga disponible; se elimina con el original, documento o cuenta |
| ExtractionRun | PostgreSQL | historial versionado mientras exista el dato estructurado |
| UserCorrection | PostgreSQL | mientras exista el campo corregido o hasta borrado solicitado |
| datos estructurados | PostgreSQL | hasta eliminación del documento/cuenta según elección |
| audit event | PostgreSQL/archivo seguro | plazo aprobado, metadata no sensible |
| aceptación legal | PostgreSQL | mientras exista la cuenta; la versión publicada permanece sin relación personal al borrar la cuenta |
| cuenta de autenticación `(provider, sub)` | PostgreSQL | mientras exista la cuenta; se elimina con ella |
| intento/cookie OIDC | PostgreSQL + navegador | TTL corto, un solo uso; se consume al resolver callback/registro/step-up o expira |
| sesión y cliente coarse | PostgreSQL | mientras exista la cuenta; las activas se muestran owner-only y las revocadas/expiradas permanecen hasta una política de purge aprobada |
| access, refresh e ID tokens Google | no se persisten | sólo memoria durante canje y validación; se descartan en la misma operación |
| contribución de benchmark | no implementada | futura: hasta revocación/borrado; retirar mapping y recomputar agregados afectados |
| export | PostgreSQL + respuesta HTTPS autenticada | autorización breve; JSON generado bajo demanda |
| tombstone de storage | PostgreSQL sin FK | hasta confirmar borrado canónico y temporal; luego se elimina |
| constancia de baja | PostgreSQL sin FK ni PII | estado operativo `PENDING`/`COMPLETED`; plazo definitivo pendiente |
| backup | no implementada | pendiente de proveedor, ventana, cifrado y lista de supresiones |

Uploads vencidos y tombstones se reconcilian fuera del happy path. Producción debe garantizar que ninguna carga iniciada antes del vencimiento termine después de la ventana de gracia o, en su defecto, inventariar y reborrar posteriormente antes de cerrar la baja. Un inventario genérico de objetos huérfanos contra storage sigue pendiente antes de producción.

El artefacto reutilizable contiene texto Restricted derivado del documento. Usa una key opaca, checksum y el mismo boundary privado/cifrado del original; no tiene URL de descarga, no se devuelve en exportaciones técnicas y nunca se incluye en logs, métricas, traces o herramientas externas. La metadata se crea como `writeState=PENDING` antes del `PUT`. Sólo permite omitir extracción/OCR después de marcar el write `COMPLETED` y demostrar compatibilidad. `DELETE_AFTER_PROCESSING` lo elimina junto con el original.

## Eliminar original

1. reautenticar cuando el riesgo lo requiera;
2. autorizar ownership;
3. registrar el tombstone y bloquear nuevas descargas;
4. rechazar la operación mientras un job todavía necesita el binario y comprobar un estado terminal;
5. borrar original, artefactos de texto, renders, thumbnails y archivos OCR temporales;
6. mantener el tombstone hasta repetir el delete y confirmar por `HEAD` la ausencia de todas las keys después del vencimiento del upload;
7. si un timeout dejó un write de artefacto incierto, conservar esa key en el tombstone y bloquear el cierre hasta verificación operativa.
8. conservar o borrar datos estructurados según elección;
9. registrar AuditEvent sin contenido sensible.

La operación es idempotente.

## Eliminar documento y datos

Además del original:

- elimina por cascada settlements, line items, extractions, issues, metadata de artefactos, corrections, upload session y jobs dentro del alcance;
- registra y reconcilia el borrado de las keys de storage;
- conserva sólo lo exigido por una política aprobada y sin payload salarial cuando sea posible.

Cache externas, shares e índices de búsqueda no existen en el MVP. Si se incorporan, deberán entrar en la misma orquestación y sus pruebas antes de habilitarse.

La UI distingue claramente “eliminar original” de “eliminar documento y datos”.

## Eliminar cuenta

La orquestación actual recorre:

- sesiones, cuentas de autenticación e intentos OIDC;
- imports y cola;
- DB y proyecciones;
- object storage;
- temporales;
- exports.

No existen shares, cache externa ni índice de búsqueda en el MVP. Backups y lista de supresiones son un bloqueo P0 separado: deben incorporarse al procedimiento operativo antes de aceptar datos reales.

El navegador genera la constancia opaca antes de solicitar la baja y la muestra cuando el servidor acepta el pedido o la respuesta es ambigua por un error de red/5xx; el servidor guarda sólo su hash y el navegador no la persiste en storage. Si la persona la copia, puede reingresarla en la pantalla pública para consultar `PENDING` o `COMPLETED` aun si se perdió la respuesta o después del cascade. No se afirma borrado total instantáneo si existe retención de backup. Al restaurar un backup deberá reaplicarse una lista de supresión para no resucitar cuentas eliminadas; ese mecanismo aún no está implementado.

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

Un error deja la cuenta en `DELETION_PENDING`, no un falso borrado. Las keys se materializan en tombstones sin cargar el inventario en memoria y el worker los drena en lotes round-robin por usuario. Sólo elimina la fila de usuario después de vencer autorizaciones de upload, confirmar el cleanup de storage y comprobar que ningún job conserva `execution_owner`. El cierre también depende de que el proveedor limite la duración máxima de una carga por debajo de la ventana de gracia o de una reconciliación posterior equivalente. Ese marcador se libera después de limpiar el directorio temporal, incluso si el job ya quedó terminal o reintentable. Un crash puede dejarlo huérfano: la baja permanece bloqueada hasta verificar operativamente que el proceso y su temporal terminaron; alerta y procedimiento de recuperación son pendientes de producción.

## Decisiones pendientes

- valores numéricos de TTL y retención;
- retención legal de auditoría;
- semántica exacta de borrado de ExtractionRun;
- proveedor y lifecycle de backups;
- plazos y comunicación del borrado diferido en producción;
- verificación operativa de la retención de evidencia de aceptación y del mapping de identidad externa antes de producción; la versión legal inicial 1.0 ya fue aprobada para la instancia privada.

Estas decisiones requieren producto, seguridad y asesoramiento legal aplicable; no deben inventarse en código.
