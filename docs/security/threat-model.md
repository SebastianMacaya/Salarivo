# Threat model

> Estado: Proposed para la arquitectura objetivo. Debe actualizarse con cada nuevo flujo sensible y validarse contra la implementación.

## Alcance

Web, API, Google OIDC, PostgreSQL, cola, workers, object storage, scanner, OCR/IA externa, observabilidad, exports y operaciones de borrado.

## Activos

- PDFs y derivados;
- salarios, conceptos y timeline;
- PII e identificadores fiscales;
- sesiones, credenciales, secretos MFA y recovery codes;
- relaciones `(provider, sub)`, intentos OIDC y códigos/tokens transitorios;
- claves de cifrado y credenciales de proveedores;
- exports y autorizaciones firmadas;
- correcciones humanas y audit trail;
- disponibilidad y presupuesto de procesamiento.

## Atacantes

- visitante externo;
- usuario autenticado malicioso;
- atacante con credenciales robadas;
- insider o soporte con acceso excesivo;
- proveedor/dependencia comprometida;
- archivo diseñado para explotar parsers;
- contenido con prompt injection dirigido a agentes o modelos.

## Trust boundaries

~~~mermaid
flowchart LR
    Internet --> Edge
    Edge --> Web
    Web --> API
    Web -. Authorization Code + PKCE .-> Google[Google OIDC]
    Google -. callback GET .-> API
    Web -. autorización limitada .-> Storage
    API --> DB
    API --> Storage
    Dispatcher --> DB
    Dispatcher --> Queue
    Queue --> Worker
    Storage --> Worker
    Worker --> DB
    Worker --> Sandbox[Parsers / OCR aislados]
    Worker -. datos mínimos .-> Vendor[Proveedor externo]
    API --> Telemetry[Logs / métricas sanitizados]
    Worker --> Telemetry
~~~

Nada que cruce desde Internet, navegador, storage o documento se considera confiable. Un resultado OCR o LLM tampoco es una instrucción ni un dato verificado.

## Amenazas y controles

| Amenaza | Controles requeridos | Verificación |
| --- | --- | --- |
| IDOR / broken access control | ownership server-side en servicio, scopes mínimos, IDs opacos, RLS opcional; el método de login nunca altera el owner UUID | usuario A lee/edita/borra recurso B en combinaciones password/password, Google/Google y password/Google |
| Enumeración / deduplicación lateral | respuestas uniformes, checksum consultado por userId, sin dedup observable global | mismo hash entre usuarios no revela existencia |
| Malware | scanner privado antes de extracción, cuarentena fail closed | archivo de prueba antivirus no avanza |
| Explotación de parser | proceso sin privilegios, filesystem efímero, CPU/RAM/timeouts, sin red ni credenciales | PDF malformado termina sin afectar worker/API |
| JavaScript, adjuntos o acciones PDF | inspección estructural y política deny-active sobre allowlist PDF | fixture activo se rechaza |
| Path traversal | object key generada por servidor, filename sólo metadata, paths temporales internos | filenames con rutas no escapan del sandbox |
| SSRF | worker sin red por defecto, destinos externos allowlisted, no seguir URLs del documento | URLs embebidas nunca se solicitan |
| URL firmada filtrada/reutilizada | TTL breve, método/key/tamaño limitados, autorización previa, no loguear URL | expiración, método incorrecto y otra key fallan |
| Robo de sesión | cookies HttpOnly/Secure/SameSite, validación de Origin, rotación/revocación, MFA de sesión y step-up sensible | sesión revocada, cookie rotada y acción sin step-up |
| Login CSRF, callback replay o intercepción OIDC | Authorization Code + PKCE, `state` y `nonce`; intento breve/de un solo uso ligado por cookie al navegador; callback `GET` sin query string en access logs; validación de issuer/audience/código; redirects internos allowlisted | cookie ausente/ajena, state/nonce/código repetido, PKCE inválido y redirect externo fallan cerrados |
| Account takeover por email o linking confuso | identidad externa sólo por `(provider, sub)`; email no identifica ni auto-vincula; conflicto uniforme sin detalles ante colisión | mismo email en cuenta local y Google no crea vínculo, sesión ni expone detalles de la cuenta |
| Fuga de tokens OAuth | canje server-side; access, refresh e ID tokens sólo en memoria durante la validación y nunca en DB, cookie, URL, logs o auditoría | inspección de persistencia/logs y errores del callback no encuentra tokens, código, nonce ni verifier |
| Bypass de step-up Google-only | nueva autorización con `max_age=0`, purpose y sesión origen en el intento; validación de autenticación reciente; rotación de la sesión al completar | login previo, intento de otra sesión y replay no elevan garantía |
| Usuario externo bloqueado o suspendido | estado interno revalidado antes de emitir/aceptar sesión; `BLOCKED` y `SUSPENDED` fallan cerrados | callback válido del IdP no inicia sesión para ambos estados |
| Credential stuffing | rate limit local por identidad/IP, respuestas uniformes, MFA obligatorio para admin y opcional para usuario | tests de rate limit y enumeración; store distribuido antes de múltiples réplicas |
| XSS desde documento/OCR | nunca renderizar HTML; output como texto escapado; CSP | payload OCR no ejecuta código |
| DoS de CPU/RAM/storage/DB | límites tempranos, streaming, lote activo único, cuotas, timeout, backpressure y máximo local de dos exports | lote/archivo excesivo se rechaza antes de emitir uploads y la concurrencia por usuario no agota workers ni pool DB |
| Ataque económico OCR/LLM | clasificación barata, budget por documento/user/batch, LLM último | batch inválido no dispara OCR/LLM masivo |
| Monopolio de workers | concurrencia global y por usuario, fairness | usuario grande no bloquea uno pequeño |
| Mensajes duplicados/retries | idempotency keys, constraints y state transitions transaccionales | delivery duplicado produce un resultado |
| Fuga por logs/APM | sanitizer central, allowlist de campos, redacción en errores/traces | test captura logs y busca PII sintética |
| Secretos expuestos | secret manager, rotación, scanning y no incluirlos en imágenes/repositorio | secret scanning y revisión de config |
| Insider | least privilege, acceso just-in-time, auditoría, separación de funciones | revisión periódica de accesos y eventos |
| Escalamiento a admin | rol sólo en DB, nunca desde body/cookie; guard server-side en cada ruta; respuestas agregadas sin PII ni salarios | registro con `role` falla, USER recibe 403 y revocación aplica al siguiente request |
| Reidentificación en benchmark futuro | feature apagada; antes de habilitar: cohortes amplias predefinidas, k mínimo, redondeo, demora, anti-differencing, query budget, mitigación Sybil/poisoning y opt-in separado | ataques de membership inference y consultas diferenciales no recuperan aportes individuales |
| Supply chain | lockfile, versiones evaluadas, SCA/SAST, imágenes/versiones reproducibles | scans bloqueantes y actualización controlada |
| Borrado incompleto | orquestación idempotente sobre DB/storage/cache/cola/temporales/backups; marcador de ejecución hasta limpiar temporales | prueba de account deletion, job activo y reconciliación |
| Prompt injection / exfiltración IA | documentos como datos, prompts fijos, tool allowlist, minimización/redacción, sin secretos | fixture con órdenes no cambia flujo ni herramientas |

