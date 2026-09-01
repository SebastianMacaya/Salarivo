# Seguridad de upload

> Estado: protocolo implementado para el MVP local y adaptado a Cloudflare R2. Producción requiere verificar la configuración efectiva, backups, observabilidad y los P0 restantes.

## Política

Cada archivo es hostil hasta terminar validación. Extensión, nombre, Content-Type del navegador y metadata PDF son señales no confiables.

Allowlist inicial:

- extensión .pdf como precondición de UX;
- firma real PDF y parser estructural válido como controles server-side;
- documento salarial soportado tras clasificación.

ZIP, RAR, ejecutables, Office con macros, HTML, SVG, scripts, imágenes y documentos arbitrarios se rechazan en MVP. Renombrar un archivo no cambia su tipo.

## Protocolo

1. El usuario solicita una UploadSession autenticada.
2. La API verifica cuota y crea ImportBatchItem, internal key opaca y restricciones.
3. La API entrega autorización de upload breve para un único método/key/tamaño.
4. El navegador sube directo a un prefijo/bucket de cuarentena privado.
5. El navegador confirma el item.
6. La API consulta storage y verifica owner lógico, key, tamaño y estado.
7. En una transacción marca UPLOADED y crea ProcessingJob pendiente.
8. Un dispatcher publica el job en Redis y reconcilia pendientes tras fallos.
9. El worker valida seguridad antes de copiar o promover el objeto.

Nunca se usa originalFilename como key. Nunca se acepta una key enviada libremente por el cliente.

## Validación ordenada

1. sesión, owner, expiración y cuota;
2. tamaño real;
3. extensión permitida como señal;
4. MIME detectado;
5. magic bytes;
6. parse estructural con límites;
7. cifrado/password y page count;
8. malware;
9. objetos activos, adjuntos y acciones;
10. clasificación salarial barata;
11. extracción/OCR sólo si fue aceptado.

El orden elimina barato antes de ejecutar componentes caros o complejos.

## Budgets

Configuración validada:

- MAX_FILE_BYTES;
- MAX_FILES_PER_BATCH;
- MAX_BATCH_BYTES;
- MAX_USER_DOCUMENTS;
- MAX_USER_STORAGE_BYTES;
- MAX_ACTIVE_IMPORTS_PER_USER;
- MAX_PAGES;
- MAX_PARSE_TIME_MS;
- MAX_OCR_TIME_MS;
- MAX_RENDER_PIXELS;

Ausencia o valor inválido debe impedir el arranque en producción. El worker termina de forma segura cuando supera un budget y registra un código sanitizado.

En R2, la API suma uso y reservas persistidas bajo un advisory lock antes de crear la sesión. Después de crear el marcador externo, bloquea la fila, persiste su ETag y vuelve a contar antes de firmar. Rechaza la autorización si alcanzaría el tope global fijo de `8.000.000.000` bytes, además de las cuotas por usuario y batch; el límite no es una variable productiva que pueda omitirse o ampliarse por error. Un fallo del marcador o de la firma no devuelve una URL y conserva la reserva para fallar cerrado.

El límite de memoria es hoy el `mem_limit` global del contenedor y los intentos máximos pertenecen al job persistido. Un límite de memoria por job requiere el sandbox productivo pendiente.

## Aislamiento del parser

Objetivo productivo para el proceso que inspecciona/renderiza:

- no es root;
- usa filesystem temporal por job;
- sólo puede leer el objeto del job;
- no recibe credenciales de DB, storage global ni aplicación;
- no tiene red salvo un destino explícitamente requerido;
- tiene límites de CPU, RAM, output y tiempo;
- borra temporales al finalizar o por reconciliación.

Nunca se abre el PDF en un navegador privilegiado del backend ni se ejecuta contenido activo.

El corte local ejecuta herramientas como usuario no-root dentro del mismo contenedor del worker, con entorno mínimo, directorio temporal por job y límites de tiempo y output; Compose agrega filesystem read-only y memoria global. Todavía comparte UID y red del worker, no impone CPU/RAM por job y no tiene reconciliador de filesystem. Si el cleanup del temporal falla, `execution_owner` queda bloqueado en vez de afirmar una baja completa. Egress restringido y sandbox por job son P0 antes de datos reales.

## Malware

El scanner inicial es local/privado; no se envían recibos a servicios públicos de análisis. Resultados:

- CLEAN: puede continuar;
- INFECTED: QUARANTINED, alerta y sin OCR;
- ERROR/TIMEOUT: FAILED_RETRYABLE o fail closed según agotamiento;
- UNAVAILABLE: no se omite el gate.

Una confirmación del usuario no convierte INFECTED en aceptado.

## Clasificación y override

La clasificación combina señales y confidence. Un archivo probable factura/UNKNOWN se rechaza antes de OCR completo. El mensaje no afirma un tipo si el confidence no alcanza.

El usuario puede indicar “sí es un recibo” sólo después de seguridad. Esa acción queda auditada y habilita el procesamiento salarial; no habilita otros tipos documentales.

## Storage y descarga

