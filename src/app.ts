// API HTTP del chat + front estático. Sin efectos al importar: `crearApp(deps)` recibe todo lo que necesita
// (base, LLM, tokens), así los tests la ejercitan con `app.request()` sin levantar puerto ni red.
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { requestId } from "hono/request-id"
import { secureHeaders } from "hono/secure-headers"
import { z } from "zod"
import { autenticar, exigirRol, limitarPeticiones, type Autenticador, type VarsAuth } from "./auth.js"
import { ejecutarTurno, type ConfigCiclo } from "./agent/ciclo.js"
import { AlmacenSesiones, ID_VALIDO } from "./agent/sesiones.js"
import type { Db } from "./db/index.js"
import type { ProveedorLLM } from "./llm/adapter.js"

export interface DepsApp {
  /** Raíz del proyecto (fixtures, prompt, web). */
  raiz: string
  db: Db
  llm: ProveedorLLM | null
  auth: Autenticador
  sistema: string
  maxIteraciones?: number
  maxTokensSesion?: number
  /** Peticiones de chat por usuario y minuto. */
  limiteChatPorMinuto?: number
  /** Silencia el log de peticiones (tests). */
  silencioso?: boolean
}

const cuerpoChat = z.object({
  sessionId: z.string().regex(ID_VALIDO).nullish(),
  message: z.string().trim().min(1).max(4000),
})

/** Log estructurado (una línea JSON por evento): se puede filtrar por requestId en cualquier visor de logs. */
export function log(evento: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...evento }))
}

export function crearApp(deps: DepsApp): Hono<VarsAuth> {
  const cfg: ConfigCiclo = {
    llm: deps.llm,
    sistema: deps.sistema,
    directorio: deps.raiz,
    db: deps.db,
    maxIteraciones: deps.maxIteraciones ?? 25,
    maxTokensSesion: deps.maxTokensSesion ?? 400_000,
  }
  const sesiones = new AlmacenSesiones(deps.db)
  const app = new Hono<VarsAuth>()

  app.use("*", requestId())
  app.use("*", secureHeaders())
  app.use("*", async (c, next) => {
    const inicio = performance.now()
    await next()
    if (!deps.silencioso) {
      log({ requestId: c.get("requestId"), metodo: c.req.method, ruta: c.req.path, estado: c.res.status, ms: Math.round(performance.now() - inicio), usuario: c.get("usuario")?.usuario })
    }
  })
  // Sin CORS a propósito: el front se sirve desde el mismo origen y ningún otro dominio debe llamar a la API.
  app.use("/api/*", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "Cuerpo demasiado grande (máx. 32 KB)." }, 413) }))

  app.onError((e, c) => {
    // Nunca se devuelve el stack al cliente: solo el requestId para cruzarlo con el log.
    log({ requestId: c.get("requestId"), nivel: "error", error: e instanceof Error ? e.message : String(e) })
    return c.json({ error: "Error interno.", requestId: c.get("requestId") }, 500)
  })
  app.notFound((c) => c.json({ error: "No encontrado." }, 404))

  // ── Públicas ────────────────────────────────────────────────────────────────
  app.get("/api/health", async (c) => {
    let db = "ok"
    try {
      await deps.db.query("SELECT 1")
    } catch {
      db = "caída"
    }
    return c.json({ ok: db === "ok", db, motor: deps.db.motor, provider: deps.llm?.nombre ?? "sin configurar", model: deps.llm?.modelo ?? null }, db === "ok" ? 200 : 503)
  })
  app.get("/", async (c) => c.html(await readFile(path.join(deps.raiz, "web", "index.html"), "utf8")))

  // ── Protegidas ──────────────────────────────────────────────────────────────
  app.use("/api/*", autenticar(deps.auth))

  app.get("/api/me", (c) => c.json(c.get("usuario")))

  app.post("/api/chat", exigirRol("analista"), limitarPeticiones(deps.limiteChatPorMinuto ?? 20, 60_000), async (c) => {
    const body = cuerpoChat.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "Cuerpo inválido: se espera { sessionId?, message } con un mensaje de 1 a 4000 caracteres." }, 400)
    const usuario = c.get("usuario").usuario
    const toma = await sesiones.tomar(body.data.sessionId ?? randomUUID(), usuario)
    if (toma.estado === "ajena") return c.json({ error: "La sesión no existe o pertenece a otro usuario." }, 404)
    if (toma.estado === "ocupada") return c.json({ error: "La sesión está procesando otro mensaje. Espera a que termine." }, 409)
    const sesion = toma.sesion
    try {
      const r = await ejecutarTurno(sesion, body.data.message, cfg)
      return c.json({ sessionId: sesion.id, ...r })
    } finally {
      await sesiones.soltar(sesion)
    }
  })

  app.get("/api/sessions/:id", exigirRol("analista"), async (c) => {
    const id = c.req.param("id")
    if (!ID_VALIDO.test(id)) return c.json({ error: "id inválido" }, 400)
    const s = await sesiones.buscar(id, c.get("usuario").usuario)
    if (!s) return c.json({ error: "sesión no encontrada" }, 404)
    return c.json({ id: s.id, historial: s.vista, tokens: s.tokens, esperandoConfirmacion: s.esperandoConfirmacion })
  })

  // Lectura para contabilidad/auditoría: ambos roles.
  app.get("/api/control", exigirRol("analista", "auditor"), async (c) => {
    const r = await deps.db.query("SELECT solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, usuario, ts FROM control ORDER BY id DESC LIMIT 500")
    return c.json({ filas: r.rows })
  })

  app.get("/api/ordenes", exigirRol("analista", "auditor"), async (c) => {
    const r = await deps.db.query("SELECT numero_oc, solicitud_id, creada_por, creada_en, orden FROM ordenes ORDER BY creada_en DESC LIMIT 500")
    return c.json({ ordenes: r.rows })
  })

  // Evidencia de aprobación guardada en la base (txt canónico o PDF).
  app.get("/api/evidencias/:solicitud/:archivo", exigirRol("analista", "auditor"), async (c) => {
    const { solicitud, archivo } = c.req.param()
    if (!/^[A-Za-z0-9-]{1,64}$/.test(solicitud) || !["aprobacion.txt", "aprobacion.pdf"].includes(archivo)) return c.json({ error: "ruta no permitida" }, 400)
    const r = await deps.db.query<{ contenido: string; sha256: string; pdf: Uint8Array | null }>("SELECT contenido, sha256, pdf FROM evidencias WHERE solicitud_id = $1", [solicitud])
    const ev = r.rows[0]
    if (!ev) return c.json({ error: "evidencia no encontrada" }, 404)
    if (archivo === "aprobacion.txt") return c.text(`${ev.contenido}\n\n---\nsha256: ${ev.sha256}\n`)
    if (!ev.pdf) return c.json({ error: "PDF no disponible" }, 404)
    return c.body(new Uint8Array(ev.pdf), 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${solicitud}-aprobacion.pdf"` })
  })

  return app
}
