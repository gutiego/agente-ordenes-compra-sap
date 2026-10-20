// Punto de entrada: lee la configuración del entorno, abre la base, arma la app y escucha.
// La lógica HTTP vive en app.ts (sin efectos al importar) para poder probarla sin red.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { crearApp, log } from "./app.js"
import { Autenticador } from "./auth.js"
import { abrirDb } from "./db/index.js"
import type { ProveedorLLM } from "./llm/adapter.js"
import { ProveedorAnthropic } from "./llm/anthropic.js"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const env = (k: string, def: string) => process.env[k] ?? def

function crearLLM(): ProveedorLLM | null {
  const proveedor = env("LLM_PROVIDER", "anthropic")
  const clave = process.env.ANTHROPIC_API_KEY
  if (proveedor === "anthropic" && clave) {
    return new ProveedorAnthropic(env("LLM_MODEL", "claude-opus-5-5"), clave, Number(env("LLM_TIMEOUT_MS", "60000")))
  }
  log({ nivel: "aviso", mensaje: `LLM no configurado (proveedor=${proveedor}). El chat responderá con un aviso.` })
  return null
}

async function cargarSistema(): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(raiz, "agent", "prompt.md"), "utf8"),
    readFile(path.join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n# Conocimiento de referencia\n\n${conocimiento}`
}

if (!process.env.AUTH_TOKENS) {
  console.error("Falta AUTH_TOKENS (JSON token → {usuario, rol}). Ver .env.example.")
  process.exit(1)
}

// Sin DATABASE_URL se usa PGlite en ./data (persistente en disco local) para desarrollo.
const db = await abrirDb({ url: process.env.DATABASE_URL, dirPglite: env("PGLITE_DIR", path.join(raiz, "data")) })
const app = crearApp({
  raiz,
  db,
  llm: crearLLM(),
  auth: new Autenticador(process.env.AUTH_TOKENS),
  sistema: await cargarSistema(),
  maxIteraciones: Number(env("MAX_ITERACIONES", "25")),
  maxTokensSesion: Number(env("MAX_TOKENS_SESION", "400000")),
  limiteChatPorMinuto: Number(env("LIMITE_CHAT_MINUTO", "20")),
})

const port = Number(env("PORT", "3000"))
const servidor = serve({ fetch: app.fetch, port }, () => log({ mensaje: `Agente de órdenes de compra en http://localhost:${port}`, motor: db.motor }))

// Cierre ordenado: Render envía SIGTERM al redesplegar. Se dejan de aceptar conexiones y se cierra la base.
for (const senal of ["SIGTERM", "SIGINT"] as const) {
  process.on(senal, () => {
    log({ mensaje: `${senal} recibido, cerrando` })
    servidor.close(() => void db.cerrar().finally(() => process.exit(0)))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
