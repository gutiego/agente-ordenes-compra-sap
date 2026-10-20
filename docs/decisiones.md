# Registro de decisiones de arquitectura (ADR)

Formato corto: contexto → decisión → alternativa descartada → consecuencias.

## ADR-1 · Postgres en producción, PGlite en tests y demo

- **Contexto**: hay que persistir OC, control, evidencias y sesiones, y los tests y la CI deben correr sin servicios externos ni secretos.
- **Decisión**: un solo dialecto SQL (Postgres). En producción, Neon vía `pg` (`DATABASE_URL`, TLS `verify-full`). Sin `DATABASE_URL`, PGlite (Postgres compilado a WASM, en proceso): en memoria para tests y demo, en `./data` para desarrollo.
- **Descartado**: SQLite en tests (otro dialecto: SEQUENCE, `ON CONFLICT … RETURNING`, advisory locks y JSONB se comportan distinto, y los tests dejarían de probar lo que corre en producción). Docker con Postgres en la CI (más lento y no corre igual en Windows).
- **Consecuencias**: lo probado en la CI es el mismo SQL que corre en Neon. PGlite es de una sola conexión, así que la concurrencia real entre conexiones se prueba en la lógica (locks y UNIQUE) y no en el pool.

## ADR-2 · Idempotencia y numeración garantizadas por la base

- **Contexto**: un reintento del modelo, un doble clic o dos analistas pueden pedir la misma OC a la vez.
- **Decisión**: `pg_advisory_xact_lock(hashtext(solicitud_id))` + `UNIQUE(solicitud_id)` con `ON CONFLICT DO NOTHING`; número de OC desde una `SEQUENCE` que empieza en 4500000001.
- **Descartado**: comprobar en la aplicación ("buscar y luego crear"): hay una carrera entre los dos pasos. Un contador en memoria: no sobrevive reinicios ni varias instancias.
- **Consecuencias**: la garantía no depende de que la aplicación sea correcta; la impone la base.

## ADR-3 · Lease de sesión en vez de lock con transacción

- **Contexto**: un turno de chat dura de segundos a un minuto (varias llamadas al LLM). Dos mensajes simultáneos de la misma sesión corromperían el historial.
- **Decisión**: columna `ocupada_hasta`; se toma con un `UPDATE … WHERE ocupada_hasta IS NULL OR ocupada_hasta < now() RETURNING` atómico y se libera al guardar. Caduca a los 5 minutos si el proceso muere.
- **Descartado**: `SELECT … FOR UPDATE` o advisory lock de sesión: mantendrían una conexión del pool (Neon tiene pocas en el plan gratuito) abierta durante toda la llamada al LLM. Un flag en memoria: no funciona con varias instancias.
- **Consecuencias**: el segundo mensaje recibe 409 con un mensaje claro.

## ADR-4 · Bearer tokens con roles, detrás de un middleware

- **Contexto**: el PRD deja la autenticación fuera del alcance, pero el agente crea documentos contables y consume un LLM de pago.
- **Decisión**: tokens en `AUTH_TOKENS` (token → usuario y rol), guardados solo como sha256 y comparados con `timingSafeEqual`. Roles `analista` y `auditor`.
- **Descartado**: OIDC/SSO ahora (requiere el IdP del cliente). Sin autenticación (cualquiera con el link gasta tokens y crea OC).
- **Consecuencias**: el usuario real llega a `confirmado_por` y al control. Migrar a SSO solo cambia `src/auth.ts`.

## ADR-5 · Adaptadores para el LLM y para SAP

- **Contexto**: el proveedor de LLM y la forma de conectar SAP (OData, RFC o manual) pueden cambiar.
- **Decisión**: interfaces `ProveedorLLM` y `SapAdapter`; el ciclo y las herramientas solo conocen las interfaces.
- **Descartado**: llamar al SDK de Anthropic y a SAP directamente desde el ciclo.
- **Consecuencias**: los tests usan un LLM falso guionizado; el SAP real y el plan B serían otras implementaciones sin tocar el agente.

## ADR-6 · `crearApp(deps)` sin efectos al importar

- **Contexto**: para probar la API hay que poder levantarla sin red, sin puerto y con dependencias controladas.
- **Decisión**: `src/app.ts` exporta `crearApp({ db, llm, auth, … })`; `src/server.ts` solo lee el entorno, abre la base y escucha.
- **Consecuencias**: los tests llaman `app.request()` con PGlite en memoria y el LLM falso; cada test tiene su base aislada.
