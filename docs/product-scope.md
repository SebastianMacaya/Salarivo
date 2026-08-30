# Alcance del producto

> Estado: el alcance MVP listado abajo está implementado para recibos argentinos; visión, V2 y V3 siguen siendo objetivos.

## Visión

Salarivo permite que una persona construya, mantenga, consulte y analice su historia salarial y laboral durante toda su carrera. Los recibos son la primera fuente de información; el núcleo es el historial estructurado y verificable bajo control del usuario.

La plataforma debe soportar múltiples empleos, empleadores, monedas, países, liquidaciones por período y documentos por liquidación. Un documento puede producir varias liquidaciones y la eliminación del original puede conservar los datos estructurados si el usuario así lo decide.

## Principios

1. Privacidad por diseño.
2. Seguridad por diseño.
3. Procesamiento masivo, gradual e idempotente.
4. Extensibilidad sin sobrearquitectura prematura.

No se optimiza por cantidad de OCR ejecutados. Se optimiza por información laboral útil extraída con el menor acceso, costo y riesgo posibles.

## MVP

### Incluye

- alta e inicio de sesión exclusivamente con Google, aceptación versionada de Términos y confirmación del Aviso de Privacidad, onboarding, logout y revocación de otras sesiones;
- alta, edición y cierre de múltiples empleadores y empleos simultáneos o sucesivos;
- carga individual y masiva de PDFs;
- ImportBatch persistente, recuperable al volver a la pantalla, con progreso agregado y por archivo;
- admisión acotada por lote activo, cantidad, bytes, espacio de cuenta y concurrencia por usuario;
- validación de seguridad, malware y clasificación temprana;
- extracción de empresa, período, tipo, básico, bruto, neto, remunerativo, no remunerativo, descuentos, reintegros y conceptos principales;
- asociación manual individual o masiva de documentos procesados a un empleo propio;
- detección no persistida de un posible empleo desde documentos sin asociar y creación/asociación sólo después de confirmación explícita;
- confidence por campo, carga manual de montos ausentes y cierre explícito de revisión;
- historial `salary-analytics-v1` derivado por contexto laboral y moneda, con situación actual, evolución mensual sin perder liquidaciones del mismo período, aumentos compuestos, resumen anual por tipo/concepto normalizado, comparación determinística y posibles duplicados;
- eliminación de original, documento o cuenta;
- exportación de datos;
- auditoría de acciones sensibles;
- consola administrativa interna con RBAC por capacidades, MFA obligatorio, metadata paginada de usuarios/documentos/empleos/jobs/storage y comandos operativos acotados con auditoría append-only.

La administración no altera ownership ni concede acceso general al contenido privado. Las listas usan metadata mínima y contacto enmascarado; leer un email completo es una operación separada con permiso, step-up, motivo y auditoría. No se exponen PDFs, filenames, URLs firmadas, object keys, OCR, salarios, conceptos, identificadores fiscales completos, tokens ni secretos. Tampoco están habilitados break-glass, impersonación, reproceso completo, baja administrativa de cuenta, merge global de empleadores, tickets, flags o configuración dinámica. Ver [ADR 0012](adr/0012-granular-admin-console.md).

La identidad del dominio sigue siendo el UUID interno. Google OIDC agrega una cuenta de autenticación identificada sólo por `(provider, sub)` y emite la misma sesión opaca propia: un email coincidente no identifica ni auto-vincula usuarios, y la aplicación no conserva access, refresh ni ID tokens del proveedor. Las cuentas `BLOCKED` o `SUSPENDED` fallan cerradas. El ownership de empleos, imports, documentos, liquidaciones, analytics, exports y operaciones de privacidad no cambia con el método de login.

Analytics usa sólo la última extracción vigente de documentos `COMPLETED`; `NEEDS_REVIEW` se cuenta como cobertura pendiente pero no aporta importes. El salario comparable inicial es el sueldo básico verificado de una liquidación `NORMAL` recurrente: no usa neto ni bruto como fallback y devuelve N/D si falta o el período es ambiguo. Los porcentajes se calculan con decimal exacto mediante `(final / inicial) - 1`, nunca sumando variaciones mensuales ni cruzando contextos laborales o monedas.

Las deducciones individuales siguen minimizadas a etiqueta genérica e importe: no se conserva ni expone obra social, sindicato, descripción original, código normalizado, recurrencia ni campo fuente. Un total de descuentos negativo se presenta como crédito/reintegro, conservando el signo para el cálculo. Toda firma de posible duplicado requiere revisión y confirmación humana.

### No incluye

- documentos arbitrarios o un OCR genérico;
- contratos, ofertas o certificados;
- comparación con inflación;
- comparación salarial con el mercado;
- billing, suscripciones o capacidades pagas;
- Income Passport o enlaces públicos;
- múltiples países habilitados;
- entrenamiento con datos de usuarios;
- microservicios independientes;
- LLM como extractor primario.

La arquitectura puede dejar una salida limpia para esas capacidades, pero no debe construirlas antes de necesitarlas.

## Evolución prevista

### V2

IPC, poder adquisitivo, períodos de puesto y timeline, templates por empresa, más monedas y mejor importación. También se evaluarán entitlements server-side y un benchmark privado basado en cohortes amplias de usuarios que den consentimiento específico; ver [ADR 0006](adr/0006-entitlements-and-market-benchmarking.md).

### V3

Contratos y adendas en allowlist, sin OCR inicial y siempre asociados a un empleo; compensación total, beneficios, Income Passport, enlaces verificables, reportes y APIs externas. Ver [ADR 0005](adr/0005-employment-history-and-evidence.md).

## Criterios de éxito iniciales

- Un usuario puede cerrar el navegador y el batch continúa.
- Un archivo fallido no invalida el resto.
- Cientos de archivos aumentan la profundidad de cola, no la memoria de la API.
- Un usuario no puede reservar más lotes, almacenamiento ni workers que sus cuotas server-side.
- Una factura se rechaza antes de OCR completo.
- Un retry no duplica documentos, liquidaciones ni cargos externos.
- Usuario A nunca accede a recursos de usuario B.
- Una corrección humana tiene precedencia dentro de la corrida de extracción vigente.
- El dashboard no lee PDFs; consulta datos estructurados.
- El usuario puede eliminar originales sin perder datos estructurados cuando elige conservarlos.
- Una colisión de email entre una cuenta existente y Google nunca vincula, modifica ni expone detalles de la cuenta existente.
- El callback OIDC no crea una cuenta activa antes de que el navegador ligado al intento complete el registro y la aceptación legal; el onboarding permanece pendiente después del alta.

## Invariantes del modelo mental

- Fuente original, extracción automática y dato verificado son capas distintas.
- Salario recurrente e ingreso extraordinario no se agregan como si fueran equivalentes.
- Período salarial, fecha de pago, emisión e ingestión son fechas diferentes.
- País, moneda e identificador fiscal son explícitos; Argentina es el primer adapter, no una condición global.
- Preparar un tipo documental no habilita su procesamiento.
