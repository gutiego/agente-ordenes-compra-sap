# Reto 03 · Agente conversacional "Órdenes de Compra SAP"

Agente de chat que lee el paquete de una solicitud de compra (solicitud, cotización, aprobación y, si existe, factura), lo valida contra los maestros con los controles RC1–RC10, construye la OC, genera la evidencia de aprobación y crea la OC en un SAP simulado. Las excepciones se devuelven a la analista con una recomendación.

## Levantar en local

Requisitos: Node 20 o superior.

```bash
cp .env.example .env      # y pon tu ANTHROPIC_API_KEY
npm install && npm start  # http://localhost:3000
```

`npm run dev` arranca con recarga automática.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí, para el chat | Clave del modelo. Solo vive en el backend. No aparece en el front, los logs ni las respuestas. |
| `LLM_PROVIDER` | no | `anthropic` (por defecto). |
| `LLM_MODEL` | no | `claude-opus-5-5` (por defecto). |
| `LLM_TIMEOUT_MS` | no | Timeout por llamada al modelo (60000). |
| `MAX_ITERACIONES` | no | Tope de iteraciones herramienta → modelo por turno (25). |
| `MAX_TOKENS_SESION` | no | Tope de tokens por sesión (400000). |
| `PORT` | no | Puerto HTTP (3000). |
| `OUT_DIR` | no | Directorio de salida (`out`). |

Sin clave, el servidor arranca igual: el chat avisa que falta el modelo y las herramientas funcionan con la demo.

## Demo sin modelo

```bash
npm run demo     # o: npx tsx demo.ts
```

La demo limpia `out/`, procesa los 6 casos e imprime para cada uno `apta`, bloqueos (con su acción sugerida), confirmaciones, derivados, `retroactiva` y el número de OC o el motivo por el que no se creó. Después:

- ejecuta `sol-001` otra vez para mostrar la idempotencia;
- confirma de forma explícita `sol-004` y `sol-005`;
- prueba un payload alterado (CA2) y dos errores;
- imprime `out/control.csv`.

## Salidas (`out/`)

| Ruta | Contenido |
|---|---|
| `out/<caso>/payload.json` | OC construida, validada con zod. |
| `out/<caso>/trazabilidad.json` | Fuente de cada valor del payload. |
| `out/<caso>/aprobacion.txt` / `.pdf` | Evidencia de aprobación con su sha256. |
| `out/sap/ordenes.jsonl` | "SAP" simulado. Numeración desde 4500000001. |
| `out/control.csv` | Una fila por intento: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. |
| `out/log.jsonl` | Cada llamada a herramienta (CA4). |
| `out/sesiones/<id>.json` | Historial de cada sesión de chat. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error? }` |
| `GET` | `/api/sessions/:id` | `{ id, historial[], tokens, esperandoConfirmacion }` |
| `GET` | `/api/health` | `{ ok, provider, model, maxIteraciones }`, sin claves |
| `GET` | `/api/archivos/<ruta en out/>` | Descarga de evidencias y logs. No sirve sesiones. |

`sessionId` debe tener entre 8 y 64 caracteres `[a-zA-Z0-9-]`.

Ejemplo:

```bash
curl -s -X POST localhost:3000/api/chat -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-0001","message":"Procesa la solicitud \"sol-004\" y no la crees hasta que yo lo confirme."}'
curl -s -X POST localhost:3000/api/chat -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-0001","message":"confirmo"}'
```

## Link de prueba

https://reto-03-ordenes-compra-sap.onrender.com (plan gratuito de Render: la primera visita puede tardar 30–60 s en despertar)

## Módulo reutilizable (bonus)

`modulo/` empaqueta el agente:

- `agent.md`: el system prompt;
- `tools/oc.ts`: re-exporta las herramientas reales;
- `skill/ordenes-compra/SKILL.md`: el conocimiento del proceso.

Los dos `.md` se regeneran desde `agent/prompt.md` y `src/knowledge/ordenes-compra.md` con `npm run modulo`, así que no hay copias que diverjan.

## Estructura

```
agent/prompt.md               comportamiento (system prompt)
src/knowledge/                conocimiento: ordenes-compra.md + reglas-oc.json (umbrales configurables)
src/tools/oc.ts               herramientas (cada export → oc_<export>)
src/tools/*.ts                helpers: paquete, maestros, controles, payload, evidencia, control, flujo
src/sap/adapter.ts, mock.ts   interfaz SapAdapter y SAP simulado
src/agent/, src/llm/          ciclo del agente, sesiones, adaptador LLM (Anthropic)
src/server.ts, web/           API HTTP (Hono) y front de chat
```
