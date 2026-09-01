# Políticas legales del MVP

> Estado operativo (2026-09-01): la versión inicial 1.0 sigue vigente y registra aceptaciones en producción, pero fue aprobada exclusivamente para acceso privado individual. La operación actual con múltiples cuentas de personas reales excede ese alcance y constituye una brecha abierta; no equivale a certificación jurídica ni a una afirmación de cumplimiento.

Las versiones que muestra el producto viven en `legal_document_versions` y se crean únicamente mediante migraciones revisadas. Un trigger las hace append-only: corregir o cambiar un texto requiere una versión nueva, no editar la ya aceptada. Cada versión indica además si fue aprobada para producción; el alta productiva falla cerrada cuando los Términos o el Aviso vigentes no lo están. La ruta pública puede resolver la versión vigente o una versión histórica exacta. Como excepción anterior al primer despliegue, la migración de Google consolida las revisiones pre-lanzamiento sólo cuando no existen usuarios ni aceptaciones y publica los textos aprobados como 1.0; después restaura la protección append-only. La documentación del estado real no amplía retroactivamente el consentimiento: resolver la brecha actual exige una versión posterior aprobada y reaceptación cuando el cambio sea material.

Al registrar una cuenta, la API resuelve del lado servidor los Términos y el Aviso vigentes para `es-AR`. No se exponen alta, login ni recuperación por email y contraseña. En Google, el callback verifica la identidad y deja un intento de registro breve ligado al navegador, pero no crea una cuenta activa: el segundo paso crea usuario, aceptación/confirmación, relación `(provider, sub)`, sesión y auditoría en una sola transacción, con onboarding todavía pendiente. No se confía en un ID/version enviado por el navegador.

Google actúa sólo como proveedor de autenticación. Salarivo mantiene un UUID y una sesión propios, no usa el email para identificar ni auto-vincular cuentas y no persiste access, refresh ni ID tokens. La versión 1.0 describe este destinatario y flujo mínimo de datos y fue aprobada expresamente para la instancia privada; esa aprobación no autoriza abrir cuentas al público.

La versión 1.0 limita expresamente su alcance al titular y distingue tres usos:

- prestar las funciones solicitadas con los datos privados de la cuenta;
- mejorar seguridad, fallos y rendimiento sólo con telemetría minimizada que no lleve PDFs, OCR, salarios reales ni PII completa;
- una posible comparación salarial comunitaria futura, que no está implementada y requerirá opt-in específico, separado, apagado por defecto y revocable.

La excepción de uso personal depende de mantener efectivamente una única persona titular y ningún acceso de terceros; la operación multiusuario actual ya no cumple esa condición. El despliegue y Google no amplían por sí mismos el alcance aprobado. Regularizarlo exige una versión nueva con identidad, domicilio, canal, destinatarios/proveedores, transferencias, conservación, backups y procedimiento de derechos ajustados al entorno real, además de revisión profesional. Como referencia informativa se consultaron la [Ley 25.326 actualizada](https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion) y la [guía de derechos de la AAIP](https://www.argentina.gob.ar/aaip/datospersonales/derechos); el repositorio no reemplaza asesoramiento legal.
