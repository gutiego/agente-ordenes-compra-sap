# SOLUCIÓN · Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra y verifica de memoria que proveedor, centro de costo, aprobador y montos cuadren. Les duele a ella (tiempo y errores), a contabilidad (errores que se corrigen en el cierre) y a la dirección, que no sabe cuántas OC se crean después de la factura.

## 2. Arquitectura

```
┌───────────────┐  POST /api/chat   ┌──────────────────────────────────────────┐
│ web/index.html│ ────────────────▶ │ src/server.ts (Hono)                     │
│ chat, tool    │ ◀──────────────── │  └ src/agent/ciclo.ts  (bucle, topes, CA3)│
│ calls, botón  │  reply, toolCalls,│  └ src/agent/sesiones.ts (memoria+archivo)│
│ confirmar     │  needsConfirmation│  └ src/llm/adapter.ts → anthropic.ts      │
└───────────────┘                   │  └ src/tools/registro.ts (zod, log)       │
                                    └──────────────┬───────────────────────────┘
                                                   │ oc_* (src/tools/oc.ts)
                      ┌────────────────────────────┼─────────────────────────────┐
                      ▼                            ▼                             ▼
         paquete.ts / maestros.ts        controles.ts (RC1–RC10)       payload.ts / evidencia.ts
                      │                            │                             │
          fixtures/reto-03 (solo lectura)   src/knowledge/reglas-oc.json   src/sap/mock.ts (SapAdapter)
                                                                                 │
                                                  out/ (control.csv, sap/ordenes.jsonl, <caso>/…, log.jsonl)
```

- **Comportamiento**: `agent/prompt.md`, que se carga al arrancar.
- **Conocimiento**: `src/knowledge/ordenes-compra.md` se concatena al prompt. Los umbrales configurables están en `src/knowledge/reglas-oc.json`: tolerancia del 2 %, ±1, sociedad 1000, número inicial de OC, texto breve de 40 caracteres y patrones de unidad.
- **Ejecución**: `src/tools/oc.ts` contiene las 5 herramientas. Los helpers puros están en archivos aparte, porque solo los exports de `oc.ts` son herramientas.

Cambiar una regla de negocio toca `reglas-oc.json` o `controles.ts`, nunca el servidor.

## 3. Ciclo del agente

El núcleo es el del reto 01, ya probado con el modelo real, y se reutilizó sin cambios (`src/agent/ciclo.ts`):

- **Bucle**: mensaje del usuario → `ProveedorLLM.enviar(mensajes, herramientas, sistema)` → si hay `tool_use`, ejecuta cada herramienta con `ejecutarHerramienta` (valida los argumentos con zod, nunca lanza y registra en `out/log.jsonl`) → devuelve los resultados al modelo → repite.
- **Tope (CA1)**: hay un máximo de `MAX_ITERACIONES` (25) llamadas al modelo por turno. Al alcanzarlo responde, sin otra llamada, con la lista de lo que hizo. También hay un tope de tokens por sesión (`MAX_TOKENS_SESION`).
- **Confirmación humana (CA3)**: un turno queda "esperando confirmación" en dos casos: si alguna herramienta devolvió `pide_confirmacion: true` (lo hacen `oc_validar` y `oc_construir_payload` cuando hay confirmaciones, y `oc_crear` cuando las rechaza), o si el texto termina en una pregunta de confirmación. En el siguiente mensaje el servidor calcula `ctx.confirmacionHumana`: es `true` solo si el turno anterior pidió confirmación y el mensaje la da ("confirmo", "sí"…; una negación siempre gana). `oc_crear` exige `confirmado: true` **y** que `ctx.confirmacionHumana` no sea `false`, así el modelo no puede autoconfirmarse. El front resalta ese estado con un borde amarillo y los botones "Sí, confirmo / No, todavía no".
- **Errores (CA5)**: los errores del proveedor (clave, rate limit, timeout, conexión) se traducen a lenguaje claro y la sesión sigue viva.

## 4. Elección del modelo

