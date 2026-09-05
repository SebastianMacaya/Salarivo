# ADR 0018 — PWA instalable con caché pública explícita

- Estado: Proposed; implementación local sujeta a revisión humana y validación en dispositivos.
- Fecha: 2026-09-05.

## Contexto

Salarivo usa React/Vinext con Vite y necesita instalación y una experiencia mobile sin persistir información salarial. La API ya aplica `Cache-Control: no-store`; las sesiones siguen siendo cookies opacas y Google usa una navegación completa con callback server-side. Una estrategia offline-first genérica duplicaría datos Restricted en el dispositivo y exigiría otro ciclo de autorización y borrado.

## Decisión implementada

- Manifest público con identidad estable `/`, scope `/`, standalone, colores de marca e iconos PNG de 192/512, maskable y Apple Touch Icon. No se fuerza orientación ni se deshabilita zoom. El navegador genera el splash que soporte a partir del manifest; no se agregan imágenes específicas por dispositivo.
- Service Worker nativo, sin dependencia adicional, registrado sólo en producción bajo HTTPS o localhost seguro. El `postbuild` de la web calcula una versión SHA-256 y una allowlist exacta desde el output público del compilador. Un cambio de build o del worker produce otro script y otra caché.
- Precache únicamente de la página pública sin conexión, manifest e iconos. JS/CSS/fonts del compilador se guardan bajo demanda, con credenciales omitidas y validación de status, MIME, redirects y Cache-Control. Una denegación de storage conserva el funcionamiento online.
- Ninguna respuesta de API, ruta autenticada, HTML/RSC de la aplicación, PDF, OCR, salario, PII, export, token, URL firmada, query string o request de escritura entra en Cache Storage. Los recursos públicos de PDF.js no son PDFs privados; sólo los módulos públicos incluidos en output del compilador son elegibles. No se agrega IndexedDB, localStorage ni sessionStorage.
- Las navegaciones de las rutas existentes usan la red con `no-store`. Ante una falla de red reciben únicamente `offline.html`, sin guardar el HTML de origen ni su URL. Los endpoints de API y OAuth quedan fuera del fallback y de la intercepción.
- Si una pantalla abierta pierde conexión, un dialog modal opaco muestra el estado sin conexión; el contenido queda invisible e inert, pero montado, para conservar formularios en memoria. Los dialogs existentes o abiertos después por respuestas pendientes se ocultan y bloquean directamente: un modal nativo puede escapar el inert de su ancestro. Al volver Internet se restauran esos estados para continuar y verificar las subidas interrumpidas; no hay cola de escrituras offline ni reintentos automáticos de mutaciones.
- La invitación de instalación se muestra sólo en Android, iPhone e iPad; escritorio no muestra botón ni franja de instalación, incluso con ventana estrecha. Usa el prompt nativo sólo cuando está disponible y la persona toca el botón contextual. En iPhone/iPad se ofrece una explicación desplegable de Compartir → Agregar a pantalla de inicio. La web funciona sin estas APIs; el navegador puede conservar su propia opción de instalación en el menú o la barra de direcciones.
- Se comprueban updates al iniciar, al recuperar conexión/visibilidad y cada hora con la página visible. La versión nueva espera: `skipWaiting` requiere pulsar Actualizar y confirmar que terminaron las subidas y se guardaron los cambios. Si hay otra ventana de Salarivo abierta, se pide cerrarla antes de activar. Sólo la ventana que solicitó la actualización se recarga tras el cambio de controlador. La activación borra exclusivamente cachés `salarivo-public-*` anteriores.
- Login, callback, MFA, sesiones, logout y ownership conservan su contrato. La instalación no crea otro sistema de autenticación. No se guardan datos de navegación para recuperar OAuth: los redirects internos existentes siguen siendo la fuente del contexto.

## Alternativas descartadas

Un plugin offline-first o precache del HTML completo agrega persistencia sensible y una dependencia sin necesidad. La activación automática puede interrumpir una corrección o una carga. Precargar todos los módulos, incluido el visor PDF, consume datos mobile antes de que se usen.

## Consecuencias y límites

