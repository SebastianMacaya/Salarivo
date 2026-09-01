# Retención y eliminación

> Estado operativo (2026-09-01): política técnica `Proposed`. Producción ya opera con múltiples cuentas, pero los plazos legales y comerciales exactos, backups y restore con supresiones todavía no están aprobados ni demostrados; son riesgos P0 activos, no garantías implementadas.

## Preferencias

### KEEP_ORIGINAL

Conserva el documento cifrado para descarga y reprocesamiento hasta que el usuario lo elimine o cierre la cuenta, sujeto a la política de backups.

### DELETE_AFTER_PROCESSING

Cuando el procesamiento termina —sin revisión o cuando el usuario la completa—, bloquea el acceso al original y agenda su borrado durable. Un tipo no soportado fuerza siempre esta política aunque la cuenta use `KEEP_ORIGINAL`; conserva sólo la ficha mínima y el comentario owner-only opcional. El delete físico ocurre después de vencer la autorización de upload y su ventana de gracia. No agenda mientras existe revisión o retry pendiente.

### DELETE_AFTER_N_DAYS

Capacidad futura. El número es configuración visible al usuario; no se habilita hasta implementar scheduler, advertencias, reconciliación y tests.

El esquema conserva una política por cuenta y la copia al documento; el producto actual crea cuentas con `KEEP_ORIGINAL` y todavía no ofrece ruta ni UI para cambiarla. La excepción vigente son los tipos no soportados, que fuerzan `DELETE_AFTER_PROCESSING`. Hacer editable la preferencia global o por documento requiere contrato, UX y pruebas; nunca podrá restaurar un original ya borrado.

## Objetos y lifecycle

| Dato | Fuente de verdad | Retención |
| --- | --- | --- |
| upload incompleto | storage + UploadSession | TTL corto configurable |
| original en cuarentena | storage + Document | hasta decisión de seguridad y cleanup |
| original aceptado | storage + `Document.retentionPolicy` | según la política persistida; `KEEP_ORIGINAL` por defecto actual |
| original no soportado | storage + tombstone | acceso bloqueado al clasificar y borrado después de expiración/gracia |
| feedback de tipo no soportado | PostgreSQL + Document | opcional, owner-only, hasta eliminar documento o cuenta |
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
| serie/observación económica global | PostgreSQL | observaciones append-only mientras la serie sea necesaria para reproducir cálculos; plazo de archivo/purge aún no aprobado |
| job de sincronización económica | PostgreSQL | estado operativo y retries; retención de jobs terminales pendiente de política numérica |
| export | PostgreSQL + respuesta HTTPS autenticada | autorización breve; JSON generado bajo demanda |
| tombstone de storage | PostgreSQL sin FK | hasta confirmar borrado canónico y temporal; luego se elimina |
| constancia de baja | PostgreSQL sin FK ni PII | estado operativo `PENDING`/`COMPLETED`; plazo definitivo pendiente |
| backup | no implementada | pendiente de proveedor, ventana, cifrado y lista de supresiones |

Uploads vencidos y tombstones se reconcilian fuera del happy path. Producción debe garantizar que ninguna carga iniciada antes del vencimiento termine después de la ventana de gracia o, en su defecto, inventariar y reborrar posteriormente antes de cerrar la baja. Un inventario genérico de objetos huérfanos contra storage sigue pendiente en producción.

El artefacto reutilizable contiene texto Restricted derivado del documento. Usa una key opaca, checksum y el mismo boundary privado/cifrado del original; no tiene URL de descarga, no se devuelve en exportaciones técnicas y nunca se incluye en logs, métricas, traces o herramientas externas. La metadata se crea como `writeState=PENDING` antes del `PUT`. Sólo permite omitir extracción/OCR después de marcar el write `COMPLETED` y demostrar compatibilidad. `DELETE_AFTER_PROCESSING` lo elimina junto con el original.

Series, observaciones y jobs económicos son datos globales sin vínculo a una cuenta. Eliminar un original, documento o usuario no los borra. No se persisten equivalentes USD, salarios ajustados ni otra cache materializada por liquidación; esas proyecciones desaparecen al eliminar su fuente salarial.

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