- buckets/prefixes privados;
- key aleatoria y no derivada de PII;
- nombre visible derivado sólo dentro de respuestas autenticadas; nunca como key, URL o dato de observabilidad;
- cifrado en reposo en producción;
- policy separada para cuarentena, aceptados y temporales;
- descarga mediante endpoint que reautoriza y firma por pocos minutos;
- la descarga firmada admite `inline` o `attachment`, conserva `Content-Type: application/pdf`, fuerza `Cache-Control: no-store, private, max-age=0` y usa el filename genérico `salarivo-document.pdf` para no incluir PII en la URL;
- URL completa excluida de logs/traces;
- no cachear respuestas sensibles en CDN compartida.

El visor usa PDF.js en el navegador, sin `iframe`, plugins ni CDN de terceros. Worker, CMaps, perfiles ICC, fuentes estándar y decodificadores WASM se publican desde el mismo origen a partir de la versión exacta instalada; la CSP mantiene `object-src 'none'`, restringe workers a `self`/`blob`, habilita sólo la compilación WASM necesaria para esos decodificadores y permite conexiones únicamente al API y al origen exacto configurado para las URLs firmadas.

En Cloudflare R2 se usa Standard y el cifrado automático AES-256-GCM con claves administradas por el proveedor. El bucket no expone `r2.dev` ni custom domains, no tiene Bucket Locks habilitados y no usa migración on-demand que pueda rehidratar objetos borrados. La API crea primero un marcador vacío `If-None-Match: *` y persiste su ETag. La autorización del navegador es `PUT` —R2 no admite formulario firmado `POST`— y liga la key única al marcador con `If-Match`, además de tamaño, `Content-Type`, metadata de sesión y `x-amz-storage-class: STANDARD`. Una URL puede retransmitirse, pero sólo el primer reemplazo del marcador puede completar. La copia canónica repite el patrón con `cf-copy-destination-if-match` y reconcilia retries mediante ETag, tamaño y metadata. CORS tiene dos reglas exactas en el origen productivo: upload `PUT` con los headers `Content-Type`, `If-Match`, `x-amz-meta-upload-session` y `x-amz-storage-class`, exponiendo `ETag`; y descarga firmada `GET`/`HEAD`, admitiendo `Range` y exponiendo `Accept-Ranges`, `Content-Disposition`, `Content-Length`, `Content-Range`, `Content-Type` y `ETag`. API y worker validan al arrancar mediante consultas read-only que storage class, dominios, CORS, lifecycle, locks y migración coincidan; cualquier error o drift impide iniciar. Las credenciales S3 de objetos se limitan al bucket. El token REST separado usa `Workers R2 Storage Read` account-wide: no escribe configuración, pero puede leer/listar objetos, por lo que permanece secreto y sólo en API/worker.

El camino AWS/local exige SSE-KMS con la key configurada en producción, versioning nunca habilitado y Public Access Block completo, y conserva sin cambios el upload firmado `POST`. Su configuración CORS agrega una regla separada `GET`/`HEAD` con `Range` y los mismos headers expuestos para la descarga firmada.

## Cleanup

Uploads incompletos expiran. Su item se cancela cuando ya no existe una sesión vigente y los items que nunca iniciaron upload se cancelan tras `UPLOAD_TTL_SECONDS + UPLOAD_CLEANUP_GRACE_MS` sin actividad del lote, permitiendo completarlo sin cortar una carga secuencial activa. En R2, borrar con éxito el marcador u objeto revoca el PUT condicional incluso si una request estaba en vuelo; el worker pasa entonces la sesión a `CANCELLED` y libera la reserva, o cambia la referencia confirmada a la key canónica. En AWS/local, donde el formulario firmado no tiene ese marcador, la sesión permanece `EXPIRED` y ambas keys se reborran hasta terminar la ventana de expiración más gracia. Rechazados, cancelados y temporales se eliminan por una tarea idempotente y reconciliable.

Un borrado explícito registra antes un tombstone durable con las keys `incoming/` y canónica, bloquea la descarga e intenta el delete inmediato. El worker conserva el tombstone hasta que venza la autorización de upload, reintenta ambas keys y sólo entonces lo elimina. Antes de producción debe comprobarse que la duración máxima de una carga no supera esa ventana; si el proveedor no ofrece esa garantía, el worker deberá inventariar y reborrar después antes de cerrar la baja. En R2, el lifecycle obligatorio elimina `incoming/` y aborta multipart incompletos al día; no expira objetos canónicos. Producción aplica las comprobaciones específicas de R2 o AWS descritas arriba. Un tipo no soportado fuerza `DELETE_AFTER_PROCESSING`. Un duplicado SHA-256 exacto se detecta sólo owner-scoped; tras limpiar el temporal se tombstonea y descarta todo su registro por cascada, sin afectar similitudes estructurales ni documentos de otro titular.

## Checklist de implementación

- ownership en creación, confirmación, estado, descarga y borrado;
- validación server-side;
- transiciones idempotentes;
- rate limit y quota;
- streaming;
- sanitizer;
- métricas sin labels libres;
- auditoría;
- cleanup ante cada error;
- reborrado de uploads vencidos durante una ventana de gracia y lifecycle obligatorio para `incoming/`;
- fixtures sintéticos de abuso;
- test cross-user.

La lista de escenarios está en [Pipeline de ingestión](../architecture/ingestion-pipeline.md).