La aplicación requiere Internet para datos y acciones privadas. Un documento ya abierto y los formularios siguen en memoria de esa página; el modo offline no implica cerrar la sesión ni purgar esa memoria. Las preferencias visuales previas conservan su almacenamiento existente.

Sin conexión en la primera visita, o si el navegador elimina/rechaza la caché, no se garantiza la página offline. La actualización manual requiere cerrar las otras ventanas; no se construye coordinación de borradores entre pestañas. Las cachés públicas antiguas permanecen hasta activar otra versión o hasta que el navegador las retire. El contenido público cacheable no requiere un purge por logout o borrado de cuenta.

La validación automatizada cubre manifest/iconos, política real de caché, rechazo de respuestas privadas, fallback de deep links y activación controlada. El smoke de Chromium aislado comprueba además los criterios de instalación del navegador, instalación del worker, caché pública del build, rechazo de probes privados, borrador en otro modal durante pérdida de red —incluidos dialogs abiertos por respuestas tardías—, recuperación y actualización con múltiples ventanas. Los escenarios de sesión de la suite responsive usan respuestas sintéticas y no autentican una cuenta real.

Una prueba opcional de instalación nativa usa un perfil temporal, origen loopback exclusivo y nombre QA único; instala mediante CDP/pipe, selecciona la preferencia nativa Abrir como ventana y desinstala al terminar. Chrome 152 en Windows aprobó apertura standalone sin emular `display-mode`, deep link, Atrás y recarga. Edge 152 confirmó instalación y desinstalación, pero su lanzamiento headless falló; la alternativa Abrir en la aplicación tampoco activó standalone. El test conserva ese fallo y no acredita apertura instalada en Edge. En ambos casos se verificaron desinstalación y eliminación del perfil. Ver comando y alcance en [frontend](../architecture/frontend.md).

La entrega local se limita a la web responsive y la implementación PWA con pruebas locales. Android no fue validado en dispositivo; el usuario realizará esa prueba después del despliegue. La validación de las aplicaciones instaladas queda fuera del cierre local acordado. Las pruebas automatizadas descritas no acreditan Safari/iOS en dispositivo ni apertura standalone en Edge interactivo; ver el alcance en [frontend](../architecture/frontend.md).

La misma suite emula nueve escenarios de progressive enhancement en Chromium: instrucciones de Compartir para iPhone sin evento de instalación, detección de iPad con user-agent desktop, instalación oculta mediante `navigator.standalone`, instalación oculta mediante `display-mode`, navegación normal sin la API `serviceWorker`, prompts de prueba en teléfono y tablet Android que se abren exclusivamente al pulsar Instalar, y escritorio ancho y estrecho sin botón ni franja de instalación aun recibiendo el evento. Estas sustituciones de propiedades y eventos verifican la lógica cliente; no son una prueba de Safari, de una instalación física ni del comportamiento del sistema operativo.

Verificación local reproducible, con Node 24 y Chrome/Chromium/Edge disponible:

~~~powershell
npm run build --workspace @salarivo/web
npm run start --workspace @salarivo/web -- --port 3040 --hostname 127.0.0.1
# En otra terminal, con el servidor anterior activo:
npm run test:pwa:browser --workspace @salarivo/web
~~~

`PWA_BASE_URL` permite otro servidor de producción local; `SALARIVO_TEST_BROWSER` permite indicar el ejecutable del navegador. El test rechaza dominios externos, usa perfil efímero y datos sintéticos, y no modifica el build: un proxy local de prueba simula otra versión del worker.

## Condiciones para aceptar o reemplazar

Revisión humana del diff y pruebas mínimas verdes, comprobación de headers y del worker en el build servido, smoke autenticado con datos sintéticos y validación de instalación/retorno OAuth en dispositivos compatibles. Una futura lectura privada offline necesita otra decisión explícita de autorización, cifrado, expiración y borrado; ampliar la allowlist a rutas dinámicas está fuera de este ADR.

## Referencias

- [MDN: instalación de PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
- [MDN: instalación contextual](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt).
- [MDN: registro y updateViaCache](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register).
- [MDN: skipWaiting y efecto sobre clientes](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting).
- [Chrome DevTools Protocol: instalación, apertura y desinstalación de PWA](https://chromedevtools.github.io/devtools-protocol/tot/PWA/).
