# Frontend mobile y PWA

## Superficies existentes e inventario

La web usa React 19, Vinext/Vite, CSS global y módulos CSS para revisión, visor y privacidad. La navegación del titular vive en `/` con parámetros validados; administración usa `/admin/[[...path]]`. No existen pantallas independientes de login por contraseña, empresas del titular o actividad del titular: el acceso es Google, empresas forman parte de empleos y actividad se muestra en sesiones. No se habilitan capacidades futuras al adaptar el frontend.

| Superficie | Estados y flujos revisados | Problema de partida |
| --- | --- | --- |
| Acceso | Google, registro legal, MFA, onboarding, reaceptación, constancia de baja | Historia promocional antes del ingreso, alturas `100vh`, padding acumulado, tokens largos |
| Resumen | Indicadores, evolución, documentos recientes, carga/error/vacío | CSS desktop, montos sin límite de ancho, encabezados grandes y saltos durante cargas lentas |
| Empleos | Lista, detecciones, detalle, favoritos, alta/edición/asociación | Título truncado junto al estado, grillas rígidas, dialogs sin aislamiento nativo y borradores perdidos al volver |
| Importación | Selector PDF múltiple, lote recuperado, progreso/errores/cancelación | Copy de drag-and-drop, mensajes truncados y exceso de altura |
| Historial | Resumen/comparación, evolución nominal/USD, poder adquisitivo, anual, conceptos | Tablas mobile específicas repetidas, celdas con montos largos, tooltip fijo |
| Documentos | Filtros, tipos/estados, selección/asociación, paginación, revisión/reproceso | Filtros extensos siempre visibles, lectura comprimida a 320px |
| Revisión y PDF | Campos, conceptos, evidencia, versiones, zoom, privacidad, borrado | Header de cuatro columnas, controles de 28px, footer sticky, zoom centrado |
| Configuración | MFA, recovery codes, sesiones, exportación, eliminación | Grillas anchas, tabs con margen negativo, acciones pequeñas, saltos al cargar MFA y vacío de sesiones mostrado tras error |
| Legal y errores | `/terms`, `/privacy`, errores de carga, rutas desconocidas | Padding excesivo, falta de 404 propio y reintento legal |
| Administración | Panel, usuarios/detalle, documentos/detalle, empleadores/detalle, procesamiento, storage, privacidad, seguridad, auditoría, políticas, accesos, sistema | Sidebar larga sin scroll, filtros extensos, strings operativas largas, drawer sin foco modal |
| Transversal | Shell, navegación, dialogs, teclado y estados | `body { overflow-x: hidden }` oculta fallos; breakpoints dispares; faltan safe areas |
| PWA | Instalación, standalone, offline, actualización | No existen manifest, service worker ni política de caché; sólo icono SVG |

Este inventario describe la base inspeccionada antes de normalizarla. Los cambios siguientes existen en el código local; no acreditan despliegue en producción.

## Patrones implementados

La base CSS es una columna desde 320px, sin `overflow-x: hidden` en la página. Los saltos compartidos son 768px (grillas y formularios), 1024px (navegación lateral y revisión dividida) y 1280px (tablas densas del titular). La revisión mantiene una sola columna cuando la altura no alcanza, aunque el teléfono esté horizontal. Los contenedores limitan la lectura a 1400px para el titular y 1440px en administración.

| Patrón existente o compartido | Uso al agregar pantallas |
| --- | --- |
| `.page`, `.page-header`, `PageHeader` | Contenedor con safe areas, título y una acción principal; no definir otro ancho fijo |
| `.panel`, `.panel-heading`, `.metric-grid` | Secciones con `min-width: 0`, padding común y expansión progresiva |
| `AppNavigation` | Un solo contenido para sidebar no modal en desktop y drawer modal nativo en mobile; aislamiento, Escape y foco del navegador |
| `.mobile-navigation` | Inicio, Recibos, Subir, Historial y Más; el drawer completa empleos/cuenta. Sólo mobile/tablet, sin duplicar la lógica de navegación |
| `.responsive-data` | La misma tabla pasa a filas tipo card con `data-label`; conservar encabezados, `scope`, semántica de tabla y una sola fuente de datos |
| `.admin-table` | Cards operativas en mobile y tabla en desktop; IDs y metadata pueden envolver sin perder el valor |
| `DocumentsFilters`, `QueryFilters` admin | Panel plegable en mobile, contador de filtros aplicados, Aplicar/Limpiar/Cancelar; sólo el submit aplica los valores |
| `ResponsiveDialog` | Formularios compartidos con `showModal`, Escape, fondo aislado y scroll interno; pasar `busy` durante mutaciones |
| `DocumentReview`, `DocumentViewer` | Revisión fullscreen con tabs Datos/PDF mobile y dos paneles desktop; datos completos, zoom y desplazamiento dentro del visor |
| `EmptyState`, `ErrorState`, estados de carga | Explicar el siguiente paso, ofrecer reintento cuando existe y reservar el contenedor de la operación |
| `MoneyValue`, `PercentageValue`, `SensitiveValue`, `PrivacyToggle` | Reutilizar el enmascarado existente también en cards, etiquetas y contenido accesible; jamás duplicar el salario en `title` |