## Riesgos de privacidad específicos

- El original contiene más datos que los necesarios para analytics.
- Un error puede incluir OCR o metadata sensible.
- Un proveedor externo puede retener payload.
- El IdP conoce cada autenticación Google; Salarivo minimiza scopes y no usa el email para correlacionar cuentas locales.
- Una métrica con labels libres puede filtrar salario o identidad.
- Un export o share puede sobrevivir a una revocación si no se coordina el cleanup.

Por defecto se minimiza payload, se evita IA externa y se separa el lifecycle del original. Cualquier proveedor requiere evaluación de retención, región, entrenamiento, subprocesadores y borrado antes de producción.

## Alertas mínimas

- incrementos anormales de uploads/rechazos;
- detección de malware;
- múltiples fallos de ownership o enumeración;
- anomalías sanitizadas de intentos/callbacks OIDC, colisiones y replays;
- retries y timeouts crecientes;
- profundidad de cola sostenida;
- OCR/proveedor degradado;
- cuota o storage cerca del límite;
- fallos de eliminación;
- marcadores de ejecución huérfanos que bloquean una baja;
- errores de sanitizer o secret scan.

Las alertas sólo incluyen IDs internos y códigos.

## Riesgos abiertos

- Proceso operativo de alta, recuperación y revocación para administradores.
- Validación operativa de Google OIDC y rotación del client secret antes de producción; la versión legal inicial 1.0 ya fue aprobada para la instancia privada.
- Rate limit compartido y configuración probada de proxy/IP antes de escalar la API a múltiples réplicas.
- Auditoría durable y alertas sanitizadas para intentos MFA denegados o bloqueados.
- Alerta y procedimiento verificado para recuperar un `execution_owner` huérfano sin borrar temporales de un proceso vivo.
- Proveedor cloud, región y KMS.
- Parser PDF y perfil exacto de sandbox.
- SLA, budgets y límites numéricos.
- Plazos legales de retención y backup.
- Condiciones contractuales de OCR/IA.

Ninguno puede marcarse como mitigado hasta existir configuración, test y evidencia operativa.

## Cuándo actualizar

Actualizar este archivo al agregar un tipo documental, proveedor, flujo de descarga/export/share, privilegio, superficie de red, parser, feature de IA o cambio de retención. Una amenaza nueva material puede requerir ADR.
