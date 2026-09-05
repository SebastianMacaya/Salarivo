# OCR externo como fallback

> Estado: integración implementada en código. La publicación legal 1.1 se documenta por separado en [Políticas legales](../legal/policies.md). Este documento no acredita despliegue del OCR, saldo del proveedor ni cobertura de layouts reales.

## Flujo y alcance

El pipeline anterior ya tenía seguridad, clasificación, extracción de texto PDF, Tesseract local, un parser argentino por etiquetas, evidencia espacial, corridas versionadas, revisión humana y artefactos reutilizables. Se conservan esas piezas. `extraction-orchestrator.ts` coordina el parser existente y un segundo intento opcional mediante el contrato neutral `OCRProvider`.

~~~mermaid
flowchart TD
    A[PDF privado] --> B[Validación, malware y contenido activo]
    B --> C[Texto nativo y muestra Tesseract si falta texto]
    C --> D[Clasificación y parser determinístico existente]
    D -->|Resultado suficiente| G[Validación y comparación con corrida activa]
    D -->|Recuperación necesaria y proveedor habilitado| E[Reserva de presupuesto y GLM-OCR]
    E --> F[OCRResult neutral: texto, páginas y bloques]
    F --> D2[Mismo parser y nueva clasificación]
    D2 --> G
    G --> H[Completo, con observaciones o revisión]
~~~

Un PDF conocido con texto suficiente y campos válidos termina sin llamar a Z.ai. Una extracción local de Tesseract suficiente también evita la llamada externa. La persistencia de `PayrollSettlement` y Analytics no conoce el contrato de Z.ai: recibe la misma extracción interna, validada con dinero decimal, período, tipo de liquidación, completitud y reglas de promoción vigentes.

Un PDF escaneado primero pasa seguridad y una muestra OCR local. Si ésta no alcanza para clasificar y no identifica señales de documento comercial, certificado o documento fiscal, el worker puede consultar Z.ai para recuperar texto y volver a clasificar. Por tanto, esta ruta exige seguridad previa y descarte barato, pero no garantiza una clasificación salarial positiva antes del envío externo. Un tipo no salarial reconocido sigue rechazándose; la confirmación manual tampoco evita controles de seguridad.

El upload público y la web siguen aceptando únicamente PDF. El adapter declara y valida PDF, JPEG y PNG porque el proveedor los soporta; eso no habilita imágenes/fotos en Salarivo. Se reutilizan el resolver de empleador, el parser por etiquetas y la revisión existentes. Los formatos revisados agregan reglas literales al mismo parser, sin un extractor semántico ni un LLM adicional.

## Formatos independientes del empleador y reutilización revisada

El parser genérico es independiente de una empresa y siempre intenta primero las etiquetas conocidas. La migración `027_reviewed_document_layouts.sql` agrega `Employer → DocumentLayout → DocumentLayoutVersion`: un empleador puede tener varias huellas y cada formato conserva versiones explícitamente aprobadas. Las versiones no se editan ni borran mediante la aplicación; una nueva versión puede desactivar un formato sin alterar resultados históricos. La versión del parser pasa a 8; el extractor sigue en 7 para reutilizar OCR compatible. La migración exige workers drenados antes de actualizar el fingerprint de jobs pendientes.

`fingerprintLayout` genera SHA-256 sobre una representación estructural versión 1: IDs cerrados de anchors salariales y columnas, su orden dentro de cada línea, la secuencia de líneas reconocidas y el número de páginas. No incluye valores, nombres, CUIT, texto libre ni el hash binario del archivo. La huella no acredita identidad ni igualdad visual: puede agrupar variantes de la misma estructura y cambia si cambia la segmentación del texto. No intenta inferir coordenadas entre motores con distinta geometría.

Cuando una corrida queda en revisión, la consola de Procesamiento muestra la huella y conteos para un empleador argentino verificado. `GET /api/v1/admin/processing/layouts` usa `processing.read`, pagina los formatos y presenta las últimas 20 versiones con el conteo histórico. No entrega documentos, owners, texto OCR ni valores de campos. `POST /api/v1/admin/processing/layouts/approve` exige `layouts.manage`, exclusiva de `SUPER_ADMIN`, step-up vigente, motivo y auditoría atómica. La primera aprobación requiere una observación en revisión con titular activo, documento limpio y original todavía disponible. Las siguientes agregan versiones al mismo formato.

