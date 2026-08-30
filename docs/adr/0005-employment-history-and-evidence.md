# ADR 0005 — Historial laboral y documentos de evidencia

- Estado: Proposed
- Fecha: 2026-08-29

## Contexto

El usuario necesita seguir salario, descuentos, empresa y cambios de puesto, y conservar algunos documentos laborales firmados. Aceptar archivos arbitrarios convertiría Salarivo en un gestor documental genérico, ampliaría la superficie de ataque y encarecería OCR sin mejorar el historial estructurado.

## Decisión propuesta

Employment es la columna vertebral. PayrollSettlement describe la evolución salarial y una futura PositionPeriod describe puesto, categoría/modalidad y vigencia. El timeline es una proyección de esos datos; no una tabla duplicada de eventos salariales.

Después del MVP salarial se podrá admitir una allowlist pequeña de evidencia secundaria: contrato laboral, adenda y, cuando exista demanda, certificado. Todo documento secundario deberá asociarse a un Employment propio, pasar los mismos gates de seguridad y conservar su original privado para que tenga valor probatorio. En la primera versión no tendrá OCR, extracción ni IA.

El MVP actual continúa aceptando únicamente PAYROLL. Antes de habilitar otro tipo se requieren migración, descarga reautorizada con URL firmada breve, cuotas, retención específica y tests de ownership, seguridad y borrado.

## Alternativas

- Guardar cualquier PDF: rechazado por alcance, abuso y privacidad.
- Inferir puesto y empresa sólo desde el documento: rechazado porque una relación laboral puede cambiar sin un formato estable y requiere confirmación humana.
- Usar LLM para todos los formatos: rechazado como camino primario por privacidad, costo y no determinismo.
- Crear una tabla de eventos salariales duplicada: rechazado; los aumentos se derivan de PayrollSettlement versionado.

## Consecuencias

- Salarivo sigue siendo un historial laboral verificable, no un Dropbox.
- Los cambios de puesto requieren una entidad temporal propia antes de exponer timeline.
- Los documentos secundarios no pueden usar DELETE_AFTER_PROCESSING porque no producen una estructura sustitutiva.
- Agregar un nuevo tipo exige una decisión explícita sobre extracción, retención y descarga.

## Para aceptar

Definir y verificar PositionPeriod; implementar descarga privada; aprobar la allowlist y retención; demostrar que un documento secundario queda asociado a un empleo propio, no ejecuta OCR y puede descargarse o eliminarse sin acceso cruzado.
