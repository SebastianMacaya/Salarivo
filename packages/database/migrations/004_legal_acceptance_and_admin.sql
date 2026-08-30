ALTER TABLE users
    ADD COLUMN role text NOT NULL DEFAULT 'USER'
        CHECK (role IN ('USER', 'ADMIN'));

CREATE TABLE legal_document_versions (
    id uuid PRIMARY KEY,
    document_type text NOT NULL
        CHECK (document_type IN ('TERMS', 'PRIVACY_NOTICE')),
    version text NOT NULL,
    locale text NOT NULL DEFAULT 'es-AR',
    title text NOT NULL,
    content text NOT NULL,
    published_at timestamptz NOT NULL,
    effective_at timestamptz NOT NULL,
    requires_acceptance boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_type, version, locale),
    CHECK (version ~ '^[0-9]+[.][0-9]+$'),
    CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
    CHECK (length(title) BETWEEN 3 AND 160),
    CHECK (length(content) BETWEEN 100 AND 50000)
);

CREATE INDEX legal_document_versions_current_idx
    ON legal_document_versions (document_type, locale, effective_at DESC, published_at DESC);

CREATE TABLE legal_acceptances (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES legal_document_versions(id) ON DELETE RESTRICT,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, document_version_id)
);

CREATE INDEX legal_acceptances_version_idx
    ON legal_acceptances (document_version_id, accepted_at);

INSERT INTO legal_document_versions (
    id, document_type, version, locale, title, content, published_at, effective_at, requires_acceptance
) VALUES
(
    '00000000-0000-4000-8000-000000000041',
    'TERMS',
    '1.0',
    'es-AR',
    'Términos de uso de Salarivo',
    $terms$BORRADOR PARA REVISIÓN LEGAL ANTES DE PRODUCCIÓN

1. Servicio. Salarivo permite cargar recibos de sueldo en PDF, extraer información, corregirla y construir un historial laboral y salarial privado. Los resultados automáticos pueden contener errores y deben revisarse antes de tomar decisiones.

2. Cuenta. Debés brindar datos correctos, proteger tu contraseña y usar el servicio sólo sobre documentos que estés autorizado a tratar. No podés intentar acceder a cuentas ajenas, eludir límites ni afectar la disponibilidad o seguridad del servicio.

3. Tus documentos y datos. Conservás la titularidad de lo que cargás. Autorizás a Salarivo a almacenarlo y procesarlo únicamente para prestarte las funciones que solicitás, proteger el servicio y cumplir tus elecciones de conservación, exportación o eliminación.

4. Privacidad. Salarivo no publica ni vende tus recibos, salarios o datos personales, y no los comparte con otros usuarios. La infraestructura y los proveedores técnicos que resulten necesarios para operar el servicio sólo podrán tratar la información mínima bajo controles contractuales y de seguridad. El Aviso de Privacidad explica el alcance.

5. Mejora del servicio. Salarivo puede usar métricas técnicas y operativas minimizadas que no contengan PDFs, OCR completo, salarios reales ni PII completa para corregir fallos, seguridad y rendimiento. Tus recibos, extracciones y correcciones no se usan para entrenar modelos por defecto. Una futura comparación salarial basada en datos de usuarios requerirá una adhesión opcional, específica, separada y revocable; esa función no está habilitada.

6. Límites y disponibilidad. El servicio puede aplicar límites de archivos, almacenamiento, frecuencia y procesamiento para proteger a todas las cuentas. Un cambio de plan o cupo no autoriza el borrado silencioso de tus datos. El MVP local no ofrece garantía de disponibilidad ni reemplaza asesoramiento laboral, contable, previsional o impositivo.

7. Cierre. Podés exportar tus datos y solicitar la eliminación de tu cuenta desde la aplicación. Salarivo puede suspender una cuenta ante abuso o riesgo de seguridad, preservando los mecanismos de exportación y eliminación que correspondan.

8. Vigencia y cambios. Esta versión rige desde la fecha indicada. Las versiones nuevas se publican como registros separados; si un cambio requiere nueva aceptación, se solicitará de forma explícita.$terms$,
    '2026-08-29T03:00:00Z',
    '2026-08-29T03:00:00Z',
    true
),
(
    '00000000-0000-4000-8000-000000000042',
    'PRIVACY_NOTICE',
    '1.0',
    'es-AR',
    'Aviso de privacidad de Salarivo',
    $privacy$BORRADOR PARA REVISIÓN LEGAL ANTES DE PRODUCCIÓN

Responsable y contacto. Salarivo es un MVP local sin despliegue comercial. Antes de producción deben completarse la identidad, domicilio y canal real del responsable de la base de datos. No uses este borrador como política final de un servicio publicado.

Datos tratados. La cuenta usa email, nombre opcional, credenciales protegidas y sesiones. Al usar el producto se tratan los PDFs que elegís cargar, sus metadatos, texto extraído, empleadores, empleos, períodos, importes, conceptos, correcciones, preferencias de conservación y eventos técnicos de seguridad. No se solicitan datos de terceros fuera de los que ya contenga un documento autorizado.

Finalidades. Los datos se usan para autenticarte; recibir y validar archivos; detectar malware; extraer, organizar y mostrar tu historial; permitir correcciones, exportación y eliminación; prevenir fraude, abuso y fallos; y operar límites técnicos. No se usan para publicidad ni para entrenar modelos por defecto.

Destinatarios. Tus recibos, salarios y datos personales no se muestran a otros usuarios ni se venden. En producción, proveedores de infraestructura, almacenamiento, seguridad u OCR sólo podrán recibir lo estrictamente necesario para operar la función, luego de evaluar contrato, retención, región, subprocesadores y eliminación. Actualmente no hay comparación comunitaria de salarios.

Comparación salarial futura. Si se incorpora, requerirá una adhesión separada, opcional y revocable. No se incluirán PDFs, OCR, identidad ni empleador en los resultados y no perderás las funciones centrales por no participar. Este aviso no otorga esa autorización.

Conservación y seguridad. Los originales y los datos estructurados tienen ciclos de vida separados. Podés borrar sólo el PDF o el documento y sus datos, y podés solicitar la eliminación de la cuenta. Los temporales y exportaciones usan vencimientos; los plazos definitivos de backups deben definirse y comunicarse antes de producción. Se aplican controles de acceso por cuenta, claves opacas, validación de archivos, procesamiento asíncrono y minimización de logs.

Tus decisiones y derechos. Desde la aplicación podés consultar y corregir la información estructurada, exportarla y solicitar su eliminación. Antes de producción se publicará un canal para ejercer los derechos de información, acceso, rectificación, actualización y supresión, además de los datos del responsable.

Cambios. Cada versión se conserva de forma inmutable con su fecha de vigencia. La aplicación registra qué versión se mostró y fue confirmada al crear la cuenta.$privacy$,
    '2026-08-29T03:00:00Z',
    '2026-08-29T03:00:00Z',
    false
);
