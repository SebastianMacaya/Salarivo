# ADR 0004 — Extracción versionada y correcciones

- Estado: Proposed
- Fecha: 2026-08-27

## Contexto

Parsers y OCR cambian. Reprocesar puede mejorar datos, pero sobrescribir resultados o correcciones destruye trazabilidad y confianza. Además, documento y liquidación no tienen relación uno a uno.

## Decisión

Cada procesamiento crea una ExtractionRun inmutable con versiones, confidence, resultado y errores. El esquema admite 0..N PayrollSettlement por Document; el worker actual produce como máximo uno. UserCorrection es append-only y prevalece dentro de la ExtractionRun vigente. Puede apuntar a un ExtractedField o completar un fieldPath ausente dentro de esa corrida, sin presentar el valor humano como extracción automática.

El reproceso explícito y la precedencia de correcciones entre corridas siguen fuera del corte actual. Cuando se implementen, una nueva corrida no modificará las anteriores ni desplazará silenciosamente una corrección humana.

Original, extracción, dato verificado y proyección son capas separadas.

## Alternativas

- Sobrescribir columnas con el último parser: rechazado por pérdida de auditoría.
- Editar el resultado OCR como fuente: rechazado porque mezcla evidencia y decisión humana.
- Asumir un PDF/mes igual a una liquidación: rechazado por SAC, bonos, retroactivos y documentos múltiples.

## Consecuencias

- Más filas/versiones y una regla explícita de proyección.
- Es posible explicar por qué un valor existe y comparar parsers.
- El usuario puede borrar el original y conservar estructura según su policy.
- Una revisión sólo pasa a COMPLETED mediante acción humana explícita después de completar los montos requeridos.

## Evidencia

Las migraciones 001–003 separan corridas, campos y correcciones y validan su linaje; la integración de upload verifica corrección de un campo extraído, carga de campos ausentes y cierre explícito de revisión. Analytics consulta la proyección estructurada sin abrir PDFs.

## Para aceptar

Tests deben demostrar múltiples liquidaciones por documento, reproceso inmutable y precedencia explícita de correcciones entre corridas.