- **Proveedor y modelo**: Anthropic `claude-opus-5-5`, con `effort: medium` y el fallback server-side activado (`server-side-fallback-2026-07-01`), que reintenta en otro modelo si hay un rechazo por política.
- **Por qué**: sigue bien el uso de herramientas en varios pasos, respeta reglas del tipo "no afirmes valores que no salieron de una herramienta" y redacta en español con tablas. Además, el adaptador ya estaba probado en el reto 01.
- **Costo observado**: con el prompt de la sección 11 sobre `sol-004`, el primer turno hizo 4 llamadas a herramientas y gastó unos 29,8 k tokens. El turno "confirmo" hizo 1 llamada (`oc_crear`) y gastó unos 20,8 k. En total, unos **50,7 k tokens por caso** en dos turnos. El registro de la sesión guarda el total, sin separar entrada y salida. Si se supone un ~90 % de entrada (el system prompt y el historial se reenvían en cada iteración), salen unos 45,6 k de entrada × $4/M ≈ $0,18 y unos 5,1 k de salida × $20/M ≈ $0,10: **≈ US$ 0,28 por caso**. Con prompt caching del system prompt y las herramientas bajaría a menos de la mitad.

## 5. Matriz de controles

| # | Implementación (`src/tools/controles.ts`) | Tipo | Caso que lo ejercita |
|---|---|---|---|
| RC1 | `buscarProveedor`: busca por NIT normalizado (sin puntos ni DV). Si no hay NIT, compara el nombre normalizado (sin tildes ni puntuación, en minúsculas). Inexistente o inactivo → bloqueo con acción para Datos Maestros. Si lo encuentra por nombre, informa el NIT derivado. En `oc_crear` se vuelve a consultar con `SapAdapter.consultarProveedor`. | Bloqueo | sol-002 (inexistente), sol-006 (por nombre) |
| RC2 | La aprobación existe, el cuerpo contiene la palabra `aprobado` (regex de palabra, configurable) y `de` está entre los aprobadores del centro. Si no, el bloqueo lista los aprobadores válidos. | Bloqueo | sol-003 (fvargas no aprueba CC-2020) |
| RC3 | `valor_total` ≤ tope del aprobador. Si el aprobador no es del centro, se compara con el **tope máximo del centro**, para reportar todas las razones a la vez. | Bloqueo | sol-003 (74 M > 30 M) |
| RC4 | El centro de costo existe y la subárea pertenece a él. | Bloqueo | todos |
| RC5 | `|cot − sol| / sol` > 2 % → confirmación con `valores: { solicitud, cotizacion, diferencia, porcentaje }`. Sin cotización legible también pide confirmación. La OC se crea por el valor de la solicitud. | Confirmación | sol-004 (6,00 %) |
| RC6 | Sin `indicador_iva` → se deriva `indicador_iva_default` del proveedor, se registra como derivado y pide confirmación. | Confirmación + derivado | sol-006 (C1) |
| RC7 | Sin `condiciones_pago` → se derivan del proveedor. Solo se informa. | Derivado | sol-006 (Z030) |
| RC8 | Hay factura con `fecha` < `fecha_solicitud` → `retroactiva = true`, confirmación y columna `retroactiva` en `control.csv`, tanto en los intentos pendientes como en los creados. | Confirmación | sol-005 |
| RC9 | Se compara la fecha de la aprobación (solo la parte `YYYY-MM-DD`) con `fecha_solicitud`; si es anterior, pide confirmación. | Confirmación | ninguno de los fixtures |
| RC10 | `|cantidad × valor_unitario − valor_total|` > 1 → bloqueo. | Bloqueo | ninguno de los fixtures |

Resultados de la demo:

| Caso | Resultado |
|---|---|
| sol-001 | OC 4500000001 sin intervención; al repetirlo, el mismo número (idempotente). |
| sol-002 | Bloqueo RC1. |
| sol-003 | Bloqueos RC2 + RC3. |
| sol-004 | Confirmación RC5: 25.000.000 vs 26.500.000. |
| sol-005 | Confirmación RC8, retroactiva. |
| sol-006 | Confirmación RC6 y derivados de proveedor, IVA y condiciones. |

**El más difícil fue RC3 en sol-003.** El PRD define el tope "del aprobador para ese centro", pero en sol-003 el aprobador **no es** del centro, así que formalmente no tiene tope ahí. Si solo se reportara RC2, la analista conseguiría la aprobación de rtorres y volvería a quedar bloqueada porque 74 M supera su tope de 30 M. Por eso, cuando el aprobador no pertenece al centro, RC3 compara contra el tope máximo del centro y la respuesta trae las dos razones con sus acciones: pedir la aprobación al centro correcto y escalar o ajustar el monto. El segundo más delicado fue RC5: hay que pedir confirmación sin "arreglar" nunca el monto, de modo que la OC siempre usa el precio aprobado de la solicitud.

