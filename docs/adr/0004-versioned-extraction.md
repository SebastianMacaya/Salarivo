# ADR 0004 — Extracción versionada y correcciones

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

Parsers y OCR cambian. Reprocesar puede mejorar datos, pero sobrescribir resultados o correcciones destruye trazabilidad y confianza. Además, documento y liquidación no tienen relación uno a uno.

## Decisión

Cada procesamiento crea una ExtractionRun inmutable con versiones, confidence, resultado y errores. El esquema admite 0..N PayrollSettlement por Document; el worker actual produce como máximo uno. UserCorrection es append-only y prevalece dentro de la ExtractionRun vigente. Puede apuntar a un ExtractedField o completar un fieldPath ausente dentro de esa corrida, sin presentar el valor humano como extracción automática.

El titular puede pedir un reproceso sólo sobre un PDF salarial limpio, con original disponible, estado terminal y sin otro job activo. La API valida ownership, exige una clave de idempotencia y crea una versión nueva sin modificar corridas, campos ni correcciones anteriores. El worker copia a la corrida nueva la última corrección de cada fieldPath, conserva una referencia a su corrección raíz y materializa la nueva PayrollSettlement con esos valores efectivos. Una corrección posterior vuelve a ser append-only dentro de la corrida vigente.

Cada corrección declara la `extractionRunId` que el usuario revisó. La API la compara con la corrida vigente y rechaza una edición tardía si un reproceso terminó mientras el formulario estaba abierto.

ExtractedField conserva evidencia espacial opcional sólo cuando el texto fuente tiene una coincidencia literal única. La región usa el contrato versionado `PAGE_NORMALIZED`, origen `TOP_LEFT`, coordenadas 0..1 y número de página; valores derivados, ausentes o ambiguos no reciben una región inventada.

Original, extracción, dato verificado y proyección son capas separadas.

## Alternativas

- Sobrescribir columnas con el último parser: rechazado por pérdida de auditoría.
- Editar el resultado OCR como fuente: rechazado porque mezcla evidencia y decisión humana.
- Asumir un PDF/mes igual a una liquidación: rechazado por SAC, bonos, retroactivos y documentos múltiples.

## Consecuencias

- Más filas/versiones y una regla explícita de proyección.
- Es posible explicar por qué un valor existe y comparar parsers.
- Reprocesar no desplaza una decisión humana ni convierte esa decisión en evidencia automática.
- El usuario puede borrar el original y conservar estructura según su policy.
- Una revisión sólo pasa a COMPLETED mediante acción humana explícita después de completar los montos requeridos.

## Evidencia

Las migraciones 001–003 separan corridas, campos y correcciones; la 017 agrega el linaje raíz entre corridas sin reescribir filas. Los tests verifican autorización e idempotencia del reproceso, que encolarlo no muta corridas ni correcciones, materialización de correcciones efectivas y evidencia espacial literal/no ambigua. La integración de upload conserva corrección de un campo extraído, carga de campos ausentes y cierre explícito de revisión. Analytics consulta la proyección estructurada sin abrir PDFs.
