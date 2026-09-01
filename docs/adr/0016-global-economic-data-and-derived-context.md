# ADR 0016 — Datos económicos globales y contexto salarial derivado

- Estado: Accepted
- Fecha: 2026-09-01
- Extiende: [ADR 0013](0013-derived-salary-history-analytics.md), reemplazando sólo la exclusión provisional de IPC y contexto económico

## Contexto

El ADR 0013 dejó fuera IPC y variación real hasta poder identificar fuente, serie, período, versión y método de cálculo. Esas condiciones ya tienen una implementación concreta. El monto nominal extraído sigue siendo la fuente de verdad; un equivalente histórico o un valor ajustado no puede reemplazarlo ni convertirse en autoridad contable.

Cotizaciones e índices son datos públicos compartidos, no datos de una cuenta. Consultarlos por cada salario duplicaría requests y acoplaría la disponibilidad del proveedor al producto privado. También perdería reproducibilidad si una fuente corrige una observación.

## Decisión

### Dominio y alcance V1

`economic-analytics-v1` es una proyección derivada y separada de `salary-analytics-v1`. Combina el monto nominal autorizado con una observación económica global en el backend, sin persistir la valuación resultante ni modificar la liquidación.

El núcleo compartido define series, observaciones, perfiles económicos y los ports `ExchangeRateProvider` y `PriceIndexProvider`, ambos por rango y con cancelación. País y moneda son dimensiones distintas. El único perfil habilitado en V1 es `AR` + `ARS`, con `USD` como moneda de referencia; otros pares, monedas y países no están habilitados por esa generalidad del modelo.

Las series tienen códigos internos estables y conservan tipo, frecuencia, país, variante, proveedor, identificador externo, fuente y metodología. V1 registra:

| Código interno | Identificador externo | Frecuencia y orientación | Canal / fuente primaria |
| --- | --- | --- | --- |
| `FX.AR.USD.ARS.REFERENCE` | `175.1_DR_REFE500_0_0_25` | diaria; `1 USD = value ARS` | Datos Argentina / BCRA, referencia Comunicación A 3500 |
| `PRICE_INDEX.AR.GENERAL` | `145.3_INGNACNAL_DICI_M_15` | mensual; nivel general nacional, base diciembre de 2016 | Datos Argentina / INDEC |

