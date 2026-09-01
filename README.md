# Salarivo

Aplicación privada para convertir recibos de sueldo en un historial salarial y laboral estructurado, verificable y controlado por su dueño.

> Estado operativo (2026-09-01): Salarivo está desplegado en producción en [www.salarivo.cloud](https://www.salarivo.cloud/) con web, API, worker, PostgreSQL y object storage privado activos. Existen múltiples cuentas activas de personas reales. Esta evidencia reemplaza el estado anterior de preview frontend/local-only, pero no constituye certificación de seguridad ni de cumplimiento legal y no cierra por sí sola los P0 documentados.
>
> Brecha legal conocida: los Términos y el Aviso 1.0 que hoy registran aceptaciones fueron aprobados para una instancia privada de una única persona y contienen afirmaciones que ya no describen la operación multiusuario actual. Como son append-only, no deben reescribirse retroactivamente: hace falta una versión nueva aprobada para producción, revisión profesional y reaceptación cuando corresponda. Ver [Políticas legales](docs/legal/policies.md) y la [actualización de la auditoría](docs/security/privacy-security-audit-2026-08-30.md).

## Qué funciona

- alta e inicio de sesión exclusivamente con Google y aceptación legal versionada, onboarding, logout y gestión owner-only de sesiones activas con revocación individual o masiva;
- empleadores y empleos;
- lotes persistentes de uno o muchos PDFs con upload directo privado;
- ownership, idempotencia, límites, expiración y cleanup;
- validación PDF, ClamAV, rechazo de contenido activo, clasificación y OCR acotado;
- extracción determinística de recibos argentinos, campos trazables, importes remunerativos/no remunerativos, liquidación, reintegros y conceptos;
- visor PDF privado por página, evidencia espacial, confirmación de tipo, correcciones humanas y recuperación versionada con comparación/promoción segura;
- historial salarial derivado con resumen, evolución, análisis anual y comparación por empleo y moneda;
- navegación contextual entre cada empleo, su historial y sus documentos, con el contexto recuperable desde la URL;
- modo privacidad visual global para enmascarar importes y porcentajes en la interfaz autenticada, con advertencia antes de abrir el PDF original sin censurar;
- detección no persistida de empleos a partir de recibos sin asociar, siempre sujeta a confirmación;
- borrado separado de original o documento completo;
- MFA TOTP, recovery codes y step-up de acciones sensibles; MFA obligatorio para administración;
- exportación JSON legible de los datos de la persona, sin IDs internos ni metadata operativa, y eliminación durable de cuenta con constancia consultable;
- páginas públicas de Términos/Privacidad y consola admin granular con metadata operativa, comandos acotados y auditoría append-only;
- reglas para agentes y mejora supervisada en [AGENTS.md](AGENTS.md).

El MVP no usa LLM ni datos reales para entrenar modelos. Soporta recibos argentinos y produce como máximo una liquidación por PDF; ampliar tipos, países o múltiples liquidaciones exige fixtures y tests nuevos.

El historial `salary-analytics-v1` usa únicamente la corrida activa explícita de documentos `COMPLETED`; un resultado pendiente de revisión y un reproceso pendiente, fallido o dudoso no alteran los cálculos. El salario comparable inicial es sólo el básico de una liquidación `NORMAL` recurrente dentro de un contexto laboral y una moneda; ante falta o ambigüedad devuelve N/D y, si existe una recuperación compatible, la UI lo informa sin inventar un monto. Un segundo upload con el mismo SHA-256 del mismo titular se descarta por completo; los posibles duplicados estructurales siguen siendo advertencias para revisión, nunca borrados automáticos.

Google se integra mediante OIDC Authorization Code con PKCE, `state` y `nonce`. La cuenta conserva su UUID y sus sesiones opacas internas: `auth_accounts` relaciona `(provider, sub)` con ese usuario, el email de Google no identifica ni auto-vincula cuentas y no se persisten access, refresh ni ID tokens. El callback es `GET`, sólo admite redirects internos allowlisted y completa el alta en un segundo paso atómico junto con la aceptación legal. No existen rutas de login, registro o recuperación por contraseña. El primer factor TOTP se inicia desde una sesión primaria creada en los últimos 15 minutos, sin otro redirect; el step-up sin MFA usa otra autorización Google con selección explícita de la misma cuenta, ligada a la sesión original, y rota esa sesión al completarse. Ver [ADR 0010](docs/adr/0010-google-oidc-and-external-identities.md).

La gestión de sesiones muestra únicamente categoría de dispositivo, navegador y sistema operativo inferidos en forma gruesa al iniciar sesión, junto con creación, última actividad y vencimiento. No persiste user-agent crudo, versión, IP, ubicación, fingerprint ni nombre del dispositivo.

## Estructura

- `apps/web`: interfaz React/Vinext.
- `apps/api`: API Fastify bajo `/api/v1`.
- `apps/worker-documents`: dispatcher, reconciliadores y pipeline pesado.
- `packages/database`: migración PostgreSQL y transacciones compartidas.
- `docs`: alcance, arquitectura, seguridad, privacidad y ADR.

## Preparación local

Requiere Node.js 24+, npm y Docker Desktop. Los servicios sólo publican puertos en `127.0.0.1`.

~~~powershell
Copy-Item .env.example .env
npm install
docker compose --profile processing up -d
docker compose --profile processing ps
~~~

La API y el worker aplican la migración automáticamente. ClamAV puede tardar en quedar listo la primera vez mientras descarga firmas.

Para desarrollo local, la web se ejecuta aparte:

~~~powershell
npm run dev:web
~~~

Abrí `http://localhost:3000`. La web local llama a `http://localhost:3001/api/v1`; para otro entorno definí `NEXT_PUBLIC_API_BASE_URL` y el origen exacto de las URLs firmadas en `NEXT_PUBLIC_STORAGE_ORIGIN` al compilar.

La configuración de Google usa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_OAUTH_REDIRECT_URI`.

El rol `ADMIN` nunca se acepta desde registro ni desde la web. Antes de promover una cuenta local debe estar activa y tener MFA habilitado. El primer `SUPER_ADMIN` se provisiona fuera de la API mediante PostgreSQL; no expongas ese acceso de base de datos en producción:

~~~powershell
docker compose exec postgres psql -U salarivo -d salarivo -c "UPDATE users SET role = 'ADMIN', admin_role = 'SUPER_ADMIN', updated_at = now() WHERE email = 'tu-email@example.com' AND role = 'USER' AND status = 'ACTIVE' AND EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = users.id AND status = 'ACTIVE');"
~~~

La versión legal 1.0 sigue cerrada y vigente, pero su aprobación para una vista privada individual ya no cubre el uso multiusuario actual. No se corrige editando el texto aceptado: requiere una versión nueva con identidad, domicilio, canal, destinatarios/proveedores, retención y operación de derechos acordes al servicio real, además de revisión profesional y reaceptación cuando corresponda.

Para detener todo sin borrar los volúmenes:

~~~powershell
docker compose --profile processing down
~~~

Las credenciales de `.env.example` son exclusivamente locales. Antes de cualquier VPS hay que definir secretos, TLS, cifrado y backups reales; no reutilices esos valores.

## Despliegue

Producción se construye desde `main` en tres aplicaciones separadas de Coolify: `salarivo-main`, `salarivo-api` y `salarivo-worker-documents`. El repositorio usa un único webhook manual de GitHub para eventos `push`; las tres aplicaciones comparten su secreto en Coolify y tienen Auto Deploy habilitado. CI valida el código, pero no reemplaza esos despliegues. Las URLs y los secretos de webhook se configuran sólo en Coolify y GitHub, nunca en este repositorio.

La API usa en Coolify un healthcheck de tipo `Container command`: `curl --fail --silent --show-error http://127.0.0.1:3001/health`. La API y el worker ejecutan las migraciones y validan la política privada de R2 al iniciar; su CORS y lifecycle deben conservar el contrato de [seguridad de upload](docs/security/file-upload.md).

Un despliegue se considera completo únicamente cuando:

- las tres aplicaciones muestran el mismo commit completo de `main`;
- la base tiene aplicada la migración más reciente de `packages/database/migrations`;
- la API está saludable y una ruta autenticada sin sesión responde `401`, no `404`;
- el worker está ejecutándose sin errores de inicio;
- la vista principal funciona en un smoke test autenticado.

Si una aplicación queda en un commit anterior, hay que redesplegarla y corregir su webhook antes de dar el cambio por terminado. Esta mecánica acredita el estado operativo del despliegue, no el cierre de los riesgos legales, de privacidad, backups, aislamiento y operación que siguen abiertos en producción.

## Verificación

~~~powershell
npm run typecheck
npm run lint
npm test
npm run build --workspace @salarivo/web
docker compose --profile processing --env-file .env.example config --quiet
git diff --check
~~~

La prueba de integración requiere PostgreSQL, Redis y MinIO locales:

~~~powershell
npm run test:integration
~~~

## Documentación

- [Alcance](docs/product-scope.md)
- [Arquitectura](docs/architecture/overview.md)
- [Pipeline de ingestión](docs/architecture/ingestion-pipeline.md)
- [Modelo de dominio](docs/architecture/domain-model.md)
- [Consola administrativa](docs/architecture/admin-console.md)
- [Threat model](docs/security/threat-model.md)
- [Auditoría de privacidad y seguridad 2026-08-30](docs/security/privacy-security-audit-2026-08-30.md)
- [Seguridad de upload](docs/security/file-upload.md)
- [Clasificación de datos](docs/privacy/data-classification.md)
- [Retención](docs/privacy/data-retention.md)
- [Políticas legales](docs/legal/policies.md)
- [Google OIDC e identidades externas](docs/adr/0010-google-oidc-and-external-identities.md)
- [Consola administrativa granular](docs/adr/0012-granular-admin-console.md)
- [ADRs](docs/adr/README.md)
