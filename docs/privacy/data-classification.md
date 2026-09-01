# Clasificación de datos

> Estado: política Proposed. Los controles deben demostrarse antes de comunicar garantías al usuario.

## Clases

| Clase | Ejemplos | Manejo |
| --- | --- | --- |
| Restricted | PDFs, OCR, salarios, equivalentes USD y valores/variaciones reales derivados, feedback libre sobre tipos no soportados, salud/obra social, afiliación sindical, futura contribución/mapping de benchmark, CUIT/CUIL/DNI, banco, email, correcciones, exports, cookies/tokens, códigos OIDC, PKCE verifier, `state`, `nonce`, URLs firmadas, claves | cifrado, acceso mínimo, no logs, no fixtures reales, sharing explícito |
| Confidential | userId interno, documentId, relación `(provider, sub)`, categorías coarse de dispositivo/navegador/SO y timestamps de sesión, rol admin, aceptación legal, employment metadata y empresas favoritas, audit events sanitizados, configuración no secreta | acceso por rol/servicio, logs limitados, retención definida |
| Internal | métricas agregadas sin cardinalidad sensible, health, versiones, error codes | uso operativo, sin vínculo innecesario a persona |
| Public | documentación pública aprobada, contenido de marketing y series/observaciones económicas oficiales globales con atribución | sin datos derivados de usuarios |

Un dato derivado mantiene la clase del origen si permite inferir información Restricted. Una cotización o variación de IPC global puede ser Public; al combinarla con un salario, el equivalente, ajuste y cambio resultantes son Restricted. Hashes de documentos e identificadores pseudónimos no se consideran anónimos.

## Minimización

Antes de persistir un campo:

1. definir qué función de producto lo usa;
2. definir owner y retención;
3. clasificarlo;
4. demostrar que no basta una versión menos precisa o redactada.

No se guarda una dirección, banco, familiar u otro dato sólo porque aparece en el PDF. Toda línea individual de tipo deducción se materializa únicamente con su importe y la etiqueta genérica `Deducción`: no conserva descripción, código, recurrencia ni campo de origen. El PDF original continúa siendo Restricted y puede contener señales de salud, afiliación sindical u otros datos incidentales.

Para Google se conserva sólo la relación necesaria entre el UUID interno y `(provider, sub)`, junto con el perfil mínimo requerido por el producto. El email puede mostrarse o usarse como dato de contacto, pero no identifica ni vincula cuentas. Access, refresh e ID tokens nunca se persisten.

Para reconocer sesiones se persisten únicamente categorías allowlisted de dispositivo, navegador y sistema operativo. El user-agent se trata como entrada no confiable y se reduce antes de persistir; se descartan valor crudo, versiones, IP, ubicación, fingerprint y nombre de dispositivo.

## Enmascarado visual de privacidad

El modo privacidad de la interfaz reduce la exposición accidental al compartir pantalla; no es anonimización, redacción del origen ni un límite de autorización. Salarios nominales, equivalentes USD, poder adquisitivo, porcentajes derivados y sus gráficos conservan su clase `Restricted`, y la API continúa aplicando los mismos controles y entregando los mismos datos autorizados al navegador. El nivel o cambio del índice público por sí solo no se reclasifica como salario.

La preferencia vive sólo en el cliente, nunca viaja en la URL ni se persiste en el backend, y no crea ni modifica registros o copias censuradas. Mientras está activa, la interfaz reemplaza importes y porcentajes por marcadores estables y no conserva el valor visible en `title`, nombres o descripciones accesibles, tooltips, popovers, labels de gráficos, mensajes o acciones de copiado. La alternativa accesible describe que el valor está oculto, sin repetirlo. Los gráficos no muestran escalas ni valores exactos reconstruibles; conservar una forma relativa no reclasifica los datos ni permite presentarla como anónima.

El PDF original permanece `Restricted` y sin alteraciones. Antes de abrirlo con el modo activo, la interfaz advierte que su contenido no puede enmascararse automáticamente y exige una decisión explícita del titular.

