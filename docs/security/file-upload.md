# Seguridad de upload

> Estado: protocolo implementado para el MVP local. Producción requiere completar cifrado, backups, observabilidad y controles del proveedor elegido.

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
- MAX_WORKER_MEMORY_BYTES;
- JOB_MAX_RETRIES.

Ausencia o valor inválido debe impedir el arranque en producción. El worker termina de forma segura cuando supera un budget y registra un código sanitizado.

## Aislamiento del parser

El proceso que inspecciona/renderiza:

- no es root;
- usa filesystem temporal por job;
- sólo puede leer el objeto del job;
- no recibe credenciales de DB, storage global ni aplicación;
- no tiene red salvo un destino explícitamente requerido;
- tiene límites de CPU, RAM, output y tiempo;
- borra temporales al finalizar o por reconciliación.

Nunca se abre el PDF en un navegador privilegiado del backend ni se ejecuta contenido activo.

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
- URL completa excluida de logs/traces;
- no cachear respuestas sensibles en CDN compartida.

## Cleanup

Uploads incompletos expiran. Su item se cancela cuando ya no existe una sesión vigente y los items que nunca iniciaron upload se cancelan tras `UPLOAD_TTL_SECONDS + UPLOAD_CLEANUP_GRACE_MS` sin actividad del lote, permitiendo completarlo sin cortar una carga secuencial activa. La key `incoming/` de una sesión confirmada se conserva y reborra hasta terminar esa misma ventana; recién entonces la referencia pasa a la key canónica. Rechazados, cancelados y temporales se eliminan por una tarea idempotente y reconciliable. El estado DELETED sólo se confirma después de borrar/revocar recursos activos o registrar explícitamente qué queda sujeto a backup.

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