La escala principal es 4/8/12/16/24/32px en variables de `globals.css`. Inputs y selects usan al menos 16px; controles táctiles principales miden al menos 44px. Las alturas usan `dvh`, y headers, navegación inferior y dialogs consideran las cuatro safe areas. La navegación inferior reserva espacio de contenido y se retira al enfocar un campo para no competir con el teclado. Los dialogs nativos mantienen el foco dentro y evitan interacción con el fondo.

El historial conserva datos completos: las series usan un gráfico desplazable dentro de su contenedor, selección de período y tabla exacta desplegable. El tooltip de hover tiene alternativa mediante selección y detalle. El modo privacidad también oculta los importes y la forma salarial reconstruible del gráfico. Nombres de empresa, importes y metadata envuelven; el encabezado compacto del recibo tiene el nombre completo disponible en sus datos.

Los tabs conservan una fila desplazable local y llevan la opción seleccionada a la vista. El PDF requiere una acción explícita de Mostrar PDF, con autorización de servidor y confirmación adicional si está activo el modo privacidad. El zoom mantiene accesible el borde izquierdo; las herramientas secundarias se despliegan y pantalla completa se ofrece sólo si existe la API. La carga sigue aceptando exclusivamente PDFs, uno o varios, con progreso y errores por archivo.

Alta, edición y asociación de empleos comparan los campos con sus valores iniciales: cerrar, Escape, Atrás o recargar protegen los cambios sin guardar. Mientras una transferencia está activa, Atrás conserva la pantalla de importación y su progreso. Estos borradores viven únicamente en memoria. Los placeholders de Resumen y MFA reutilizan las grillas finales; un error al consultar sesiones ofrece reintento sin afirmar que la lista está vacía.

La revisión de recibos muestra los motivos que impiden reconstruir la base indemnizatoria, incluso si la extracción está lista. Los enlaces del simulador abren Datos con el concepto seleccionado y permiten enfocar campos faltantes o conceptos concretos; las diferencias monetarias y descripciones respetan el modo privacidad. El diagnóstico proviene del detalle autorizado de la extracción activa. Los parámetros `review=termination` y `lineItem` sólo conservan el contexto y un ID validado; no contienen salarios ni explicaciones y se retiran al cambiar de documento o cerrar. Los conceptos son de consulta: las acciones de edición se limitan a los campos ya admitidos y el reproceso conserva su comparación versionada.

## PWA, sesión y rendimiento

La decisión y la allowlist se describen en [ADR 0018](../adr/0018-private-pwa.md). `PwaControls` ofrece instalación contextual sólo en Android, iPhone e iPad, incluido iPad con user-agent de escritorio. Achicar una ventana de escritorio no habilita esa invitación. El aviso de actualización y el estado offline se conservan en todas las plataformas. El build genera el worker; no se registra en desarrollo. Se cachean únicamente código, estilos y fuentes públicas del compilador, marca, manifest y página offline. No se cachean respuestas de API, HTML/RSC de la aplicación, PDFs, salarios, metadata privada, credenciales, URLs firmadas, queries ni escrituras.

Offline oculta e inhabilita la pantalla y los dialogs, incluso si terminan de abrirse por una respuesta pendiente. Los formularios permanecen en memoria de la página; no existe persistencia privada ni cola de escrituras offline. Reintentar/reconectar permite continuar sin recargar automáticamente. La nueva versión espera una confirmación y exige cerrar otras ventanas para evitar interrumpirlas.

