# Architecture Decision Records

Los ADR registran decisiones arquitectónicas materiales, no tareas ni preferencias menores.

## Estados

- Proposed: en discusión o aún no respaldado por implementación.
- Accepted: decisión aprobada explícitamente por el responsable y respaldada por evidencia.
- Superseded: reemplazada por otro ADR.
- Rejected: evaluada y descartada.

Los ADR 0001, 0002 y 0007 están Accepted y respaldados por el corte vertical. Los ADR 0003, 0004, 0005 y 0006 siguen Proposed hasta cubrir todos sus criterios con fixtures y tests.

## Índice

- [0001 — Monolito modular y monorepo](0001-modular-monolith.md)
- [0002 — Storage privado y jobs asíncronos](0002-private-storage-async-jobs.md)
- [0003 — Gates de seguridad y costo](0003-security-and-cost-gates.md)
- [0004 — Extracción versionada y correcciones](0004-versioned-extraction.md)
- [0005 — Historial laboral y documentos de evidencia](0005-employment-history-and-evidence.md)
- [0006 — Entitlements y benchmark salarial de mercado](0006-entitlements-and-market-benchmarking.md)
- [0007 — Aceptación legal versionada y administración mínima](0007-versioned-legal-acceptance-and-minimal-admin.md)

## Formato

Cada ADR contiene:

- estado y fecha;
- contexto;
- decisión;
- alternativas;
- consecuencias;
- condiciones para aceptar o reemplazar.

Para cambiar una decisión Accepted, crear un ADR que la superseda o actualizarla sólo si conserva su intención. El código y los tests del mismo cambio deben respaldarla.
