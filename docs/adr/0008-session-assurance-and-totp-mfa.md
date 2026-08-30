# ADR 0008 — Garantía de sesión y MFA TOTP

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

Una sesión robada no debe bastar para administrar Salarivo ni para exportar, descargar o destruir datos salariales. Un booleano guardado en el navegador tampoco demuestra qué sesión completó el segundo factor.

## Decisión

- La garantía pertenece a la sesión exacta y distingue autenticación primaria, MFA verificado y `STEP_UP` breve.
- Los administradores deben tener MFA activo y verificarlo en cada sesión. Un usuario sin MFA confirma las acciones sensibles con una nueva autorización de la misma cuenta Google, ligada a su sesión; Google no ofrece reautenticación forzada. Si habilitó MFA usa TOTP o un recovery code.
- TOTP usa 6 dígitos, período de 30 segundos, ventana de ±1 y contador de último uso bloqueado en PostgreSQL para impedir replay.
- El primer enrolamiento sólo se inicia desde la sesión primaria creada en los últimos 15 minutos, sin una segunda autorización Google. Si venció esa frescura se exige cerrar sesión y volver a ingresar. El enrolamiento es pendiente, vence y queda ligado a la sesión exacta que lo inició; reemplazar un factor activo sí exige step-up y el anterior no cambia hasta validar el nuevo.
- El secreto se cifra con AES-256-GCM, nonce aleatorio, AAD ligada a usuario/factor y keyring versionado. Producción falla al arrancar sin una clave válida.
- Los diez recovery codes aleatorios se muestran una vez y persisten sólo como hashes de un uso.
- Elevar garantía, regenerar códigos, reemplazar o desactivar MFA rota el token de la sesión; los cambios de seguridad revocan las otras sesiones. Cambios MFA, acciones destructivas, claim de export y autorización de descarga de original vuelven a bloquear y validar esa sesión dentro de su transacción.
- Una verificación exitosa vuelve a cifrar el secreto con la clave activa si todavía usa una versión anterior.
- No se implementan SMS, dispositivos recordados, preguntas de seguridad ni bypass administrativo.

## Consecuencias

Las acciones sensibles requieren una verificación reciente y una sesión robada pierde utilidad después de rotaciones o revocaciones. Un proceso operativo de recuperación excepcional sigue siendo una decisión separada; no se debilita MFA para cubrirlo.

## Evidencia

- Migraciones `006_mfa_and_session_assurance.sql` y `010_bind_mfa_enrollment_to_session.sql`.
- `apps/api/src/mfa.ts` y `apps/api/src/mfa-routes.ts`.
- Tests unitarios de vectores TOTP, replay, cifrado/AAD y recovery codes.
- Integración de enrolamiento, desafío de login, bloqueo de admin, rotación de cookie, revocación de otra sesión y step-up.
