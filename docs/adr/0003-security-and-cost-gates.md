# ADR 0003 — Gates de seguridad y costo

- Estado: Proposed
- Fecha: 2026-08-27

## Contexto

Un PDF puede ser malware, explotar un parser, agotar recursos o no ser laboral. OCR y LLM aumentan costo y exposición. La plataforma no debe convertirse en OCR genérico.

## Decisión

Procesar en este orden: límites baratos, tipo real, parse seguro, malware, inspección activa, clasificación salarial barata, extracción textual, OCR sólo si hace falta, parsing determinístico y LLM minimizado como último fallback.

Cada etapa tiene budget, timeout, versión, estado persistido e idempotency key. El parser corre aislado y el batch puede pausarse ante alta proporción de documentos no soportados.

Antes de emitir autorizaciones de carga, la API reserva contra límites de archivos/bytes por lote y cuotas de documentos/bytes por usuario. Sólo admite un lote activo por usuario. El dispatcher publica como máximo los slots globales y por usuario disponibles para que mensajes consumidos no queden esperando una reconciliación periódica.

## Alternativas

- OCR para todo: rechazado por costo, latencia y abuso.
- LLM-first: rechazado por privacidad, no determinismo y costo.
- Confiar en extensión/MIME: rechazado por seguridad.
- Antivirus público: rechazado si comparte documentos sensibles.

## Consecuencias

- Algunos documentos ambiguos requieren confirmación.
- Hay más estados visibles, pero fallos y costos son controlables.
- Los providers deben reportar versión/costo sin recibir más datos de los necesarios.

## Para aceptar

Los fixtures maliciosos/incorrectos se detienen en el gate esperado; un batch inválido no genera OCR/LLM masivo; los límites fallan de forma segura.