Las consultas autenticadas usan `cache: 'no-store'`. Titular y admin revalidan sesión al recuperar foco, visibilidad o conexión; un error `AUTHENTICATION_REQUIRED` retira la interfaz privada. Un código MFA incorrecto o una falla de red no se convierten en cierre de sesión. Google, cookies, backend y permisos conservan sus contratos.

`DocumentReview` es un import dinámico, y el PDF/worker sólo se solicitan al mostrar el original. El build inspeccionado separa aproximadamente 33KB de revisión, 431KB de PDF.js y 1,27MB de worker (tamaños sin compresión); los tres quedan fuera de la carga inicial del resumen. Una traza local de Resumen a 390px, con API sintética, recursos ya visitados y sin throttling, registró LCP de 157ms y CLS 0; no es una medición de producción. No se agregaron dependencias de runtime, fuentes remotas ni imágenes de marketing pesadas. El logo y los iconos derivan de la marca existente.

## Verificación reproducible

Con Node 24 y Chrome, Chromium o Edge instalado, compilar y servir el build local en una terminal:

~~~powershell
npm run build --workspace @salarivo/web
npm run start --workspace @salarivo/web -- --port 3040 --hostname 127.0.0.1
~~~

En otra terminal:

~~~powershell
$env:SALARIVO_TEST_URL = 'http://127.0.0.1:3040'
npm run test:browser --workspace @salarivo/web
npm run test:browser:navigation --workspace @salarivo/web
npm run test:browser:admin --workspace @salarivo/web
npm run test:browser:loading --workspace @salarivo/web
npm run test:pwa:browser --workspace @salarivo/web
~~~

`SALARIVO_TEST_BROWSER` selecciona el ejecutable; `SALARIVO_TEST_OUTPUT` permite elegir una carpeta local para capturas. El harness CDP usa WebSocket y asserts de Node, un perfil efímero y sólo orígenes loopback. Los fixtures interceptan la API con personas, importes, empresas y PDFs sintéticos. No reemplazan una integración real de backend, Google ni object storage. Las capturas y resultados van a temporales, no al repositorio.

La verificación del 2026-09-05 incluye 113 comprobaciones del titular en Chrome y 113 en Edge y 65 combinaciones ruta/ancho de administración en Chrome y Edge, además de sus interacciones. Se cubren 320, 360, 375, 390, 414, 430, 768, 1024, 1280/1440, 1920 y 2560px, y orientación horizontal. Se prueban formularios con altura reducida, navegación/foco/Escape, filtros, errores/vacíos, privacidad, revisión/zoom, carga PDF sintética, MFA y retiro de metadata al expirar/revocar sesión. La suite PWA verifica worker instalado, ausencia de errores de instalabilidad en Chromium, caché pública real, probes privados excluidos, offline con dialogs previos y tardíos, borrador preservado y actualización entre ventanas.

La suite de navegación agrega 13 casos, aprobados en Chrome y Edge, con historial real del navegador y señal standalone emulada: Atrás/Adelante/refresh, deep links, descarte de borradores, transferencia activa, MFA y gestión de sesiones. La suite de carga demora 2500ms las respuestas de historial o MFA y mide nueve combinaciones a 320/390/1280px. En el build local, todas registraron CLS menor a 0,01; a 390px Resumen pasó de 0,4609 a 0 y MFA activo de 0,2182 a 0. También prueba error y reintento de sesiones. Son mediciones sintéticas de esos escenarios, no garantías para cualquier contenido o red.