## Reglas por sistema

### PostgreSQL

Metadata necesaria y datos estructurados. Las tablas económicas globales conservan sólo series públicas, observaciones revisionadas, rangos de sync y errores sanitizados; no tienen userId, documentId ni salarios. El CUIT se persiste sólo cifrado con AES-256-GCM, fingerprint HMAC-SHA-256 y sufijo enmascarado; las claves de cifrado y fingerprint son separadas y no reutilizan MFA ni storage. El binario no se almacena en DB. Los intentos OIDC conservan sólo estado breve y de un uso; cualquier secreto comparable se guarda hasheado cuando el protocolo lo permite.

### Object storage

Originales, artefactos de texto reutilizables y temporales privados, cifrados y con policy/lifecycle. Keys opacas sin nombre, CUIL, empleador ni período. El artefacto reutilizable conserva la clase Restricted del PDF, no tiene endpoint de descarga y se elimina durablemente con el original.

### Cola

Sólo IDs internos, stage, versión e idempotency key. Nunca PDF, OCR, salario ni credenciales.

### Logs, traces, métricas y errores

Allowlist:

- userId interno cuando sea imprescindible;
- documentId, batchId y jobId;
- evento, stage y versión;
- duración, resultado y errorCode.

Prohibido:

- request/response bodies genéricos;
- contenido/documento/OCR;
- salario y conceptos;
- CUIT/CUIL/DNI completos;
- cookies, tokens, contraseñas y claves;
- códigos OIDC, `state`, `nonce`, PKCE verifier y `sub` del proveedor;
- URL firmada completa;
- labels de métricas con texto libre.

El sanitizer se aplica antes de serializar y se prueba con PII sintética.

La sincronización económica puede registrar código interno de serie, rango, job, duración, conteo y errorCode. Nunca registra monto nominal o derivado, usuario, empleo, documento, PDF, OCR ni body genérico del proveedor.

## IA y proveedores externos

Datos Argentina recibe exclusivamente el identificador de una serie pública, fechas `start`/`end` y opciones técnicas fijas de respuesta. La conversión y el ajuste ocurren dentro de Salarivo: usuario, PII, empleador, salario, documento y OCR nunca forman parte del request. Fuente, atribución y licencia CC BY 4.0 se conservan con la observación.

Por defecto no se envía información Restricted. Una operación habilitada debe:

- tener purpose explícito y consentimiento/configuración correspondiente;
- enviar el fragmento mínimo redactado;
- usar un proveedor evaluado por región, retención, entrenamiento y borrado;
- registrar proveedor, versión, purpose, costo e IDs internos, no el payload;
- respetar budget y timeout;
- permitir deshabilitar el proveedor sin tumbar el producto.

Ejemplo aceptable futuro: interpretar un concepto aislado y pseudonimizado. Enviar el PDF completo a un LLM por conveniencia no es aceptable.

Google recibe únicamente los parámetros y scopes necesarios para autenticar. El canje de código y la validación de tokens ocurren server-side; Salarivo no reutiliza esos tokens para acceder a otros productos de Google ni los conserva para uso posterior.

## Entrenamiento

Documentos, datos salariales y correcciones no se usan para entrenar modelos por defecto. Cualquier aprendizaje futuro usa datos sintéticos o anonimización irreversible; un consentimiento separado, explícito y revocable requiere revisión legal y de producto.

## Entornos y fixtures

Producción no se copia a desarrollo. Tests usan personas, empresas, importes y PDFs sintéticos. Un dump requiere anonimización irreversible y autorización específica antes de salir de producción.

## Comunicación al usuario

La UI puede afirmar sólo lo que la implementación demuestra. Debe explicar de forma comprensible:

- quién controla los datos;
- si se conserva el original;
- para qué se usa un proveedor;
- que Google autentica, pero el UUID y la sesión siguen siendo internos y el email no auto-vincula cuentas;
- cómo eliminar/exportar;
- qué queda temporalmente en backups.
