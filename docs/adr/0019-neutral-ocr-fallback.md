# ADR 0019 — OCR neutral y fallback controlado con GLM-OCR

- Estado: Accepted
- Fecha: 2026-09-05
- Extiende: [ADR 0015](0015-active-processing-runs-and-safe-recovery.md), en proveedor OCR, artefactos y metadata de costo; conserva resultado activo, revisión humana y cleanup.

## Contexto

El pipeline ya extrae texto de PDF, usa Tesseract, interpreta etiquetas salariales y conserva corridas/artefactos privados. Algunos scans o layouts incompletos necesitan otra fuente de texto, pero sustituir parsers conocidos por llamadas externas aumenta exposición, costo y variabilidad sin mejorar su resultado.

## Decisión

Se conserva el parser existente como primera opción y se agrega `OCRProvider` en el límite real con el proveedor externo. `ZaiGlmOcrProvider` normaliza la respuesta de la API general GLM-OCR; `DisabledOCRProvider` permite apagado y arranque sin secretos. Tesseract mantiene su flujo local. `orchestrateExtraction` coordina parsing, política de fallback y revalidación del resultado neutral. No se crea una jerarquía de estrategias ni un proveedor semántico sin implementación actual.

El parser sigue independiente del empleador. `DocumentLayout` y sus versiones permiten varias estructuras por identidad canónica. Una huella versionada usa solamente anchors/columnas allowlisted ordenados y páginas, sin datos personales, importes ni hash del archivo. Una observación en revisión permite a un `SUPER_ADMIN` aprobar aliases literales acotados bajo step-up y auditoría. Las versiones se agregan y pueden desactivar la reutilización; no se generan reglas automáticamente desde documentos ni correcciones. Una coincidencia única de empleador verificado, huella y última versión habilitada permite completar valores ausentes con el parser 8. El resultado conserva evidencia y todas las validaciones; una coincidencia de formato nunca autoriza por sí sola promoción.

Las corridas conservan huella y versión aplicada. La aprobación de una versión posterior habilita reproceso acotado sin invalidar OCR cacheado. Rechazo, fusión o ambigüedad del empleador impiden reutilización; el merge no transfiere automáticamente las reglas. Una revocación concurrente se detecta antes de persistir y exige revisión. El registro global contiene configuración genérica escrita por el operador, sin links a las fuentes privadas; las observaciones permanecen sujetas al borrado de esas fuentes.

OCR puede completar texto pobre, empleador o campos ausentes y extracciones incompletas. Un scan sin clasificación útil puede recuperarse externamente después de seguridad y del descarte barato de señales no salariales. El adapter no escribe dominio, no recibe acceso a DB/storage, no sigue URLs ni ejecuta instrucciones del documento. La salida vuelve al parser; una contradicción con campos existentes o un layout desconocido exige revisión. Promoción, correcciones y Analytics continúan bajo el ADR 0015.

El PDF viaja como base64 por HTTPS a un único endpoint allowlisted, con secreto sólo server-side e identificador aleatorio. Límites de entrada/respuesta, timeout, retry transitorio acotado, reserva presupuestaria y concurrencia compartida limitan costo y exposición. La configuración admite activación en producción; eso no acredita actualización de políticas o contratos del proveedor.

El artefacto privado almacena exclusivamente el resultado interno normalizado. Owner, documento, hash, proveedor/modelo/versión y extractor determinan compatibilidad; cambiar parser no obliga a repetir OCR. Cache y originales comparten el borrado durable existente. No se conserva OCR en telemetry ni se exponen originales, OCR o salarios al administrador.

`ocr_provider_usage` relaciona operaciones con owner/documento/corrida/job mediante FKs compuestas. Tokens y costos permanecen metadata de infraestructura; la aritmética es decimal exacta. Reservas de costo incierto no se liberan como si fueran consumo cero. Un agregado diario sin IDs sobrevive a cascades para impedir que una baja reinicie el presupuesto. La consola usa esas señales reales con capacidad `processing.read`, paginación y DTO allowlisted.

## Alternativas

- Reemplazar el parser por GLM-OCR: aumenta costo y cambia resultados conocidos; descartado.
- Persistir la respuesta externa como liquidación: evita validación y acopla el dominio al proveedor; descartado.
- No cachear: repite OCR pago en cambios exclusivos del parser; descartado.
- Cache global por hash: permite correlación entre titulares; descartado.
- Otro LLM para layouts desconocidos, plataforma de plugins o infraestructura nueva: sin necesidad demostrada; pendientes.

## Consecuencias y evidencia

Las migraciones 026–027, los providers, el orquestador, el worker, el diagnóstico admin y sus tests implementan esta decisión. El uso externo se prueba opcionalmente con un PDF sintético, nunca como dependencia de la suite normal. [OCR externo](../architecture/ocr.md) documenta configuración, errores, cache, medición y comandos verificables.

La integración amplía la superficie de datos del proveedor. Continúan pendientes validación de DPA, región, retención, entrenamiento, subencargados y borrado remoto, junto con las actualizaciones de políticas y versiones legales que correspondan. Este ADR describe una decisión técnica implementada y no reemplaza esas políticas ni modifica aceptaciones históricas. Imágenes públicas, editor geométrico, descubrimiento automático de templates y extracción semántica siguen fuera del alcance implementado.
