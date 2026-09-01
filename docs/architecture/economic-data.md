# Datos económicos

> Estado (2026-09-01): V1 implementa contexto económico para el perfil `AR` + `ARS`. No hay otros países, selección libre de referencia, adapter BCRA directo, consola administrativa ni cache materializada de valuaciones salariales.

## Propósito e invariantes

Economic Data incorpora contexto histórico sin cambiar la fuente salarial:

~~~text
liquidación nominal privada ─┐
                            ├─ economic-analytics-v1 ─> nominal / USD histórico / poder adquisitivo
observación económica global ┘
~~~

- La liquidación y su moneda original nunca se reemplazan.
- País y moneda se resuelven por separado mediante un perfil explícito.
- Series, observaciones y jobs son globales; los cálculos que revelan salario siguen siendo owner-only.
- El proveedor recibe sólo un identificador público de serie, un rango y opciones técnicas fijas, sin contexto de usuario.
- Toda ausencia produce un estado explícito, no una observación inventada.

El paquete `@salarivo/economic-data` no depende de framework, base de datos ni SDK. Define los tipos, perfiles, validaciones, resolución y aritmética exacta. `ExchangeRateProvider` y `PriceIndexProvider` obtienen rangos y aceptan `AbortSignal`; el adapter y la sincronización viven en el worker, y API combina en batch las observaciones con analytics.

## Perfil y fuentes V1

El único perfil es `PROFILE.AR.ARS`: país `AR`, moneda nominal `ARS` y moneda de referencia `USD`.

