# Salarivo

Aplicación privada para convertir recibos de sueldo en un historial salarial y laboral estructurado, verificable y controlado por su dueño.

> Estado: MVP local implementado. Existe una vista previa `owner-only` del frontend en Sites; no existe todavía un backend de producción apto para datos reales ni debe usarse esa vista con datos reales.

## Qué funciona

- alta e inicio de sesión exclusivamente con Google y aceptación legal versionada, onboarding, logout y revocación de otras sesiones;
- empleadores y empleos;
- lotes persistentes de uno o muchos PDFs con upload directo privado;
- ownership, idempotencia, límites, expiración y cleanup;
- validación PDF, ClamAV, rechazo de contenido activo, clasificación y OCR acotado;
- extracción determinística de recibos argentinos, campos trazables, importes remunerativos/no remunerativos, liquidación, reintegros y conceptos;
- confirmación de tipo, correcciones humanas y un historial salarial derivado con resumen, evolución, análisis anual y comparación por empleo y moneda;
- detección no persistida de empleos a partir de recibos sin asociar, siempre sujeta a confirmación;
- borrado separado de original o documento completo;
- MFA TOTP, recovery codes y step-up de acciones sensibles; MFA obligatorio para administración;
- exportación JSON completa y eliminación durable de cuenta con constancia consultable;
- páginas públicas de Términos/Privacidad y consola admin granular con metadata operativa, comandos acotados y auditoría append-only;
- reglas para agentes y mejora supervisada en [AGENTS.md](AGENTS.md).

El MVP no usa LLM ni datos reales para entrenar modelos. Soporta recibos argentinos y produce como máximo una liquidación por PDF; ampliar tipos, países o múltiples liquidaciones exige fixtures y tests nuevos.

El historial `salary-analytics-v1` usa únicamente documentos `COMPLETED`; los `NEEDS_REVIEW` quedan informados pero fuera de los cálculos. El salario comparable inicial es sólo el básico de una liquidación `NORMAL` recurrente dentro de un contexto laboral y una moneda; ante falta o ambigüedad devuelve N/D. Los posibles duplicados estructurados son advertencias para revisión, nunca borrados automáticos.

Google se integra mediante OIDC Authorization Code con PKCE, `state` y `nonce`. La cuenta conserva su UUID y sus sesiones opacas internas: `auth_accounts` relaciona `(provider, sub)` con ese usuario, el email de Google no identifica ni auto-vincula cuentas y no se persisten access, refresh ni ID tokens. El callback es `GET`, sólo admite redirects internos allowlisted y completa el alta en un segundo paso atómico junto con la aceptación legal. No existen rutas de login, registro o recuperación por contraseña. El primer factor TOTP se inicia desde una sesión primaria creada en los últimos 15 minutos, sin otro redirect; el step-up sin MFA usa otra autorización Google con selección explícita de la misma cuenta, ligada a la sesión original, y rota esa sesión al completarse. Ver [ADR 0010](docs/adr/0010-google-oidc-and-external-identities.md).

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

Abrí `http://localhost:3000`. La web local llama a `http://localhost:3001/api/v1`; para otro entorno definí `NEXT_PUBLIC_API_BASE_URL` al compilar.

La configuración de Google usa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_OAUTH_REDIRECT_URI`.

El rol `ADMIN` nunca se acepta desde registro ni desde la web. Antes de promover una cuenta local debe estar activa y tener MFA habilitado. El primer `SUPER_ADMIN` se provisiona fuera de la API mediante PostgreSQL; no expongas ese acceso de base de datos en producción:

~~~powershell
docker compose exec postgres psql -U salarivo -d salarivo -c "UPDATE users SET role = 'ADMIN', admin_role = 'SUPER_ADMIN', updated_at = now() WHERE email = 'tu-email@example.com' AND role = 'USER' AND status = 'ACTIVE' AND EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = users.id AND status = 'ACTIVE');"
~~~

La versión legal 1.0 está cerrada y aprobada por el titular para esta vista privada de uso individual y es la primera vigente para el alta exclusiva con Google. Ninguna aprobación equivale a una revisión profesional ni habilita acceso de terceros; esa ampliación requiere una versión nueva con identidad, domicilio, canal y operación legal acordes al servicio real.

Para detener todo sin borrar los volúmenes:

~~~powershell
docker compose --profile processing down
~~~

Las credenciales de `.env.example` son exclusivamente locales. Antes de cualquier VPS hay que definir secretos, TLS, cifrado y backups reales; no reutilices esos valores.

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
