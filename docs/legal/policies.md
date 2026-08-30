# Políticas legales del MVP

> Estado: implementación local con textos borrador. No constituye aprobación legal para producción.

Las versiones que muestra el producto viven en `legal_document_versions` y se crean únicamente mediante migraciones revisadas. Un trigger las hace append-only: corregir o cambiar un texto requiere una versión nueva, no editar la ya aceptada. Cada versión indica además si fue aprobada para producción; el alta productiva falla cerrada mientras Términos o Aviso sigan como borrador. La ruta pública puede resolver la versión vigente o una versión histórica exacta.

Al registrar una cuenta, la API resuelve del lado servidor los Términos y el Aviso vigentes para `es-AR`. La creación de usuario, aceptación de Términos, confirmación de lectura del Aviso, sesión y auditoría ocurre en una sola transacción. No se confía en un ID/version enviado por el navegador.

El texto distingue tres usos:

- prestar las funciones solicitadas con los datos privados de la cuenta;
- mejorar seguridad, fallos y rendimiento sólo con telemetría minimizada que no lleve PDFs, OCR, salarios reales ni PII completa;
- una posible comparación salarial comunitaria futura, que no está implementada y requerirá opt-in específico, separado, apagado por defecto y revocable.

Antes de producción se deben completar identidad, domicilio y canal del responsable, destinatarios/proveedores reales, transferencias, plazos de conservación y backups, mecanismos de derechos, jurisdicción y revisión profesional. Como referencia informativa se consultaron la [Ley 25.326 actualizada](https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion) y la [guía de derechos de la AAIP](https://www.argentina.gob.ar/aaip/datospersonales/derechos); el repositorio no reemplaza asesoramiento legal.