Un duplicado binario exacto owner-scoped se trata como descarte, no como documento fallido durable. Después de limpiar el temporal del worker, el reconciliador materializa/verifica el tombstone, elimina por cascada Document, ImportBatchItem, UploadSession, jobs, corridas y artefactos, y randomiza los fingerprints del lote. El tombstone conserva sólo keys opacas hasta confirmar `DELETE` y `HEAD` ausente; después también desaparece. Sólo sobreviven el conteo agregado del lote y un AuditEvent sin filename, hash, documentId ni import item.

## Eliminar documento y datos

Además del original:

- elimina por cascada settlements, line items, extractions, issues, metadata de artefactos, corrections, upload session y jobs dentro del alcance;
- registra y reconcilia el borrado de las keys de storage;
- conserva sólo lo exigido por una política aprobada y sin payload salarial cuando sea posible.

Cache externas, valuaciones económicas materializadas, shares e índices de búsqueda no existen en el MVP. Si se incorporan, deberán entrar en la misma orquestación y sus pruebas antes de habilitarse.

La UI distingue claramente “eliminar original” de “eliminar documento y datos”.

## Eliminar cuenta

La orquestación actual recorre:

- sesiones, cuentas de autenticación e intentos OIDC;
- imports y cola;
- DB y proyecciones;
- object storage;
- temporales;
- exports.

Las tablas económicas globales quedan fuera de esa cascada porque no contienen datos de la cuenta. La proyección económica privada no necesita purge separado porque no se materializa.

No existen shares, cache externa ni índice de búsqueda en el MVP. Backups y lista de supresiones son un P0 abierto en la operación productiva y deben incorporarse al procedimiento antes de poder afirmar borrado recuperable sin resurrección de datos.

El navegador genera la constancia opaca antes de solicitar la baja y la muestra cuando el servidor acepta el pedido o la respuesta es ambigua por un error de red/5xx; el servidor guarda sólo su hash y el navegador no la persiste en storage. Si la persona la copia, puede reingresarla en la pantalla pública para consultar `PENDING` o `COMPLETED` aun si se perdió la respuesta o después del cascade. No se afirma borrado total instantáneo si existe retención de backup. Al restaurar un backup deberá reaplicarse una lista de supresión para no resucitar cuentas eliminadas; ese mecanismo aún no está implementado.

## Backups

En la operación productiva sigue pendiente decidir, implementar y comunicar:

- frecuencia y ventana;
- cifrado y acceso;
- región;
- prueba de restore;
- plazo máximo de purge;
- lista de supresión tras restore.

Los backups no son un archivo histórico indefinido. No se editan objetos individuales de un backup si ello compromete integridad; la implementación debe garantizar expiración y no restauración lógica.

## Fallos y reconciliación

Un error deja la cuenta en `DELETION_PENDING`, no un falso borrado. Las keys se materializan en tombstones sin cargar el inventario en memoria y el worker los drena en lotes round-robin por usuario. Sólo elimina la fila de usuario después de vencer autorizaciones de upload, confirmar el cleanup de storage y comprobar que ningún job conserva `execution_owner`. El cierre también depende de que el proveedor limite la duración máxima de una carga por debajo de la ventana de gracia o de una reconciliación posterior equivalente. Ese marcador se libera después de limpiar el directorio temporal, incluso si el job ya quedó terminal o reintentable. Un crash puede dejarlo huérfano: la baja permanece bloqueada hasta verificar operativamente que el proceso y su temporal terminaron; alerta y procedimiento de recuperación siguen pendientes en producción.

## Decisiones pendientes

- valores numéricos de TTL y retención, incluidos jobs económicos terminales;
- retención legal de auditoría;
- semántica exacta de borrado de ExtractionRun;
- proveedor y lifecycle de backups;
- plazos y comunicación del borrado diferido en producción;
- verificación operativa en producción de la retención de evidencia de aceptación y del mapping de identidad externa; la versión legal inicial 1.0 no cubre la operación multiusuario actual.

Estas decisiones requieren producto, seguridad y asesoramiento legal aplicable; no deben inventarse en código.