El adapter V1 consume la API de Series de Tiempo de Datos Argentina y conserva atribución y licencia [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [La ficha de la serie cambiaria](https://www.datos.gob.ar/es/dataset/sspm-tipos-cambio-historicos/archivo/sspm_175.1) identifica la referencia diaria y [la ficha del IPC](https://www.datos.gob.ar/es/dataset/sspm-indice-precios-al-consumidor-nacional-ipc-base-diciembre-2016/archivo/sspm_145.3) identifica el índice mensual. BCRA e INDEC son las fuentes primarias; Datos Argentina es el canal integrado.

No existe un adapter directo al BCRA en V1. [La descarga oficial del BCRA](https://www.bcra.gob.ar/tipo-cambio-referencia-comunicacion-a-3500-tcnpm/) no se integrará directamente hasta confirmar por escrito autorización y condiciones de reutilización comercial para ese canal. Esta restricción no altera la atribución del BCRA como fuente primaria de la serie distribuida por Datos Argentina.

### Persistencia y sincronización

`economic_series`, `economic_observations` y `economic_sync_jobs` son globales: no tienen `user_id`, `document_id` ni importes salariales. Las observaciones usan decimal exacto y son append-only por fecha y revisión. Un valor validado distinto agrega una revisión; la lectura elige la última revisión validada y conserva las anteriores para reproducir resultados.

El worker siembra las definiciones conocidas, calcula los rangos requeridos, detecta huecos y programa backfill acotado. Refresca una ventana reciente para detectar revisiones sin descargar toda la historia. Los jobs tienen rango, lease, attempts, backoff y estados `PENDING`, `RUNNING`, `RETRYABLE`, `COMPLETED`, `FAILED` y `CANCELLED`; una restricción permite como máximo un job activo por serie.

Una respuesta idéntica no crea otra revisión. Ante timeout, respuesta inválida o fallo del proveedor, la última revisión válida permanece como last-known-good. Los huecos nuevos quedan pendientes o sin cobertura; nunca se rellenan con valores inventados.

### Resolución y fórmulas

Para FX se selecciona la fecha objetivo en este orden:

1. `paymentDate`;
2. `issueDate`;
3. último día calendario de `payrollPeriod`.

La respuesta conserva fecha objetivo y método. Si no existe una observación diaria exacta, se permite sólo la observación anterior más cercana dentro de siete días calendario; no se usa una futura ni la cotización actual.

El parser vigente no persiste todavía fechas de pago o emisión; esas liquidaciones resuelven por fin de período. La regla ya admite ambos campos cuando exista una fuente verificada que los complete, sin inferirlos desde timestamps técnicos.

El IPC de origen debe corresponder exactamente al mes salarial. No se interpola entre meses. El período de referencia es la observación mensual más reciente disponible y se muestra explícitamente; no se presume que sea el mes corriente.

Una cotización usa la convención `1 base = rate quote`. Por lo tanto:

~~~text
base  -> quote = amount × rate
quote -> base  = amount ÷ rate
real amount    = nominal amount × target index ÷ source index
percent change = (to value ÷ from value - 1) × 100
~~~

Los decimales se transforman en razones de `BigInt`. No se usa punto flotante binario. Dinero y cambio porcentual se devuelven con dos decimales y redondean a la mitad alejándose de cero sólo en el límite de salida.

### Disponibilidad, privacidad y UX

La caída del proveedor no bloquea upload, parsing, liquidaciones ni la perspectiva nominal. Las perspectivas derivadas declaran `AVAILABLE`, `PARTIAL`, `PENDING` o `UNAVAILABLE` y distinguen falta de configuración, sincronización pendiente, proveedor no disponible y falta de cobertura. Un resultado parcial nunca oculta ni altera el nominal.

El request externo contiene sólo el identificador de serie, el rango y opciones técnicas fijas de respuesta. Nunca incluye usuario, empleo, salario, documento, filename, PDF, OCR ni correcciones, y esos datos tampoco entran en logs de sincronización. Las observaciones públicas pueden clasificarse como `Public`; el equivalente USD, poder adquisitivo y toda variación que permita inferir un salario son `Restricted` y quedan cubiertos por Privacy Mode. La variación del índice por sí sola sigue siendo un dato público.

No se materializa una cache ni una tabla de valuaciones salariales. Cada respuesta deriva desde la liquidación vigente y las observaciones revisionadas; así una nueva revisión o corrección salarial entra en el siguiente cálculo sin invalidación paralela.

## Alternativas consideradas

- **Llamar al proveedor por salario o desde el navegador:** rechazado por privacidad, N+1, falta de auditoría y dependencia del proveedor en cada lectura.
- **Integrar BCRA directamente sin términos confirmados:** rechazado hasta contar con autorización comercial verificable para ese canal.
- **Sobrescribir observaciones corregidas:** rechazado porque impide reproducir una valuación anterior.
- **Interpolar IPC o usar FX futuro/actual:** rechazado porque fabrica precisión y cambia el significado histórico.
- **Persistir equivalentes y ajustes por salario:** rechazado porque agrega invalidación y datos Restricted duplicados sin evidencia de necesidad.
- **Asumir Argentina desde la moneda:** rechazado; país y moneda deben coincidir con un perfil explícito.

## Consecuencias

- El salario nominal conserva su autoridad y los resultados económicos explican serie, revisión, fecha usada, método y fuente.
- Una revisión puede cambiar un cálculo futuro sin borrar la evidencia anterior.
- La disponibilidad parcial es esperable fuera de cobertura o durante backfill; no degrada el historial nominal.
- Sólo `AR` + `ARS` está configurado. La arquitectura genérica no promete soporte internacional ni selección libre de moneda.
- No hay consola administrativa de datos económicos ni cache materializada de valuaciones salariales; la operación actual se observa mediante jobs, códigos de error y cobertura persistida.

## Condiciones para ampliar

Agregar un proveedor exige implementar uno o ambos ports, sumar routing explícito por `providerCode` en el worker —V1 instancia sólo Datos Argentina—, registrar series con códigos internos estables, conservar fuente/metodología/licencia, allowlistear el destino, acotar timeout y cuerpo, validar schema/metadata/fechas/valores y cubrir abort, retries y respuestas hostiles con tests sin red.

Agregar un país o combinación de moneda exige registrar un perfil explícito por `countryCode` + `currencyCode`, sus series compatibles y una moneda de referencia, y extender el planner del worker que hoy deriva rangos sólo para `AR` + `ARS`. No se agregan `if country` al analytics salarial. Una frecuencia, tipo de serie o regla de resolución nueva requiere ampliar el dominio y la migración sólo cuando exista ese caso concreto, junto con fixtures matemáticos, de fechas, privacidad y degradación.

## Evidencia

- `packages/economic-data` y sus tests exactos de dirección, precisión, fechas, faltantes y revisiones.
- Migraciones `022_economic_data.sql` y `023_economic_observation_payload_hash.sql`, con observaciones append-only, hash de respuesta obligatorio para filas nuevas —sin fabricar procedencia para un posible legado entre migraciones—, índices por rango/revisión y jobs con lease/retry.
- Adapter Datos Argentina y sincronización/backfill del worker.
- Proyección batched de API y perspectivas nominal, USD histórico y poder adquisitivo en la web.
- Tests de provider, sync, API, Privacy Mode y migración.

Esta evidencia describe el código actual y no afirma por sí sola que el cambio esté desplegado en producción.
