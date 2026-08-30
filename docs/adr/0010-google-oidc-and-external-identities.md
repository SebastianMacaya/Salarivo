# ADR 0010 — Google OIDC e identidades externas

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

Salarivo ya autoriza todos los recursos privados mediante un UUID interno y sesiones opacas propias. Agregar Google como método de acceso no debe crear una segunda frontera de ownership, convertir un email mutable en identidad ni entregar el ciclo de sesión de la aplicación al proveedor. El redirect OAuth, el callback y los tokens también agregan riesgos de login CSRF, replay, intercepción, open redirect y account takeover por vinculación ambigua.

El alta conserva además la regla del ADR 0007: no existe una cuenta activa antes de aceptar los Términos vigentes y confirmar el Aviso de Privacidad en una operación atómica. Las acciones sensibles conservan la garantía de sesión del ADR 0008.

## Decisión

- Google se integra con OpenID Connect Authorization Code, PKCE, `state` y `nonce`. El callback es `GET`; el canje y la validación de issuer, audience y claims ocurren server-side.
- Cada inicio conserva un intento breve, de un solo uso y ligado al navegador por cookie. También liga el propósito; el servidor no acepta un destino del cliente y sólo emite resultados internos allowlisted después del callback.
- `auth_accounts` relaciona el UUID interno con una identidad única `(provider, sub)`. `sub` identifica la cuenta Google; el email es un atributo, no una clave de login o linking. Una colisión de email nunca auto-vincula, modifica ni revela detalles de la cuenta existente.
- No se persisten access, refresh ni ID tokens. Se descartan después del canje y validación porque Salarivo no consume otras APIs de Google.
- Una identidad ya relacionada y un User activo reciben la misma sesión opaca interna que el login local. `BLOCKED` y `SUSPENDED` fallan cerrados incluso ante un callback válido.
- Una identidad nueva queda como intento de registro verificado sin crear User ni sesión. En el segundo paso, el servidor vuelve a resolver las versiones legales y crea User, acknowledgements, AuthAccount, Session y AuditEvent en una sola transacción, con onboarding todavía pendiente.
- Una cuenta Google-only completa step-up mediante otra autorización con `max_age=0`, ligada a la sesión y al propósito originales. Al completarse rota la sesión. Revocar otras sesiones conserva sólo la actual.
- El método de autenticación no cambia ningún guard ni consulta de ownership: documentos, empleos, imports, liquidaciones, analytics, exports, storage, OCR y privacidad siguen autorizados exclusivamente por el UUID de la sesión.
- La configuración se limita a `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_OAUTH_REDIRECT_URI`.
- La versión legal inicial 1.0 fue aprobada expresamente para la instancia privada. El alta local por email y contraseña queda deshabilitada y las cuentas nuevas usan Google; el login local se conserva sólo para cuentas existentes. Esta integración no levanta el NO-GO para un backend público ni para datos reales.

## Alternativas descartadas

- Usar `sub` o el email como ID de User: acopla el dominio al proveedor y abre colisiones, cambios de email y account takeover.
- Auto-vincular por email verificado: la coincidencia no demuestra control de la cuenta Salarivo preexistente.
- Persistir tokens Google o reemplazar la sesión propia por JWT/cookies de otra librería: amplía secretos, retención y dos modelos de autorización sin una necesidad de APIs Google.
- Crear User dentro del callback y aceptar términos después: deja cuentas activas sin evidencia legal atómica.
- Permitir redirects enviados libremente por el navegador: habilita open redirect y fuga de códigos/estado.

## Consecuencias

Google queda como una credencial externa intercambiable y no como owner del dominio. Password, MFA TOTP y Google convergen en la misma sesión, revocación y autorización; las pruebas IDOR deben cruzar usuarios creados por ambos métodos. Los intentos incompletos requieren TTL y cleanup, mientras que la baja de cuenta debe eliminar cuentas externas, intentos y sesiones junto con el resto de los datos.

No se implementa vinculación automática, acceso a APIs de Google, refresh en background ni un segundo sistema de sesión. Una futura vinculación explícita de métodos necesitará step-up de la cuenta ya autenticada, prueba de control de ambas identidades y una decisión separada si cambia estas garantías.

## Evidencia

La decisión se respalda en la migración de identidades/intentos externos, las rutas y servicios Google integrados con la sesión existente y las pruebas unitarias e integrales de PKCE/`state`/`nonce`, callback, onboarding legal atómico, colisión de email, estados bloqueados, step-up, rotación/revocación y ownership cruzado. La configuración y la UI consumen el mismo flujo sin guardar tokens del proveedor.