El pase opcional de WebKit requiere un runtime Playwright existente y su navegador WebKit instalado; no se incorpora como dependencia de Salarivo. Servir el build mediante HTTPS en loopback, conservando los headers originales: WebKit aplica `upgrade-insecure-requests` también en localhost. Con `SALARIVO_TEST_URL` apuntando a ese origen HTTPS y `SALARIVO_PLAYWRIGHT_MODULE` a la ruta absoluta del módulo `playwright/index.mjs`, ejecutar `npm run test:browser:webkit --workspace @salarivo/web`. El test acepta certificados locales de prueba únicamente en loopback. El pase con WebKit 26.5 completó 72 comprobaciones a 320/390/768/1440px, incluyendo rutas, dialogs, PDF, upload y reconexión, sin errores de runtime ni overflow global. Este motor de prueba no acredita Safari/iOS instalado; ver [navegadores de Playwright](https://playwright.dev/docs/browsers).

La prueba opcional `npm run test:pwa:install --workspace @salarivo/web` verifica instalación nativa mediante el canal pipe oficial de Playwright/CDP. Requiere `SALARIVO_PLAYWRIGHT_MODULE` y `SALARIVO_TEST_BROWSER` con la ruta absoluta del ejecutable Chrome o Edge; `PWA_BASE_URL` permite otro build loopback, por defecto en el puerto 3040. Crea un perfil temporal y un origen exclusivo, cambia sólo los nombres del manifest servido por el proxy a una etiqueta QA única y utiliza el instalador del navegador, incluida su integración temporal con el sistema operativo. Selecciona la preferencia nativa Abrir como ventana y comprueba `display-mode` sin emularlo. Al terminar desinstala exclusivamente esa identidad, verifica su ausencia y elimina el perfil; si no puede confirmar la desinstalación, conserva el perfil e informa el fallo para permitir recuperación.

En Windows, Chrome 152 aprobó instalación, apertura standalone, deep link documental, Atrás y recarga, con sesión sintética. Edge 152 aprobó instalación y desinstalación, pero `PWA.launch` devolvió `Failed to launch`; la alternativa oficial `PWA.openCurrentPageInApp` tampoco activó standalone en el proceso headless. El test mantiene ese fallo explícito: falta comprobar apertura instalada en Edge interactivo. Ambos navegadores confirmaron desinstalación y eliminación de sus perfiles de prueba. Estas comprobaciones no acreditan Google real, splash ni teclado de teléfono.

También se ejecutan las verificaciones de los manifests: typecheck, lint, tests, build web, validación de Docker Compose y `git diff --check`. La revisión visual complementa los asserts de overflow con capturas de acceso, dashboard, documentos/PDF, filtros, diálogos y admin. El último pase completo de Chrome incluye las regresiones de etiquetas del gráfico sin scroll vertical y hover de campos sin saltos de lectura; Edge cubre la matriz previa. Lighthouse snapshot del build evaluado obtuvo 100 en accesibilidad, sin fallos automáticos, en Resumen mobile y Documentos desktop; se usa como comprobación adicional, no como certificación de toda la aplicación.

## Límites y deuda existente

El alcance de esta entrega es la web responsive y la implementación PWA con las verificaciones locales descritas. Android no se registra como validado: el usuario probará la app instalada después del despliegue. La validación en dispositivos y la apertura standalone en Edge interactivo quedan fuera del cierre de esta entrega local; se conserva el fallo de automatización headless como límite de la evidencia. Un despliegue posterior debe cumplir los checks de VPS/Coolify descritos en README; no publicar en Sites.

El frontend del titular sigue concentrando lógica en `salarivo-app.tsx`; los patrones compartidos permiten extender la presentación sin duplicarla, pero separar sus módulos por dominio corresponde a cambios que realmente los necesiten. Vinext continúa en versión beta y reporta rutas cuya clasificación estática no puede inferir; los headers privados se verifican en el servidor real del build. Las mediciones de localhost y fixtures no permiten prometer tiempos de carga de producción ni rendimiento con redes/dispositivos reales. No se agregó lectura salarial offline, background sync, soporte de fotografías ni otro proveedor de autenticación.

## País y simulador de desvinculación

`CountrySelect` combina filtro por nombre/código localizado con select nativo; el valor enviado siempre es ISO. La sugerencia no bloquea navegación ni se confirma automáticamente. Perfil/onboarding/configuración, alta/edición del empleo y revisión documental reutilizan el catálogo. La moneda y el locale del perfil sólo proponen defaults; el contexto del empleo y la moneda de cada importe se conservan.

La sección `termination` es accesible desde empleos e historial. Prioriza el último empleo ACTIVE/DEPENDENT y ofrece confirmación para UNKNOWN. Hoy o fecha civil elegida, overrides explícitos, topes con vigencia/fuente y datos utilizados se mantienen en memoria y se envían por POST. Mobile muestra ambos totales juntos y luego tarjetas adaptables; desktop compara columnas. Cada resultado expone su regla, calidad, supuestos, datos y tratamiento de conceptos. Se reutilizan MoneyValue y privacidad visual, incluyendo campos de importe protegidos. No se guardan salarios en URL, localStorage ni cachés de PWA.

`npm run test:browser:jurisdictions --workspace @salarivo/web` verifica con fixtures sintéticos 320/390/1440, países, estado, fechas históricas/futuras, overrides, teclado, ausencia/error, privacidad y revisión del país documental. Las fórmulas se ejecutan en el motor real del fixture, nunca en React.