## 6. Diseño del adaptador SAP real

**Opción elegida**: OData V2 `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA), expuesto a través de **SAP Integration Suite** o de SAP API Management si el cliente lo tiene.

- Es la API pública, estable y documentada para crear OC. Valida igual que la transacción ME21N, devuelve el número de OC en la respuesta y no requiere conectores nativos ni SAP JCo/NCo en el agente.
- Con viabilidad no confirmada, OData es lo que el equipo de Basis habilita más rápido (una comunicación y un usuario técnico en el Communication Arrangement SAP_COM_0053).
- `BAPI_PO_CREATE1` por RFC queda como alternativa si el sistema es ECC sin Gateway. Exige SAP NW RFC SDK en el backend y gestionar `BAPI_TRANSACTION_COMMIT`.
- Integration Suite solo como intermediario si la política del cliente prohíbe el acceso directo.

**Mapeo** del payload de 7.4 a `A_PurchaseOrder`, con deep insert a `to_PurchaseOrderItem` y `to_AccountAssignment`:

| Payload (7.4) | OData |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespncExternalReference` (o un campo Z), clave de idempotencia |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `descripcion` | `PurchaseOrderItemText` (40) |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` (UN→`EA`/`ST`, H→`H`, MES→`MON` según la tabla T006 del cliente) |
| `precio_unitario` | `NetPriceAmount`, convertido a neto si el precio viene con IVA, según la política fiscal acordada |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `AccountAssignmentCategory = K` + `to_AccountAssignment.CostCenter` |
| `subarea` | campo de imputación o `GLAccount` según el mapeo de contabilidad |
| aprobador y excepciones | textos de cabecera (`to_PurchaseOrderNote`) |
| evidencia PDF | adjunto por `API_CV_ATTACHMENT_SRV` (GOS) con el sha256 en la descripción |

**Autenticación y credenciales**: OAuth 2.0 client credentials (o certificado X.509) con un usuario técnico de mínimo privilegio, que solo puede crear OC en la sociedad 1000. Las credenciales viven en el gestor de secretos del backend (Azure Key Vault o variables cifradas del despliegue) y se inyectan en la implementación `SapODataAdapter` de la interfaz `SapAdapter`. El modelo, el prompt y el front nunca las ven: el agente solo puede llamar a `oc_crear`.

**Idempotencia y errores parciales**:

- Antes de crear se llama a `buscarOrdenPorReferencia(solicitud_id)`, que filtra por la referencia externa. Solo se crea si no hay resultado.
- La creación es **un solo deep insert**: cabecera, posiciones e imputación en una transacción. SAP no deja una OC a medias.
- Ante un timeout o 5xx, se reintenta con backoff y **siempre se consulta primero** por referencia: si la OC se creó y la respuesta se perdió, se devuelve el número existente.
- Si la creación pasa pero falla el adjunto de la evidencia, el error es parcial. La OC queda registrada, `control.csv` marca `evidencia_pendiente` y un reintento solo sube el adjunto. Nunca se crea una OC nueva.
- Los mensajes de SAP (tabla de retorno o `sap-message`) se traducen a lenguaje claro para la analista.

**Plan B (sin conexión)**: el agente sigue haciendo todo menos el último clic.

1. Genera la OC **lista para pegar**: tabla con el orden de campos de ME21N, que la analista copia en SAP GUI.
2. Genera un **archivo de carga masiva** (CSV/XLSX para LSMW o la app "Import Purchase Orders" de S/4) con las OC aprobadas del día.
3. La analista devuelve el número de OC por el chat y una herramienta lo registra en `control.csv`.

Así se ahorra la digitación y la validación mental aunque no haya integración. Por eso el `SapAdapter` es una interfaz: el plan B sería otra implementación (`SapArchivoAdapter`) sin tocar el agente.

## 7. Lectura del proceso: OC retroactivas

Para la dirección: una OC retroactiva no es un error de digitación. Es una compra que se **comprometió sin control previo**: el proveedor ya entregó y facturó antes de que alguien validara presupuesto, aprobador y precio. En los fixtures, sol-005 lo muestra bien: la factura es del 10 de agosto, la solicitud del 27 y la aprobación del 28. El líder escribe "ya llegó la factura, por favor crear la OC para poder radicarla". La OC deja de ser un control y se vuelve un trámite para poder pagar. El riesgo es concreto: se paga lo que el proveedor facturó y no lo que se negoció, la cotización deja de servir para comparar y los topes de aprobación se validan cuando el gasto ya es irreversible.

Lo que el agente aporta hoy es **medición**: cada intento queda en `out/control.csv` con `retroactiva = true/false`, así que la dirección puede ver el porcentaje de OC retroactivas por centro de costo, por proveedor y por aprobador. Mi recomendación es medir 4–6 semanas sin cambiar la política para tener una línea base, y luego aplicar tres cambios:

1. Comunicar a los proveedores recurrentes que **no se radica factura sin número de OC**. Es la palanca más efectiva y la usan la mayoría de las empresas.
2. Para gastos recurrentes (papelería, licencias, servicios), crear **OC marco o abiertas** trimestrales, para que el pedido del día a día no requiera una OC nueva.
3. Que la política sobre retroactivas la decida la dirección financiera: tolerarlas con marca y justificación obligatoria por encima de cierto monto, o exigir aprobación de un nivel superior. El agente ya lo soporta: es cambiar RC8 de confirmación a bloqueo por umbral en `reglas-oc.json`.

## 8. Decisiones y trade-offs

1. **Las herramientas recalculan todo desde el caso (CA2) en lugar de confiar en lo que envía el modelo.** `oc_validar`, `oc_construir_payload` y `oc_crear` releen fixtures y maestros. `oc_crear` compara el payload recibido con el recalculado (serialización canónica) y rechaza si difiere; la demo lo prueba con un precio "ajustado". Alternativa descartada: guardar el payload en sesión y crear desde ahí, porque acopla las herramientas al servidor y `demo.ts` no las podría usar igual. El costo es releer archivos pequeños en cada llamada, que es despreciable.
2. **El RC3 "extendido" al tope máximo del centro** cuando el aprobador no es del centro, para reportar todas las razones (ver §5). Alternativa: reportar solo RC2, pero la analista tendría que hacer dos idas y vueltas.
3. **La evidencia tiene un contenido canónico determinista** y su sha256 se calcula igual en `construir_payload` y en `generar_evidencia`, sin depender del orden de llamada. Alternativa: hashear el PDF, pero pdf-lib incluye fechas de creación y el hash cambiaría en cada ejecución.
4. **Precio y cantidad de la OC = solicitud aprobada**, nunca la cotización, incluso cuando hay diferencia. Es lo que el líder aprobó ("Aprobado por 25 millones según la solicitud"); la diferencia viaja como excepción confirmada. Alternativa: usar la cotización, pero eso sería "arreglar" el monto.
5. **Node 20 + tsx en lugar de Bun**: Bun no estaba instalado en la máquina y el PRD acepta Node 20+. `tsx` ejecuta TypeScript sin compilar y `tsc --noEmit` valida tipos.
6. **SAP simulado con JSONL y numeración = 4500000001 + número de líneas.** Es simple y determinista. Alternativa: un contador en un archivo aparte, que agrega un segundo punto de fallo sin beneficio en un mock.

## 9. Supuestos

- `fixtures/` sigue la convención del PRD (`fixtures/reto-03/...`). Los fixtures se copiaron sin modificar.
- Los montos de solicitud, cotización y topes están en la misma moneda e **incluyen IVA**. El precio unitario del payload es el de la solicitud (IVA incluido), igual que en la cotización.
- El NIT se compara sin puntos ni dígito de verificación (`900.555.111-2` ≡ `900555111`).
- La "validez" de la cotización se calcula como fecha de cotización + días. Se informa, no se controla, porque no está entre RC1–RC10.
- RC9 compara solo fechas (sin hora); la aprobación del mismo día es válida.
- Unidad: `H` si la descripción o el ítem cotizado menciona horas, `MES` si dice mensual o por mes, y `UN` en otro caso. sol-001 dice "12 meses" de vigencia, pero se compran 120 licencias, así que es `UN`.
- El texto breve se recorta a 40 caracteres en límite de palabra y sin conectores colgando. La trazabilidad deja la nota del recorte.
- `confirmado_por` registra `analista (sesión <id>)`, porque no hay autenticación de usuarios (no-objetivo del PRD).
- Además de `solicitud`, `cotizacion`, `maestro.<nombre>` y `derivado`, la trazabilidad usa dos fuentes más: `correo` (correo_id) y `aprobacion` (email y fecha del aprobador), porque son su origen real.
- Cada llamada a `oc_crear` agrega una fila a `control.csv`, incluidas `pendiente_confirmacion`, `bloqueada`, `existente` (idempotente) y `rechazada` (payload alterado).

## 10. Cobertura

| Historia | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Los adjuntos ausentes se reportan en `faltantes` y como `null`. Falta: leer .xlsx/.pdf/.eml reales (`oc_leer_excel` es P1 y no se hizo). |
| HU-2 Validar | Hecho | RC1–RC10. Falta: consultar maestros en SAP en tiempo real. |
| HU-3 Payload | Hecho | Esquema zod + `trazabilidad.json`. Falta: OC de varias posiciones (la solicitud trae una). |
| HU-4 Evidencia | Hecho (P0 txt + P1 pdf) | Falta: firma digital si auditoría la exige. |
| HU-5 Crear en SAP simulado | Hecho | Idempotencia, numeración y `control.csv`. Falta: el adaptador OData real (§6). |
| HU-6 Errores | Hecho | `{ ok:false, error }` legible para caso inexistente, JSON corrupto, monto no numérico y argumentos inválidos. |
| Front / API / ciclo | Hecho | Las tool calls son visibles y la confirmación se resalta. Sin streaming. |
| Link público | Hecho | https://reto-03-ordenes-compra-sap.onrender.com (Render, plan gratuito). |
| Bonus `modulo/` | Hecho | Se regenera desde las mismas fuentes (`npm run modulo`). |

## 11. Uso de IA

- **Claude Code (Claude Opus 5.5)** con subagentes. Lo usé para leer el PRD y los fixtures, adaptar el núcleo del reto 01 (ciclo, sesiones, adaptador LLM, registro de herramientas, servidor y front, reutilizados casi sin cambios), escribir controles, payload, evidencia, adaptador SAP y demo, y redactar esta documentación.
- **Qué revisé o descarté**:
  - Descarté que `oc_crear` aceptara el payload del modelo como fuente de verdad: ahora se recalcula y se compara.
  - Descarté ajustar el precio de la OC al de la cotización: se confirma, no se corrige.
  - Corregí un patrón de unidad que se escribió con `\b` mal escapado en JSON, porque `sol-004` salía en `UN` en vez de `H`. La demo lo detectó.
  - Agregué el recorte del texto breve sin conectores colgando ("…arquitectura de").
- Todo el código es TypeScript estricto sin `any` y pasa `tsc --noEmit`. Puedo explicar cada línea.

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo. | Plan B de §6 (OC lista para pegar o carga masiva) detrás de la misma interfaz `SapAdapter`. |
| El modelo "arregla" montos o se autoconfirma. | Las herramientas recalculan desde la fuente y rechazan los payloads distintos. `confirmacionHumana` la fija el servidor, no el modelo. |
| Prompt injection en el cuerpo de correos o cotizaciones ("ignora los controles…"). | Los controles son código determinista: el texto del correo solo alimenta la búsqueda de "Aprobado" y la evidencia. Ninguna instrucción del correo cambia una regla. |
| Maestros desactualizados (los fixtures son una foto). | En producción, `consultarProveedor` y los centros y aprobadores se leen de SAP o del IdP en tiempo real. |
| Correo de aprobación falsificado o reenviado. | Validar cabeceras (DKIM/SPF) en la ingesta o pasar a aprobación con firma o workflow. Mientras tanto, el sha256 de la evidencia hace trazable cualquier alteración posterior. |
| Concurrencia: dos analistas procesan el mismo caso. | Idempotencia por `solicitud_id` en SAP y bloqueo por solicitud en el backend; el mock JSONL no es concurrente. |
| Costo del LLM sin control. | Topes de iteraciones y de tokens por sesión ya configurables. Agregar autenticación del link y rate limit por IP. |
| Datos personales en logs. | `out/log.jsonl` guarda solo resúmenes, nunca la clave. En producción: retención limitada y almacenamiento cifrado. |
