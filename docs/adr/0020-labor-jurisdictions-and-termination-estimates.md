# ADR 0020 — Jurisdicciones laborales y simulaciones reproducibles

- Estado: Accepted
- Fecha: 2026-09-05
- Extiende: ADR 0005, 0013, 0015 y 0019.

## Contexto

El empleo ya tenía país y moneda, pero el perfil no tenía país principal y no existía evidencia de confirmación del país ni del estado laboral. El pipeline y sus layouts eran exclusivamente argentinos. Una base salarial comparable para analytics no es una base indemnizatoria: ni neto ni último básico bastan para aplicar legislación laboral.

## Decisión

`@salarivo/jurisdictions` comparte un catálogo ISO 3166-1 alpha-2, nombres localizados con Intl y sugerencias determinísticas. `primaryCountryCode` es una preferencia confirmada de la cuenta; nunca modifica empleos, originales ni sus extracciones. Sólo se conserva el código regional candidato de Google cuando viene en el claim locale, sin nuevos scopes. Locale y timezone del navegador son señales transitorias; no se agrega geolocalización por IP ni tracking. Idioma y monedas compartidas no identifican por sí solos un país.

La jurisdicción del empleo es independiente del país de la organización y del titular. Incluye país, subdivisión, régimen y procedencia de confirmación. La relación distingue `DEPENDENT`, `INDEPENDENT` y `UNKNOWN`, y su estado distingue `ACTIVE`, `ENDED` y `UNKNOWN` con confirmación separada. La migración conserva los valores previos como `LEGACY`, sin inventar confirmaciones ni transformar un recibo reciente en prueba de continuidad. La identidad exacta incluye subdivisión, régimen y tipo; el merge administrativo conserva esa separación y las confirmaciones existentes.

Cada documento tiene su propio snapshot de país. El pipeline usa el empleo confirmado, una confirmación explícita del documento o evidencia documental acotada. Un conflicto genera revisión. Cambiar el perfil no cambia esos snapshots; reprocesar tampoco los sobrescribe. La corrección explícita del país usa `UserCorrection` append-only, conserva la corrida anterior y requiere coincidencia con el empleo confirmado asociado. Los layouts se resuelven por país, organización, tipo, parser y huella. Sólo sigue habilitado PDF salarial argentino.

El motor puro de `termination-calculator.ts` resuelve país, régimen y fecha mediante versiones normativas declarativas y un cálculo argentino encapsulado. Los endpoints resuelven ownership y liquidaciones; React presenta y permite overrides, sin fórmulas legales. Los centavos se operan con BigInt reutilizando analytics. Dos escenarios detallan preaviso cumplido u omitido para una misma fecha efectiva de egreso. Los países y regímenes sin implementación devuelven estado explícito sin números.

Las versiones son datos de código revisables junto con sus tests y fuentes. Una modificación legal agrega versión y vigencia; no altera una versión usada. El catálogo CCT está separado y actualmente vacío: un tope manual requiere convenio, versión, vigencia y fuente y se etiqueta como override. No se inventan topes. `GET /api/v1/termination-rules` permite inspeccionar las versiones y referencias configuradas sin exponer datos privados. Las fuentes y restricciones históricas están en [Reglas de desvinculación](../architecture/termination-rules.md).

## Persistencia y privacidad

La primera versión no persiste simulaciones. El POST owner-only devuelve un snapshot reproducible de inputs normalizados, documentos, overrides, regla, supuestos, desglose y totales; el navegador lo conserva sólo en memoria. Cerrar o recargar descarta la estimación. No existe historial de simulaciones guardadas ni consulta administrativa de cálculos privados. Si se incorpora guardado, deberá conservar este snapshot completo con ownership, exportación y borrado; guardar sólo el total no satisface el contrato.

El resolver sólo usa corridas activas de documentos limpios `COMPLETED`, del empleo y moneda solicitados, con corte histórico de período y emisión/pago. Excluye país documental explícitamente incompatible. La lectura usa transacción consistente, ventana acotada y `MAX_TERMINATION_SETTLEMENTS` validado (500 por defecto). Ni PDFs, OCR ni salarios se envían a servicios externos. No se registran montos ni overrides en logs/auditoría; las respuestas son `no-store`. La interfaz reutiliza privacidad visual, también para los inputs de importe.

## Consecuencias

Agregar un país al catálogo no habilita su parser ni su legislación. Otro motor puede cumplir el mismo contrato sin modificar la identidad laboral ni los consumidores de resultados. No se implementan reglas especiales, preaviso parcial, fuentes automáticas de topes ni persistencia especulativa. La estimación informa ausencia, proyección y controversia normativa de forma explícita; no suplanta un análisis de circunstancias individuales.
