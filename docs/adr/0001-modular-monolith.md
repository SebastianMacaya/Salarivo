# ADR 0001 — Monolito modular y monorepo

- Estado: Accepted
- Fecha: 2026-08-27

## Contexto

El MVP contiene identidad, empleos, imports, documentos, nómina, analytics, privacidad y auditoría. Tiene trabajo pesado que no puede bloquear requests, pero no existe evidencia de que esos dominios necesiten equipos, despliegues o escalado independientes.

## Decisión

Usar un monorepo TypeScript y un monolito modular. API/web y worker-documents son unidades de ejecución separadas que comparten paquetes de dominio, contratos y seguridad. Las reglas de dominio no dependen de framework, ORM o proveedor.

No crear carpetas o packages hasta que alojen código real. No dividir cada etapa del pipeline en servicio.

## Alternativas

- Microservicios desde el inicio: rechazado por complejidad operativa, consistencia distribuida y superficie de seguridad.
- Un único proceso para HTTP y OCR: rechazado porque mezcla latencia, memoria y permisos.
- Polyrepo: rechazado mientras un solo equipo y release coordinado sean suficientes.

## Consecuencias

- Transacciones y cambios cross-module son simples.
- El worker puede aislar CPU/RAM/permisos sin duplicar dominio.
- Hay que hacer cumplir boundaries mediante imports/tests, no mediante red.
- Un módulo puede extraerse cuando métricas o ownership lo justifiquen.

## Evidencia

El monorepo contiene web, API, worker separado y paquete de base compartido. Typecheck, tests, build web y las imágenes independientes de API/worker verifican sus límites de ejecución.