El operador configura hasta cuatro etiquetas literales de 2–60 caracteres para cada uno de siete campos: período, básico, bruto, neto, descuentos, remunerativo y no remunerativo. Son configuración genérica escrita y revisada por el operador, nunca aprendizaje automático desde OCR o correcciones humanas. Se rechazan números, URLs, expresiones, caracteres de control, campos fuera de la lista y aliases duplicados entre campos; no hay ejecución de regex o código recibido. La auditoría guarda IDs, versión, estado y cantidad de campos, sin copiar las etiquetas.

La selección exige una única identidad viva coincidente por nombre o alias conservador, estado `VERIFIED`, país `AR`, misma huella y última versión habilitada. Un nombre ambiguo, incluso con otra identidad pendiente, impide reutilizar. Las reglas completan únicamente valores ausentes y conservan el texto original como evidencia. Un importe debe ser único junto a la etiqueta o en la línea siguiente; un período debe tener formato explícito. Totales, conceptos, período, campos críticos y comparación con el activo se vuelven a validar. Aprobar un formato no aprueba un recibo ni sobrescribe una corrección humana.

Un recibo posterior con la misma estructura y etiquetas aprobadas puede completarse con texto nativo o Tesseract sin llamar a Z.ai. Un scan todavía ilegible puede necesitar OCR para obtener ese texto: conocer el formato no reemplaza la lectura de la imagen. La aprobación posterior de una versión habilita un candidato por el reproceso existente; una corrida ya intentada después de esa aprobación no genera reintentos ilimitados. Cada corrida conserva su huella y el ID de versión utilizado. Una revocación o cambio entre selección y persistencia exige revisión con `LAYOUT_APPROVAL_CHANGED`.

Una corrida anterior al parser 8, sin huella y con issues recuperables de formato/campos, puede realizar una única observación con la versión actual, incluso con OCR externo apagado. Esto obtiene metadata para revisión y reutiliza OCR compatible cuando existe; no promete que los campos se recuperen. Una corrida terminal ya evaluada con el pipeline actual impide repetir ese paso hasta que exista una aprobación posterior aplicable.

La fusión de empleadores conserva las reglas e historial del origen, pero su estado `MERGED` impide reutilizarlas; el destino requiere aprobación propia. El registro global no conserva links a documentos o cuentas fuente. El borrado de esas fuentes elimina sus observaciones privadas y no borra configuración genérica aprobada; la referencia al aprobador admite `SET NULL`. El borrado físico del empleador con formatos históricos queda restringido, y no existe una operación administrativa que lo solicite.

## Política de selección

`ocrFallbackReason` produce una razón antes de consultar al proveedor:

| Razón | Condición actual |
| --- | --- |
| `NO_NATIVE_TEXT` | texto disponible de menos de 80 caracteres; también identifica el rescate de clasificación de un PDF escaneado |
| `UNKNOWN_EMPLOYER` | el parser no recupera nombre del empleador; no significa una búsqueda fallida o ambigua en el registro global |
| `FIELD_RECOVERY` | falta período, bruto, neto, descuentos o básico de una liquidación `NORMAL` |
| `PARSER_PARTIAL_RESULT` | validación incompleta o OCR local parcial |
| `CACHE_REUSE` | reutilización de un resultado normalizado compatible; no genera llamada externa |

Una excepción de DB, storage o programación no dispara OCR. El resultado externo vuelve al mismo parser; `UNKNOWN_LAYOUT` identifica una salida todavía no salarial o sin período/importes suficientes. `OCR_RESULT_CONFLICT` obliga a revisión cuando la segunda extracción cambia un campo o modifica/elimina un concepto ya recuperado, incluso si conserva los totales. No se fusionan silenciosamente candidatos contradictorios y el resultado más reciente no reemplaza automáticamente al activo.

`OCR_ENABLED=false` o `OCR_PROVIDER=disabled` conservan el arranque sin credenciales. Cuando una extracción aceptada necesita OCR, el proveedor deshabilitado produce `OCR_DISABLED` para revisión. La clasificación inicial de un scan ilegible puede requerir primero confirmación de tipo.

## Adapter de Z.ai

`ZaiGlmOcrProvider` usa `fetch` nativo y la API general de aplicaciones: `POST https://api.z.ai/api/paas/v4/layout_parsing`, modelo `glm-ocr`, autenticación Bearer. No utiliza el Coding Plan. Origen, path y modelo son allowlisted; no sigue redirects, URLs embebidas ni recursos sugeridos por la respuesta.

El worker envía el PDF validado como data URI base64. No crea una URL pública ni entrega una URL firmada; no agrega filename, email, identificador fiscal ni `user_id`. Cada intento usa un `request_id` aleatorio `sal_<uuid>`. La credencial sólo participa en el header de autorización. No se solicitan recortes ni visualizaciones adicionales, prompts arbitrarios o JSON Schema.