| Uso | Serie interna | Serie de Datos Argentina | Fuente primaria | Frecuencia |
| --- | --- | --- | --- | --- |
| USD histórico | `FX.AR.USD.ARS.REFERENCE` | [`175.1_DR_REFE500_0_0_25`](https://www.datos.gob.ar/es/dataset/sspm-tipos-cambio-historicos/archivo/sspm_175.1) | [BCRA, referencia Comunicación A 3500](https://www.bcra.gob.ar/tipo-cambio-referencia-comunicacion-a-3500-tcnpm/) | diaria |
| poder adquisitivo | `PRICE_INDEX.AR.GENERAL` | [`145.3_INGNACNAL_DICI_M_15`](https://www.datos.gob.ar/es/dataset/sspm-indice-precios-al-consumidor-nacional-ipc-base-diciembre-2016/archivo/sspm_145.3) | [INDEC, IPC nivel general nacional](https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31) | mensual |

El canal integrado es Datos Argentina y el adapter registra atribución y licencia [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). No se hardcodean valores económicos. Un adapter BCRA directo queda excluido hasta confirmar por escrito autorización y condiciones de reutilización comercial del canal oficial.

## Modelo persistido

| Tabla global | Contenido | Invariantes principales |
| --- | --- | --- |
| `economic_series` | identidad interna/externa, tipo, frecuencia, país, par de monedas, variante, proveedor, fuente, metodología y vigencia | código interno y `(provider, external id)` únicos; FX exige base/quote; IPC no tiene monedas |
| `economic_observations` | fecha, valor `NUMERIC(30,12)`, revisión, hash del payload, timestamps y metadata no sensible | valor positivo; `(series, date, revision)` único; triggers bloquean update, delete y truncate |
| `economic_sync_jobs` | serie, rango, estado, disponibilidad, attempts, lease y error sanitizado | rango válido, lease coherente y un único job activo por serie |

Ninguna tabla contiene user, employment, document, settlement o salario. La consulta de analytics toma la última revisión de cada fecha en una sola lectura por lote; el ID y la revisión seleccionados forman parte de la procedencia devuelta.

La migración 022 crea las tres tablas y sus constraints; la 023 exige el hash SHA-256 de la respuesta del proveedor en toda observación nueva. Si una instalación alcanzó a persistir filas entre ambas migraciones, las conserva como legado sin inventar un hash y sin debilitar el trigger append-only.

## Sincronización, revisiones y last-known-good

El worker registra las definiciones V1 de manera idempotente y comprueba que no hayan cambiado silenciosamente. A partir de liquidaciones `AR`/`ARS` utilizables por analytics, determina la cobertura necesaria, busca fechas ausentes y agenda sólo esos rangos. La cobertura FX comienza siete días antes del primer target, sin cruzar la vigencia de la serie, para cubrir el fallback permitido. Los bloques de backfill están acotados; el IPC extiende su necesidad hasta el mes actual para obtener una referencia reciente.

Además del backfill, se reconsulta una ventana reciente —35 días para FX, tres meses para IPC— para detectar correcciones sin descargar toda la serie. El planner no reencola el mismo rango si terminó en las últimas seis horas para FX o veinticuatro para IPC. Si un valor validado cambió, agrega la siguiente revisión bajo lock; si es igual, no duplica la fila.

Los jobs usan lease, máximo de intentos, retry exponencial con jitter y códigos de error sanitizados. Un lease vencido vuelve a retry o termina fallido según sus intentos. El fallo no borra observaciones: la revisión válida más reciente queda disponible como last-known-good. Un rango nunca observado permanece pendiente o sin cobertura.

## Fechas y resolución

La fecha objetivo de FX conserva un método explícito:

1. `PAYMENT_DATE` si existe `paymentDate`;
2. `ISSUE_DATE` si no hay pago y existe `issueDate`;
3. `PAYROLL_PERIOD_END`, último día calendario del período, en los demás casos.

El parser de recibos vigente no completa `payment_date` ni `issue_date`; por eso las liquidaciones extraídas hoy usan `PAYROLL_PERIOD_END`. La precedencia queda operativa para datos que sí tengan esas fechas, sin inferirlas desde upload u otros timestamps.

Se usa la observación exacta o la anterior más cercana dentro de siete días calendario. No se cruza ese límite, no se elige una fecha futura y nunca se usa la cotización actual como sustituto.

Las fechas económicas son días calendario `YYYY-MM-DD`, no timestamps sujetos al huso del proceso. Los timestamps técnicos de fetch y jobs se normalizan en UTC.

El IPC fuente debe existir exactamente en el mes de la liquidación y usar el primer día del mes como clave. No hay interpolación. El target es la última observación mensual disponible, cuyo período se muestra como referencia; no se asume que coincida con el presente.

Cuando una fecha tiene varias revisiones, gana el número de revisión más alto sin descartar su ID ni metadata.

## Aritmética exacta

La cotización se orienta como `1 base = rate quote`:

~~~text
base a quote = amount × rate
quote a base = amount ÷ rate

adjusted = nominal × targetIndex ÷ sourceIndex
change % = (toValue ÷ fromValue - 1) × 100
~~~

Los inputs decimales se validan y se calculan como coeficientes y escalas `BigInt`. Dinero y cambio porcentual se devuelven con dos decimales y redondean a la mitad alejándose de cero. Un rate o índice faltante devuelve ausencia; cero, negativos, pares incompatibles y formatos fuera de límite fallan validación.

## API, estados y privacidad

API solicita todas las observaciones necesarias como un snapshot batched y evita N+1 por liquidación. Cada referencia conserva serie interna y externa, observation ID, revisión, fecha pedida/usada, método, proveedor, fuente, metodología, enlace de licencia y fecha de fetch.

Las perspectivas económicas declaran:

- `AVAILABLE`: todas las observaciones necesarias existen;
- `PARTIAL`: parte del cálculo está disponible;
- `PENDING`: falta sincronización o hay un job activo;
- `UNAVAILABLE`: no hay cobertura o el proveedor falló sin una observación aplicable.

El historial nominal permanece disponible en todos los casos. No existe una valuación salarial persistida ni una cache de analytics: el resultado se deriva en cada request desde la liquidación vigente y las últimas revisiones válidas.

Serie y observación global son datos públicos. Al combinarlas con un salario, equivalentes, ajustes y variaciones pasan a `Restricted`, conservan ownership y se ocultan con Privacy Mode en texto, tablas y gráficos. El cambio público del índice puede mostrarse sin revelar el salario.

## Agregar un proveedor o país

Un proveedor nuevo debe:

1. implementar `ExchangeRateProvider`, `PriceIndexProvider` o ambos;
2. agregar routing explícito por `providerCode` al worker, que en V1 instancia un único adapter Datos Argentina;
3. mapear cada serie externa a un código interno estable con fuente, metodología, licencia y orientación;
4. usar destinos allowlisted, cancelación, timeout, cuerpo acotado y validación estricta;
5. probar rangos, formatos hostiles, revisiones, retries y procedencia sin depender de Internet.

Un país o combinación de moneda nuevo agrega un perfil central por `countryCode` + `currencyCode`, la moneda de referencia y las series compatibles. También debe extender el planner del worker, que hoy calcula rangos requeridos sólo para `AR` + `ARS`; el salary analytics no cambia ni incorpora ramas por país. Si el caso necesita otra frecuencia, tipo o regla, primero se amplía el contrato y su persistencia con evidencia concreta.

La operación se configura en código versionado y tablas globales actuales. No se presupone una UI administrativa ni una cache de analytics inexistentes; `economic_observations` sí es la copia local compartida de la fuente pública.

La decisión completa y sus alternativas están en el [ADR 0016](../adr/0016-global-economic-data-and-derived-context.md).
