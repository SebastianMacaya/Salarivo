# Políticas legales del MVP

> Estado: versiones 1.1 vigentes y aprobadas por el titular exclusivamente para acceso privado individual. No constituyen certificación jurídica ni autorización para abrir cuentas a terceros.

Las versiones que muestra el producto viven en `legal_document_versions` y se crean únicamente mediante migraciones revisadas. Un trigger las hace append-only: corregir o cambiar un texto requiere una versión nueva, no editar la ya aceptada. Cada versión indica además si fue aprobada para producción; el alta productiva falla cerrada cuando los Términos o el Aviso vigentes no lo están. La ruta pública puede resolver la versión vigente o una versión histórica exacta. La 1.0 permanece como antecedente y la 1.1 es la versión actual.

Al registrar una cuenta, la API resuelve del lado servidor los Términos y el Aviso vigentes para `es-AR`. La creación de usuario, aceptación de Términos, confirmación de lectura del Aviso, sesión y auditoría ocurre en una sola transacción. No se confía en un ID/version enviado por el navegador.

La versión 1.1 limita expresamente su alcance al titular y distingue tres usos:

- prestar las funciones solicitadas con los datos privados de la cuenta;
- mejorar seguridad, fallos y rendimiento sólo con telemetría minimizada que no lleve PDFs, OCR, salarios reales ni PII completa;
- una posible comparación salarial comunitaria futura, que no está implementada y requerirá opt-in específico, separado, apagado por defecto y revocable.

La excepción de uso personal depende de mantener efectivamente una única persona titular y ningún acceso de terceros. Abrir el servicio exige una versión nueva con identidad, domicilio, canal, destinatarios/proveedores, transferencias, conservación, backups y procedimiento de derechos ajustados al entorno real, además de revisión profesional. Como referencia informativa se consultaron la [Ley 25.326 actualizada](https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion) y la [guía de derechos de la AAIP](https://www.argentina.gob.ar/aaip/datospersonales/derechos); el repositorio no reemplaza asesoramiento legal.
