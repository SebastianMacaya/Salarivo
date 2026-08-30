ALTER TABLE users
    DROP CONSTRAINT users_status_check,
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD COLUMN email_verified_at timestamptz,
    ADD COLUMN onboarding_completed_at timestamptz,
    ADD COLUMN last_login_at timestamptz;

UPDATE users AS app_user
   SET onboarding_completed_at = app_user.created_at,
       last_login_at = COALESCE(
           (SELECT max(session.created_at) FROM sessions AS session WHERE session.user_id = app_user.id),
           app_user.created_at
       );

ALTER TABLE users
    ADD CONSTRAINT users_status_check
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETION_PENDING', 'DELETED')),
    ADD CONSTRAINT users_email_verified_at_check
        CHECK (email_verified_at IS NULL OR email_verified_at >= created_at),
    ADD CONSTRAINT users_onboarding_completed_at_check
        CHECK (onboarding_completed_at IS NULL OR onboarding_completed_at >= created_at),
    ADD CONSTRAINT users_last_login_at_check
        CHECK (last_login_at IS NULL OR last_login_at >= created_at);

CREATE TABLE auth_accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    UNIQUE (provider, provider_account_id),
    UNIQUE (user_id, provider),
    CHECK (provider ~ '^[A-Z][A-Z0-9_]{0,31}$'),
    CHECK (length(provider_account_id) BETWEEN 1 AND 255),
    CHECK (updated_at >= created_at),
    CHECK (last_login_at IS NULL OR last_login_at >= created_at)
);

