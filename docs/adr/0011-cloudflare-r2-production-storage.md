# ADR 0011 — Cloudflare R2 para storage productivo

- Estado: Accepted
- Fecha: 2026-08-30

## Contexto

El protocolo del ADR 0002 necesita object storage privado, cifrado y con upload directo breve. La verificación productiva inicial asumía AWS S3, SSE-KMS, Public Access Block y operaciones S3 que Cloudflare R2 no implementa. Mantener esas llamadas como requisito universal impediría usar R2 sin mejorar la garantía real del proveedor elegido.

R2 cifra automáticamente objetos y metadata en reposo con AES-256-GCM y claves administradas por Cloudflare. Sus buckets no son públicos salvo habilitación explícita, pero la exposición por `r2.dev` o dominio propio, CORS, lifecycle, credenciales y costos siguen siendo configuración operativa que Salarivo debe comprobar o limitar.

## Decisión

- El proveedor se declara explícitamente. Cloudflare R2 Standard es el storage elegido para esta instancia productiva; el adapter AWS S3 sigue disponible y conserva SSE-KMS, bloqueo público y verificación de versioning.
- En R2 se acepta el cifrado AES-256-GCM administrado por Cloudflare. No se configura ni se afirma una clave administrada por Salarivo, y no se emiten operaciones KMS incompatibles.
- El bucket permanece privado: `r2.dev` deshabilitado, ningún custom domain, Bucket Lock ni migración on-demand habilitados. API y worker leen la configuración mediante un token Cloudflare separado con `Workers R2 Storage Read` account-wide y fallan al arrancar si no pueden comprobar storage class Standard, privacidad, CORS, lifecycle o esas políticas de retención. El runtime no corrige policies ni necesita permisos de escritura. Ese permiso read-only también permite leer y listar objetos; por eso el token queda sólo en API/worker, separado de las credenciales S3 bucket-scoped y con el mismo tratamiento de secreto.
- Las credenciales S3 para objetos se limitan al bucket y a lectura/escritura requeridas por API y worker; nunca llegan al navegador. Para cada sesión R2, la API reserva primero capacidad en PostgreSQL y crea un marcador vacío con `If-None-Match: *` sobre una key opaca única. Persiste su ETag y recién entonces entrega una URL breve para `PUT` ligada por `If-Match` a ese marcador, además de tamaño, `Content-Type`, metadata de sesión y storage class Standard. Sólo la primera sustitución atómica del marcador puede completar; una repetición recibe `412`. R2 no soporta el upload de formulario `POST`; AWS conserva ese flujo.
- CORS se expresa en dos reglas exactas desde `PUBLIC_ORIGIN`. La regla de upload conserva sólo `PUT`, con `Content-Type`, `If-Match`, `x-amz-meta-upload-session` y `x-amz-storage-class`, y expone `ETag`. La regla de lectura permite `GET` y `HEAD` para URLs firmadas, admite `Range` y expone `Accept-Ranges`, `Content-Disposition`, `Content-Length`, `Content-Range`, `Content-Type` y `ETag`; no vuelve público el bucket ni evita la reautorización previa. El lifecycle elimina objetos bajo `incoming/` y aborta multipart incompletos al día. No expira originales canónicos: su retención sigue la política persistida y el borrado durable del ADR 0009.
- La promoción canónica crea otro marcador y usa `x-amz-copy-source-if-match` junto con la extensión R2 `cf-copy-destination-if-match`; un retry acepta el objeto existente sólo si ETag, tamaño y metadata coinciden. La condición de destino está en Beta y Cloudflare no ofrece atomicidad conjunta entre las condiciones de fuente y destino, por lo que una prueba real contra el bucket es un gate del despliegue.
- Salarivo rechaza nuevas reservas cuando el total global de storage alcanzaría `8.000.000.000` bytes. El control usa la misma transacción y reservas persistidas que las cuotas existentes para fallar cerrado ante concurrencia; no borra datos ya aceptados.
- Se configuran Budget Alerts de Cloudflare a USD 1 y USD 3. Son alertas informativas sobre gasto usage-based de toda la cuenta, procesadas diariamente; no detienen consumo ni constituyen un límite de facturación.

## Alternativas descartadas

- Mantener AWS S3 como único proveedor inmediato: conserva control de clave con SSE-KMS, pero agrega costo y operación que esta instancia no necesita; el adapter no se elimina.
- Simular KMS o Public Access Block sobre R2: daría una garantía falsa porque esas operaciones S3 no son compatibles. Se verifican las propiedades reales mediante la API de Cloudflare.
- Hacer público el bucket o servir PDFs por dominio R2: contradice reautorización, ownership y descarga firmada breve.
- Pasar el binario por la API para conservar `POST`: aumenta exposición y memoria sin necesidad; `PUT` firmado cubre el upload directo.

## Consecuencias

Salarivo confía el cifrado en reposo y la custodia de sus claves a Cloudflare. La pérdida del token de verificación o un drift de privacidad, CORS o lifecycle deja API y worker sin iniciar, que es el fallo seguro esperado. Gracias a la consistencia fuerte de la API S3 de R2, borrar un marcador u objeto revoca el `If-Match` pendiente y permite liberar su reserva después de confirmar el delete; AWS conserva su ventana de gracia.

El free tier vigente para Standard incluye 10 GB-month, un millón de operaciones Class A y diez millones Class B por mes, con egress R2 sin cargo. Es una franquicia, no un plan sin sobrecosto: superar almacenamiento u operaciones genera cargos. El tope de 8.000.000.000 bytes limita el crecimiento normal originado por Salarivo, pero Cloudflare no ofrece un hard spending cap y las operaciones todavía pueden exceder el free tier. Los umbrales USD 1/USD 3 sólo notifican.

Esta decisión habilita el adapter productivo de storage; no levanta el NO-GO para datos reales. Backups cifrados con restore probado, ventana de purge y lista de supresiones posterior a restore, además de los demás P0 de retención, proveedor y operación, siguen bloqueando ese GO según [Retención y eliminación](../privacy/data-retention.md) y la [auditoría de privacidad y seguridad](../security/privacy-security-audit-2026-08-30.md).

## Evidencia

- Configuración productiva explícita en API y worker, con caminos separados para AWS y R2.
- Tests de arranque fail-closed para storage class, dominios públicos, las reglas CORS exactas de upload y descarga, y lifecycle; además cubren marcador, headers firmados, descarga `inline`/`attachment`, no reemisión sin ETag y reconciliación de carreras de copia.
- Documentación oficial de Cloudflare sobre [seguridad de datos](https://developers.cloudflare.com/r2/reference/data-security/), [buckets públicos](https://developers.cloudflare.com/r2/buckets/public-buckets/), [URLs firmadas](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [compatibilidad S3](https://developers.cloudflare.com/r2/api/s3/api/), [condiciones de Copy](https://developers.cloudflare.com/r2/api/s3/extensions/), [consistencia](https://developers.cloudflare.com/r2/reference/consistency/), [precios](https://developers.cloudflare.com/r2/pricing/) y [Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).