La respuesta no confiable se limita durante la lectura y se valida antes de usarla. El adapter reduce Markdown, tablas y bloques a `OCRResult`; convierte las coordenadas de `bbox_2d` al `SourceRegion` existente, con origen superior izquierdo y espacio normalizado de 0 a 1. Admite tanto ese formato documentado como coordenadas enteras en píxeles, observadas en la API real y en el SDK oficial, únicamente cuando existen dimensiones válidas de página; no supone una escala de 1000. No interpreta HTML como interfaz ni solicita imágenes del proveedor. La geometría de bloque sólo habilita un highlight cuando coincide el bloque completo; no se presenta como coordenadas de palabras o campos inferidos.

El contrato vigente y los límites máximos fueron contrastados el 2026-09-05 con la [referencia oficial de layout parsing](https://docs.z.ai/api-reference/tools/layout-parsing). Los techos implementados son PDF de 30 páginas y 50.000.000 bytes, o imagen de 10.000.000 bytes. Los límites locales por defecto son menores. Cambios futuros del proveedor requieren revisar el adapter y sus tests.

## Configuración

`loadOcrConfig` valida las variables al iniciar el worker. `.env.example` conserva Tesseract local como default. Para seleccionar la integración se configuran `OCR_ENABLED=true`, `OCR_PROVIDER=zai` y una `ZAI_API_KEY` secreta; habilitar Z.ai sin clave falla al arrancar, también en producción. La API comparte únicamente los dos flags para ofrecer recuperación compatible; la API y el frontend no necesitan esa clave.

| Variable | Default / significado |
| --- | --- |
| `OCR_ENABLED` | `true`; `false` deshabilita OCR completo y fallback externo |
| `OCR_PROVIDER` | `tesseract`; opciones `disabled`, `tesseract`, `zai` |
| `ZAI_API_KEY` | sin default; secreto del worker, nunca `NEXT_PUBLIC_*` |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4`; sólo API general oficial |
| `ZAI_OCR_MODEL` | `glm-ocr` |
| `ZAI_OCR_TIMEOUT_MS` | `60000` por intento |
| `ZAI_OCR_MAX_RETRIES` | `1`; acepta 0–2 reintentos |
| `ZAI_OCR_MAX_CONCURRENCY` | `1`; límite compartido mediante admisión transaccional y límite local del provider |
| `ZAI_OCR_MAX_PDF_PAGES` | `10` |
| `ZAI_OCR_MAX_FILE_BYTES` | `20971520` |
| `ZAI_OCR_MAX_RESPONSE_BYTES` | `2097152` |
| `ZAI_OCR_DAILY_BUDGET_USD` | `1.00`; ventana UTC |
| `ZAI_OCR_MONTHLY_BUDGET_USD` | `10.00`; mes UTC |
| `ZAI_OCR_RESERVATION_USD` | `0.01` por intento posible |
| `ZAI_OCR_INPUT_PRICE_PER_MILLION_USD` | `0.03`; USD por millón de tokens de entrada |
| `ZAI_OCR_OUTPUT_PRICE_PER_MILLION_USD` | `0.03`; USD por millón de tokens de salida |

Los precios son una estimación configurable basada en la [referencia oficial consultada](https://docs.z.ai/guides/overview/pricing), no una garantía comercial ni una liquidación de factura. La reserva debe revisarse si cambian precios o tamaños permitidos. Se requiere que `JOB_TIMEOUT_MS` cubra análisis local, intentos, backoff, persistencia y cleanup; la configuración vigente valida esa relación cuando selecciona Z.ai.

Para apagar la integración se cambia `OCR_ENABLED=false` y se reinician API y worker con esa configuración. No existe un panel de flags dinámicos; modificar `.env` sin reiniciar no cambia un proceso ya iniciado. Usar `OCR_PROVIDER=tesseract` vuelve al OCR local.

## Reintentos, costo e idempotencia

Sólo errores transitorios de red, timeout, 429 y 5xx permiten retry dentro del presupuesto de intentos. Auth, archivo inválido, respuesta inválida, redirects y límites no se reintentan. El backoff tiene jitter; `Retry-After` se respeta dentro del máximo de 30 segundos, y un valor superior detiene el retry automático. Los errores publicados contienen códigos cerrados, nunca body, base64, texto, secretos o URLs.

`ocr-usage.ts` reserva costo de todos los intentos posibles bajo un lock transaccional por proveedor. Antes de enviar verifica el job vigente, lease, marcador de ejecución, owner activo, original disponible y documento limpio. La misma admisión controla concurrencia entre workers, presupuesto diario/mensual y un circuito que frena nuevas llamadas tras cinco fallos de proveedor recientes en cinco minutos. La transacción no permanece abierta durante HTTP.

Antes de reservar costo para una nueva llamada, comprueba además las constancias de los Términos y el Aviso vigentes del propietario del documento, con el mismo criterio que la API. Un job anterior o un reproceso administrativo no reemplaza esa aceptación. Si falta una constancia, registra `OCR_LEGAL_ACCEPTANCE_REQUIRED` sin gasto ni transferencia y permite recuperar después de aceptar. La cache privada ya existente puede reutilizarse sin una nueva llamada externa; este control no crea aceptaciones por cuenta del usuario.

La migración `026_ocr_provider_usage.sql` agrega `ocr_provider_usage`, FKs compuestas owner/document/run/job y una llamada facturable por corrida/proveedor/modelo/versión. El replay del mismo run devuelve `OCR_ALREADY_ATTEMPTED` cuando no dispone de una cache reutilizable: el sistema prefiere revisión a una segunda llamada de costo incierto. Un timeout no se interpreta como consumo gratuito ni como confirmación de que Z.ai no procesó la solicitud.

Tokens ausentes permanecen ausentes. El costo usa `BigInt` y `NUMERIC(20,8)`, redondeado hacia arriba a ocho decimales. Una respuesta sin usage suficiente conserva la reserva; un retry previo de costo desconocido también conserva su parte. La tabla diaria `ocr_provider_daily_costs` guarda sólo proveedor/fecha/costo agregado y sobrevive al borrado de documentos o cuentas para que eliminar y volver a subir no reinicie el presupuesto. No se mezcla ese costo con importes salariales.

## Cache y ciclo de vida

El artefacto privado existente evoluciona a payload versión 2: texto, evidencia, `OCRResult` neutral y marca de conflicto que exige revisión. No almacena el JSON completo del proveedor en PostgreSQL. La reutilización requiere mismo titular/documento, SHA-256 del original, provider/model/providerVersion, versión del extractor y artefacto completo íntegro. Cambiar solamente la versión del parser no invalida el OCR.

Un acierto de cache crea una fila `CACHE_HIT` sin tokens nuevos ni costo y relaciona el artefacto con la nueva corrida. Un OCR legible pero ambiguo también se conserva antes de pedir confirmación de tipo, para que confirmarlo no repita la llamada. El contenido permanece bajo el lifecycle del original: tombstones y eliminación durable existentes cubren original, documento y cuenta, incluidos writes inciertos. El detalle de usage se elimina por cascada con su owner/documento; sólo permanece el agregado diario sin IDs. La aplicación no implementa un borrado remoto en Z.ai ni puede acreditar su retención interna.

## Diagnóstico y pruebas

La consola `/admin/processing` agrega el mes UTC actual mediante `GET /api/v1/admin/processing/ocr`, protegido por `processing.read` y los controles administrativos existentes. Muestra documentos procesados sin OCR/con Z.ai, layouts desconocidos, éxitos, fallos, bloqueos, cache, timeouts, reintentos, tokens reportados, reportes ausentes, duración y costos. Los conteos de documentos usan la última corrida terminal del mes. El gasto agregado incluye reservas conservadoras que sobreviven a las bajas; el desglose por cuenta está paginado y corresponde a metadata todavía existente.

La salud observada depende de la última respuesta real: `HEALTHY` si fue exitosa en 24 horas, `DEGRADED` si falló, `UNKNOWN` si falta o es antigua. No hace llamadas pagas de health ni infiere `enabled` desde la configuración de la API. Las corridas del detalle administrativo muestran la última operación OCR con versiones, razón, estado, consumo, duración y error. No exponen contenido ni IDs externos.

El reproceso se solicita por los endpoints y UI existentes: crea un candidato, respeta correcciones humanas y compara contra el activo. La recuperación de errores OCR cerrados (por ejemplo deshabilitado, timeout o presupuesto agotado) permite crear una corrida nueva con la misma versión una vez restablecida la configuración; conserva idempotencia y los límites de gasto. Un OCR exitoso, conflicto o layout aún desconocido no habilita por sí solo otra llamada idéntica. No se agregó un comando para forzar OCR pago ni para saltar cache.

~~~powershell
npm run typecheck
npm run lint
npm test
npm run build --workspace @salarivo/web
docker compose --profile processing --env-file .env.example config --quiet
npm run test:integration
npm run test:browser:admin --workspace @salarivo/web
git diff --check
~~~

El test de integración local requiere PostgreSQL, Redis y MinIO. El smoke de navegador requiere la web local. `npm test` y `npm run test:integration` cargan un bootstrap que elimina `ZAI_API_KEY`, selecciona Tesseract local y bloquea `fetch` a Z.ai antes de salir a la red, incluso si `.env` o el entorno tenían OCR externo habilitado. Los tests del adapter inyectan respuestas sintéticas; GitHub ejecuta únicamente esas suites sin consumo de tokens.

La prueba externa es exclusivamente manual y requiere una decisión explícita: `npm run test:ocr:live --workspace @salarivo/worker-documents`. Carga la clave local, crea un PDF sintético fijo en memoria, ejecuta una llamada sin retries y muestra sólo metadata sanitizada. No acepta paths de documentos personales, no corre en la suite normal y rechaza ejecución desde CI o dentro del runner de tests.

## Despliegue de las migraciones 026–027

Estas migraciones requieren una ventana coordinada; no admiten reemplazar API y worker de forma independiente mientras los procesos anteriores siguen produciendo o ejecutando jobs. Ambas toman un lock de `processing_jobs`, rechazan cualquier fila `RUNNING` o con `execution_owner` y actualizan el fingerprint de trabajo pendiente. El lock de migraciones serializa los arranques nuevos, pero no detiene procesos antiguos ni nuevas inserciones desde una API anterior.

1. Antes del push que activa Auto Deploy, impedir arranques automáticos prematuros y detener la API anterior para cortar la admisión de jobs con el fingerprint anterior. Conservar la configuración del webhook compartido y restaurar Auto Deploy al finalizar.
2. Detener el worker anterior con `SIGTERM` y suficiente tiempo de gracia para que termine el trabajo activo y su cleanup. El handler cierra los loops y espera el job; no cancela la llamada o herramienta que ya está ejecutándose. Verificar la salida del proceso y que no queden réplicas anteriores. No suponer que el vencimiento del lease prueba que el proceso y su temporal terminaron.
3. Comprobar en PostgreSQL que `SELECT count(*) FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL` devuelve cero. Un kill o cleanup fallido puede dejar un marcador huérfano. En ese caso la migración falla cerrada y el nuevo worker no alcanza a iniciar su reconciliador: investigar el proceso y temporal antes de cualquier recuperación operativa, sin limpiar marcadores a ciegas.
4. Iniciar la API y el worker del nuevo commit. Sus entrypoints ejecutan las migraciones; no duplicar esa ejecución en comandos de ciclo de vida de Coolify. Si un arranque falla, inspeccionar la última migración aplicada antes de reintentar: cada migración se confirma por separado, por lo que 026 puede estar aplicada aunque 027 haya fallado.
5. Verificar la migración 027, API saludable, rechazo `401` esperado sin sesión, worker operativo y un smoke autenticado sintético. Las tres aplicaciones deben converger en el mismo commit completo. Comprobar que no quedan jobs pendientes de `DOCUMENT_PIPELINE_V2` con un fingerprint anterior; su presencia indica una API o productor rezagado y requiere resolverlo antes de cerrar el despliegue.

Después de aplicar una migración, una imagen antigua cuyo manifest no contiene esa versión falla al iniciar. La recuperación debe avanzar con código compatible con la historia aplicada; no se borran filas de `schema_migrations`, no se cambian checksums ni se presupone que el rollback automático de imagen revierte la base de datos.

## Límites abiertos

Los [Términos 1.1](../legal/terms-1.1.md) y el [Aviso 1.1](../legal/privacy-1.1.md) contemplan procesamiento automatizado y proveedores externos; su publicación y reaceptación están documentadas en [Políticas legales](../legal/policies.md). Ya no se considera pendiente esa publicación. Sus textos y las constancias históricas no se modifican por esta integración. No se acredita un DPA, región efectiva, retención, subencargados, entrenamiento o mecanismo de borrado remoto de Z.ai: la publicación no demuestra por sí sola esos controles del proveedor.

El comportamiento implementado envía el PDF completo al endpoint OCR cuando se habilita el fallback; no realiza una redacción previa del archivo. La [clasificación de datos](../privacy/data-classification.md), el [threat model](../security/threat-model.md) y la [seguridad de upload](../security/file-upload.md) describen esta transferencia y sus controles; no la presentan como un fragmento redactado ni como una garantía sobre el tratamiento interno del proveedor.

Imágenes en upload, descubrimiento automático de templates, editor geométrico, interpretación semántica con otro LLM, override de OCR pago y telemetría separada por cada subetapa no están implementados. El parser por etiquetas y reglas literales revisadas sigue siendo el límite de cobertura: un OCR legible puede terminar en revisión. Tampoco hay garantía de exactamente un cargo externo ante una respuesta perdida; los límites y reservas reducen y explican esa incertidumbre.
