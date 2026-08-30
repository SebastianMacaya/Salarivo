# ADR 0006 — Entitlements y benchmark salarial de mercado

- Estado: Proposed
- Fecha: 2026-08-29

## Contexto

El MVP aplica límites globales configurados para imports, documentos, bytes y concurrencia. Una evolución comercial puede ofrecer cuotas o capacidades diferentes y comparar la remuneración del usuario con cohortes agregadas de otros usuarios, sin acoplar las reglas del producto a un proveedor de cobro ni permitir conocer persona, empresa o sueldo individual.

Salarivo ya soporta múltiples Employer y Employment propios por usuario; esa capacidad no depende de un plan futuro.

## Decisión propuesta

Los límites actuales son defaults globales. Una futura resolución server-side de entitlements entregará capacidades habilitadas y límites efectivos para cada cuenta. Los casos de uso consultarán ese resultado en el servidor antes de autorizar una operación; billing será sólo un adapter que informa estado comercial y no formará parte de las reglas de dominio.

Un downgrade puede impedir nuevas operaciones que excedan el entitlement vigente, pero nunca borra datos, rompe ownership ni elimina acceso a exportación o borrado. Los datos ya aceptados conservan sus políticas de privacidad y retención.

El benchmark futuro se construirá principalmente con contribuciones derivadas de PayrollSettlement verificados, en una capa separada del historial privado. Participar requiere consentimiento específico, revocable y desactivado por defecto. El historial sigue siendo privado aunque el usuario no contribuya.

Ese consentimiento tendrá documento y versión propios; no se obtiene mediante la aceptación obligatoria de Términos ni mediante frases amplias como “mejorar la experiencia”. Un cambio material de finalidad o campos requiere una nueva adhesión.

Las cohortes serán predefinidas y amplias: familia de rol, seniority, Argentina o región amplia, industria y período. No habrá filtro por empresa. Cada resultado expondrá sólo percentiles o bandas, versión/período y un sample size redondeado; nunca filas, documentos ni valores individuales.

La publicación exige un k mínimo configurable. Un valor de 20 o más puede servir como punto de partida para pruebas, pero no fija la política final. Anti-differencing, query budgets y demoras de publicación limitarán la reconstrucción por consultas repetidas o cohortes que cambian de a una persona.

Un mapping privado y restringido vinculará cada contribución con su origen sólo para deduplicar y permitir retiro o borrado. Revocar consentimiento o eliminar datos excluye esas contribuciones y obliga a recomputar los agregados afectados. Ese mapping nunca se expone al plano de consulta.

Datasets externos versionados podrán usarse como calibración opcional, no como fuente principal. IA no es necesaria para la primera versión del benchmark.

## Alternativas

- Consultar billing directamente desde cada feature: rechazado por acoplamiento, disponibilidad y reglas inconsistentes.
- Borrar datos al bajar de plan: rechazado por integridad, privacidad y pérdida irreversible.
- Usar datasets externos como fuente principal: rechazado porque no representa la historia salarial privada que el producto puede agregar con consentimiento.
- Incorporar salarios privados por defecto: rechazado por privacidad y falta de consentimiento.
- Permitir filtros por empresa, filas o consultas arbitrarias en tiempo real: rechazado por riesgo de identificación y differencing.
- Estimar mercado con LLM: rechazado para el inicio porque no aporta una cohorte verificable ni controles de privacidad.

## Consecuencias

- Las capacidades pagas podrán cambiar de proveedor sin reescribir el dominio.
- Una cuota limita nuevas acciones, no la propiedad de datos existentes.
- Una comparación puede no estar disponible si la cohorte no alcanza el k mínimo.
- El benchmark es una proyección informativa versionada, no modifica el historial salarial verificado.
- La publicación deliberadamente redondeada y demorada reduce precisión para proteger a quienes contribuyen.
- Retiro y borrado requieren recomputar agregados sin conservar la contribución excluida.

## Para aceptar

Implementación y tests deben demostrar enforcement server-side, aislamiento entre usuarios y downgrade sin pérdida de datos. El benchmark debe contar antes con aviso/consentimiento específico aprobado y versionado, y probar revocación, deduplicación, retiro/borrado con recomputación, k mínimo, sample size redondeado, anti-differencing, query budget y demora; no debe ofrecer filtros por empresa, filas ni contribuciones sin consentimiento válido.