CREATE INDEX auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE oauth_attempts (
    id uuid PRIMARY KEY,
    browser_token_hash text NOT NULL UNIQUE,
    state_hash text NOT NULL UNIQUE,
    provider text NOT NULL CHECK (provider = 'GOOGLE'),
    purpose text NOT NULL CHECK (purpose IN ('LOGIN', 'STEP_UP')),
    user_id uuid,
    session_id uuid,
    pkce_verifier text NOT NULL,
    nonce text NOT NULL,
    status text NOT NULL DEFAULT 'STARTED'
        CHECK (status IN ('STARTED', 'EXCHANGING', 'IDENTITY_VERIFIED')),
    pending_subject text,
    pending_email text,
    pending_display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
    FOREIGN KEY (user_id, session_id)
        REFERENCES sessions(user_id, id) MATCH FULL ON DELETE CASCADE,
    CHECK (browser_token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    CHECK (pkce_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
    CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
    CHECK ((purpose = 'STEP_UP') = (user_id IS NOT NULL AND session_id IS NOT NULL)),
    CHECK (
        (status = 'IDENTITY_VERIFIED'
            AND pending_subject IS NOT NULL
            AND pending_email IS NOT NULL)
        OR (status IN ('STARTED', 'EXCHANGING')
            AND pending_subject IS NULL
            AND pending_email IS NULL
            AND pending_display_name IS NULL)
    ),
    CHECK (pending_subject IS NULL OR length(pending_subject) BETWEEN 1 AND 255),
    CHECK (
        pending_email IS NULL
        OR (pending_email = lower(pending_email) AND length(pending_email) BETWEEN 3 AND 320)
    ),
    CHECK (pending_display_name IS NULL OR length(pending_display_name) BETWEEN 1 AND 120),
    CHECK (updated_at >= created_at),
    CHECK (expires_at = created_at + interval '10 minutes')
);

CREATE INDEX oauth_attempts_expiry_idx ON oauth_attempts (expires_at);
CREATE INDEX oauth_attempts_step_up_idx
    ON oauth_attempts (user_id, session_id, created_at DESC)
    WHERE purpose = 'STEP_UP';

INSERT INTO legal_document_versions (
    id, document_type, version, locale, title, content,
    published_at, effective_at, requires_acceptance, approved_for_production
) VALUES
(
    '00000000-0000-4000-8000-000000000131',
    'TERMS',
    '1.2',
    'es-AR',
    'Términos de uso de Salarivo — acceso privado individual',
    $terms$1. Alcance y aceptación

Estos Términos rigen exclusivamente la instancia privada e individual de Salarivo. La persona titular que administra la instancia es su única usuaria autorizada. Esta versión no autoriza ofrecer acceso a terceros, prestar servicios a otras personas ni tratar documentos ajenos sin autorización. Al crear una cuenta o usar Salarivo aceptás estos Términos y el Aviso de Privacidad vigente.

2. Función del servicio

Salarivo permite cargar recibos de sueldo en PDF, validar su formato, extraer información, corregirla, organizar empleos y construir un historial salarial privado. Un documento es una fuente y los resultados automáticos son auxiliares: pueden contener errores y requieren tu revisión.

3. Uso autorizado

Sólo podés cargar documentos propios o que estés legalmente autorizado a tratar. No podés compartir la cuenta, probar credenciales ajenas, eludir controles, introducir malware, sobrecargar el servicio ni usarlo para vigilar, perfilar o tomar decisiones sobre terceros. El uso debe respetar la ley argentina y los derechos de otras personas.

4. Cuenta y seguridad

Debés mantener datos de cuenta correctos, proteger el método de acceso que elijas, proteger los códigos de recuperación y activar el segundo factor cuando esté disponible. Si elegís continuar con Google, Salarivo solicita únicamente los alcances openid, email y profile para validar tu identidad y no persiste access tokens, refresh tokens ni ID tokens. Toda actividad realizada con una sesión válida se presume propia hasta que informes o detectes un compromiso. Salarivo puede cerrar sesiones, exigir una nueva verificación o suspender temporalmente operaciones ante riesgo de seguridad.

5. Titularidad y autorización técnica

Conservás la titularidad y los derechos sobre tus documentos y datos. Otorgás una autorización limitada, no exclusiva y revocable para almacenarlos, analizarlos, transformarlos y mostrarlos sólo en la medida necesaria para ejecutar las funciones que solicitás, proteger la instancia y aplicar tus decisiones de conservación, exportación o eliminación. Esa autorización no permite vender, publicar ni explotar comercialmente tu información.

6. Privacidad y usos excluidos

Los recibos, salarios, OCR, extracciones y correcciones no se comparten con otros usuarios, no se usan para publicidad y no se usan para entrenar modelos. No existe una función comunitaria de comparación salarial ni una autorización implícita para crearla. El Aviso de Privacidad describe los tratamientos aplicables.

7. Resultados y decisiones

Salarivo no emite certificaciones oficiales y no reemplaza al recibo original ni al asesoramiento laboral, contable, previsional, impositivo, financiero o jurídico. Debés contrastar cualquier dato importante con la fuente y con un profesional cuando corresponda. No tomes decisiones que produzcan efectos sobre terceros basándote únicamente en una extracción automática.

8. Límites, mantenimiento y disponibilidad

La instancia puede aplicar límites de tamaño, cantidad, almacenamiento, frecuencia y procesamiento para preservar seguridad e integridad. Puede interrumpirse por mantenimiento, incidentes, fallos del proveedor o fuerza mayor. No se garantiza disponibilidad ininterrumpida ni ausencia total de errores, pero una interrupción no autoriza el borrado silencioso de tus datos.

9. Exportación, eliminación y cierre

Podés exportar tus datos y solicitar desde la aplicación la eliminación de un original, de un documento con sus datos o de la cuenta. Algunas eliminaciones son asíncronas para confirmar el borrado de objetos privados. La constancia de baja permite consultar el resultado sin conservar email, salarios ni documentos. Una eliminación no se revierte.

10. Responsabilidad

En la máxima medida permitida por la ley, Salarivo y el responsable de la instancia no responden por decisiones tomadas sin verificar los resultados, por pérdida derivada del uso contrario a estos Términos, por credenciales expuestas por la persona usuaria ni por daños indirectos o pérdida de oportunidad. Esta cláusula no excluye responsabilidad que la ley no permita limitar, ni afecta derechos inderogables.

11. Suspensión y terminación

El acceso puede suspenderse o terminarse ante abuso, riesgo técnico, incumplimiento o imposibilidad de operar de forma segura. Cuando la seguridad y la ley lo permitan, se conservarán las vías de exportación y eliminación. La persona titular puede dejar de usar la instancia y cerrar su cuenta en cualquier momento.

12. Versiones, ley aplicable y jurisdicción

Cada versión se conserva de forma inmutable con su fecha de vigencia. Una versión nueva sólo queda vinculada a una aceptación expresa y no altera la constancia de versiones anteriores. Se aplica la ley de la República Argentina. Cualquier controversia corresponde a los tribunales legalmente competentes, sin desplazar fueros ni derechos inderogables.$terms$,
    '2026-08-30T12:30:00Z',
    '2026-08-30T12:30:00Z',
    true,
    true
),
(
    '00000000-0000-4000-8000-000000000132',
    'PRIVACY_NOTICE',
    '1.2',
    'es-AR',
    'Aviso de privacidad de Salarivo — acceso privado individual',
    $privacy$1. Alcance y responsable

Este Aviso rige la instancia privada e individual de Salarivo. La persona titular que administra la instancia es el responsable de los datos y su única usuaria autorizada. La identidad y el domicilio del responsable coinciden con los de esa persona titular. Las solicitudes se presentan por el mismo canal privado utilizado para habilitar y administrar el acceso. La instancia no está destinada a dar informes sobre terceros ni a ofrecer cuentas al público.

2. Datos tratados

Se tratan email, nombre opcional, credenciales protegidas, sesiones y segundo factor; PDFs y metadatos de carga; texto extraído de forma temporal o persistente según el proceso; empleadores, empleos, períodos, monedas, importes, conceptos minimizados, correcciones y preferencias; y eventos técnicos necesarios para seguridad, auditoría, exportación y eliminación. Los métodos de acceso y secretos MFA se protegen según su función. Cuando se usa Google, sólo se solicitan los alcances openid, email y profile para validar la identidad; no se persisten access tokens, refresh tokens ni ID tokens.

3. Origen, carácter y consecuencias

Los datos provienen de la persona titular y de los documentos que decide cargar. El email, un método de acceso y la aceptación de los Términos son necesarios para crear una cuenta; el nombre visible es opcional. Los PDFs son voluntarios, pero sin ellos no pueden ejecutarse las funciones de extracción. Datos inexactos pueden producir resultados incorrectos. No cargues documentos ajenos salvo que estés legalmente autorizado a tratarlos, ni información que no necesites para tu historial.

4. Finalidades y fundamento

Los datos se usan para autenticarte; recibir, validar y analizar PDFs; detectar archivos peligrosos; extraer y organizar información salarial y laboral; permitir revisión y corrección; mantener integridad y trazabilidad; prevenir abuso; aplicar límites; y atender exportación o eliminación. El tratamiento se basa en tu solicitud de estas funciones, la relación derivada de los Términos y el consentimiento expreso cuando corresponde. No se usan para publicidad, venta de datos, scoring, decisiones automatizadas con efectos jurídicos ni entrenamiento de modelos.

5. Datos sensibles incidentales

Un recibo puede incluir referencias a salud, obra social o afiliación sindical. Salarivo no solicita esos datos como finalidad del servicio, no los usa para crear perfiles y minimiza las deducciones estructuradas a una etiqueta genérica y su importe. El PDF original puede conservar la referencia mientras elijas mantenerlo. Evitá cargar información sensible innecesaria y eliminá el original cuando ya no lo necesites.

6. Destinatarios y transferencias

Los documentos y salarios no se muestran a otros usuarios, no se venden y no se ceden para fines propios de terceros. La vista web publicada utiliza proveedores técnicos de alojamiento y control de acceso, que pueden tratar datos mínimos de conexión y autenticación bajo las condiciones de la cuenta que administra la instancia; esa vista no tiene un backend público habilitado para recibir PDFs o salarios. Un backend local o privado no envía documentos a servicios externos de OCR o inteligencia artificial por defecto. No se autoriza por este Aviso una transferencia externa de PDFs, OCR o datos salariales.

7. Seguridad

La aplicación incorpora separación por cuenta, sesiones seguras, segundo factor, reautenticación para acciones sensibles, claves opacas, URLs firmadas breves, validación de archivos, procesamiento asíncrono, minimización de logs y borrado reconciliable. Estas medidas reducen riesgos pero ningún sistema puede prometer seguridad absoluta. Ante una sospecha de acceso indebido, cerrá sesiones, protegé tu método de acceso y usá el canal privado de administración.

8. Conservación

La cuenta y los datos estructurados se conservan mientras mantengas la cuenta o hasta que elimines el documento correspondiente. Los originales se conservan según la opción aplicada al documento y pueden borrarse sin eliminar los datos estructurados. Uploads incompletos, archivos temporales y exportaciones tienen vencimientos técnicos breves. Los eventos de seguridad y la constancia no identificable de una baja se conservan sólo durante el tiempo necesario para integridad, investigación o acreditación de la operación. La instancia actual no declara copias de respaldo de datos personales como mecanismo de recuperación.

9. Exportación, rectificación y supresión

Desde la aplicación podés consultar y corregir información estructurada, descargar una exportación y eliminar originales, documentos o la cuenta. También podés formular una solicitud por el canal privado de administración, acreditando identidad e indicando el derecho ejercido. El acceso se responde dentro de diez días corridos; la rectificación, actualización o supresión se realiza dentro de cinco días hábiles, salvo una obligación legal o un derecho legítimo de terceros que exija conservar o bloquear temporalmente un dato.

10. Eliminación de cuenta

La baja revoca sesiones y coordina el borrado de base de datos, objetos privados, temporales y exportaciones. Mientras la operación está en curso, la cuenta permanece bloqueada y la constancia muestra estado pendiente; sólo muestra completado después de las verificaciones técnicas previstas. La constancia usa un token opaco y no conserva email, PDF ni información salarial.

11. Cookies y telemetría

La aplicación usa la cookie de sesión necesaria para autenticar y proteger la cuenta y, durante el acceso con Google, una cookie técnica transitoria que vincula el intento OIDC con el navegador. No usa cookies publicitarias ni perfiles de marketing. Logs, métricas y trazas se limitan a identificadores internos, estados y errores sanitizados; no deben recibir PDFs, OCR completo, salarios, credenciales de acceso, tokens ni URLs firmadas.

12. Derechos y autoridad de control

Podés ejercer gratuitamente los derechos de información, acceso, rectificación, actualización, confidencialidad y supresión previstos por la Ley 25.326. Si una respuesta resulta insuficiente, podés reclamar ante la Agencia de Acceso a la Información Pública o promover la acción que corresponda. La información oficial está disponible en argentina.gob.ar/aaip/datospersonales/derechos.

13. Versiones

Cada versión del Aviso se conserva de forma inmutable con su fecha de vigencia y su confirmación queda registrada al crear la cuenta. Una versión posterior se aplica únicamente cuando exista una nueva confirmación expresa.$privacy$,
    '2026-08-30T12:30:00Z',
    '2026-08-30T12:30:00Z',
    false,
    true
);
