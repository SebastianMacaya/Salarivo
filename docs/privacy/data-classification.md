# Clasificación de datos

> Estado: política Proposed. Los controles deben demostrarse antes de comunicar garantías al usuario.

## Clases

| Clase | Ejemplos | Manejo |
| --- | --- | --- |
| Restricted | PDFs, OCR, salarios, futura contribución/mapping de benchmark, DNI/CUIL, banco, correcciones, exports, tokens, URLs firmadas, claves | cifrado, acceso mínimo, no logs, no fixtures reales, sharing explícito |
| Confidential | userId interno, documentId, rol admin, aceptación legal, employment metadata, audit events sanitizados, configuración no secreta | acceso por rol/servicio, logs limitados, retención definida |
| Internal | métricas agregadas sin cardinalidad sensible, health, versiones, error codes | uso operativo, sin vínculo innecesario a persona |
| Public | documentación pública aprobada y contenido de marketing | sin datos derivados de usuarios |

Un dato derivado mantiene la clase del origen si permite inferir información Restricted. Hashes de documentos e identificadores pseudónimos no se consideran anónimos.

## Minimización

Antes de persistir un campo:

1. definir qué función de producto lo usa;
2. definir owner y retención;
3. clasificarlo;
4. demostrar que no basta una versión menos precisa o redactada.

No se guarda una dirección, banco, familiar u otro dato sólo porque aparece en el PDF.

## Reglas por sistema

### PostgreSQL

Metadata necesaria y datos estructurados. Campos especialmente sensibles pueden requerir cifrado de aplicación/campo. El binario no se almacena en DB.

### Object storage

Originales y artefactos temporales privados, cifrados y con policy/lifecycle. Keys opacas sin nombre, CUIL, empleador ni período.

### Cola

Sólo IDs internos, stage, versión e idempotency key. Nunca PDF, OCR, salario ni credenciales.

### Logs, traces, métricas y errores

Allowlist:

- userId interno cuando sea imprescindible;
- documentId, batchId y jobId;
- evento, stage y versión;
- duración, resultado y errorCode.

Prohibido:

- request/response bodies genéricos;
- contenido/documento/OCR;
- salario y conceptos;
- DNI/CUIL completos;
- cookies, tokens, contraseñas y claves;
- URL firmada completa;
- labels de métricas con texto libre.

El sanitizer se aplica antes de serializar y se prueba con PII sintética.

## IA y proveedores externos

Por defecto no se envía información Restricted. Una operación habilitada debe:

- tener purpose explícito y consentimiento/configuración correspondiente;
- enviar el fragmento mínimo redactado;
- usar un proveedor evaluado por región, retención, entrenamiento y borrado;
- registrar proveedor, versión, purpose, costo e IDs internos, no el payload;
- respetar budget y timeout;
- permitir deshabilitar el proveedor sin tumbar el producto.

Ejemplo aceptable futuro: interpretar un concepto aislado y pseudonimizado. Enviar el PDF completo a un LLM por conveniencia no es aceptable.

## Entrenamiento

Documentos, datos salariales y correcciones no se usan para entrenar modelos por defecto. Cualquier aprendizaje futuro usa datos sintéticos o anonimización irreversible; un consentimiento separado, explícito y revocable requiere revisión legal y de producto.

## Entornos y fixtures

Producción no se copia a desarrollo. Tests usan personas, empresas, importes y PDFs sintéticos. Un dump requiere anonimización irreversible y autorización específica antes de salir de producción.

## Comunicación al usuario

La UI puede afirmar sólo lo que la implementación demuestra. Debe explicar de forma comprensible:

- quién controla los datos;
- si se conserva el original;
- para qué se usa un proveedor;
- cómo eliminar/exportar;
- qué queda temporalmente en backups.
