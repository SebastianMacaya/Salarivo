# ADR 0013 — Analítica salarial derivada, exacta y contextual

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

Una liquidación o un PDF aislado no responde cuánto evolucionó realmente un salario. Usar el último neto, sumar porcentajes mensuales, colapsar dos liquidaciones del mismo período o cruzar empleos y monedas produce conclusiones financieras falsas. Persistir agregados agregaría invalidación y backfills antes de que exista más de un consumidor o una necesidad de latencia demostrada.

## Decisión

`salary-analytics-v1` es una proyección derivada de la última ExtractionRun `COMPLETED` de cada documento PAYROLL cuyo estado sea también `COMPLETED`. No lee PDFs ni OCR, no persiste agregados y excluye importes pendientes de revisión.

Cada scope pertenece a un único contexto laboral y currencyCode. Un empleo confirmado usa Employment; un nombre de empleador detectado forma un contexto provisional visible; un documento sin contexto queda aislado y no se mezcla con otros. Cambiar de scope nunca se presenta como aumento.

Dinero se convierte de decimal a centavos BigInt. Totales, promedios, deltas y porcentajes vuelven como strings decimales. El cambio acumulado es `(final / inicial) - 1`; el interanual exige el mismo mes y toda comparación declara sus períodos.

El comparable inicial es exclusivamente basicAmount cuando el período tiene una liquidación `NORMAL` recurrente y un valor único. Si falta o es ambiguo devuelve N/D; bruto y neto no son fallback. Las liquidaciones del mismo mes se conservan, los tipos extraordinarios permanecen separados y los conceptos sólo explican una comparación cuando la extracción normalizada está completa.

Cobertura y anomalías son conservadoras: un período ausente se marca como posible, un duplicado estructural sólo como advertencia y un bono, SAC, reintegro o retroactivo nunca como aumento permanente. Confirmar un empleo o eliminar datos invalida la proyección naturalmente porque el siguiente request vuelve a derivarla.

IPC y variación real no forman parte de esta versión. Requieren fuente oficial, índice, período, fecha de actualización, versionado y una decisión separada; el límite `EconomicIndexProvider` continúa sin implementación.

## Alternativas consideradas

- **Usar neto o bruto como comparable:** rechazado porque incorpora descuentos y extraordinarios.
- **Sumar porcentajes mensuales:** rechazado por ser matemáticamente incorrecto.
- **Un historial global por usuario:** rechazado porque mezcla empleos simultáneos, cambios de trabajo y monedas.
- **Tabla de agregados y jobs de recálculo:** pospuesta; la cuota actual permite derivar desde filas estructuradas y evita estados obsoletos.
- **Completar conceptos faltantes o usar IA:** rechazado; N/D es preferible a inventar información financiera.

## Consecuencias

- La misma versión alimenta resumen, evolución, anual, aumentos, cobertura, eventos y comparación.
- Una corrección humana sólo participa después de cerrar la revisión; no existe backfill ni reproceso automático.
- Historiales antiguos sin básico siguen visibles, pero su comparable queda N/D.
- Optimizar con agregados persistidos, IPC o un fallback comparable exige nueva evidencia, versionado y revisión de esta decisión.

## Evidencia

- `apps/api/src/salary-analytics.ts` y sus tests de exactitud, scopes, extraordinarios, cobertura y duplicados.
- `GET /api/v1/salary-history` y `/api/v1/salary-history/comparison`, ambos owner-only.
- Integración con usuarios aislados y documentos sintéticos.
