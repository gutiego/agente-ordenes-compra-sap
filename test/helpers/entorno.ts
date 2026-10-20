// Utilidades compartidas por los tests: raíz del proyecto, base PGlite en memoria, app con tokens de prueba
// y ejecución de herramientas con el contexto mínimo. Los tokens son literales de prueba, nunca secretos reales.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { crearApp, type DepsApp } from "../../src/app.js"
import { Autenticador } from "../../src/auth.js"
import { abrirDb, type Db } from "../../src/db/index.js"
import type { ProveedorLLM } from "../../src/llm/adapter.js"
import type { CtxHerramienta } from "../../src/tools/comun.js"
import { ejecutarHerramienta } from "../../src/tools/registro.js"

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export const TOKENS = {
  ana: "token-ana-analista-0001",
  beto: "token-beto-analista-0002",
  carla: "token-carla-auditora-0003",
} as const

export const JSON_TOKENS = JSON.stringify({
  [TOKENS.ana]: { usuario: "ana", rol: "analista" },
  [TOKENS.beto]: { usuario: "beto", rol: "analista" },
  [TOKENS.carla]: { usuario: "carla", rol: "auditor" },
})

export interface EntornoApp {
  app: ReturnType<typeof crearApp>
  db: Db
  cerrar(): Promise<void>
}

/** App completa sobre una base PGlite en memoria nueva (aislada por test). */
export async function crearEntorno(llm: ProveedorLLM | null, extra: Partial<DepsApp> = {}): Promise<EntornoApp> {
  const db = await abrirDb()
  const app = crearApp({ raiz: RAIZ, db, llm, auth: new Autenticador(JSON_TOKENS), sistema: "prompt de prueba", silencioso: true, ...extra })
  return { app, db, cerrar: () => db.cerrar() }
}

/** Cabeceras con Bearer token (y JSON si hay cuerpo). */
export function cabeceras(token?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

/** POST /api/chat con el token indicado. */
export function chat(app: EntornoApp["app"], token: string, cuerpo: { sessionId?: string; message: string }) {
  return app.request("/api/chat", { method: "POST", headers: cabeceras(token), body: JSON.stringify(cuerpo) })
}

export function ctxDe(db: Db, extra: Partial<CtxHerramienta> = {}): CtxHerramienta {
  return { directory: RAIZ, sessionId: "sesion-test", db, usuario: "ana", ...extra }
}

export interface SalidaHerramienta {
  ok: boolean
  error?: string
  pide_confirmacion?: boolean
  data?: Record<string, unknown> & { numero_oc?: string; idempotente?: boolean; payload?: Record<string, unknown> }
}

/** Ejecuta una herramienta y devuelve su salida JSON parseada. */
export async function herramienta(nombre: string, args: unknown, ctx: CtxHerramienta): Promise<SalidaHerramienta> {
  const e = await ejecutarHerramienta(nombre, args, ctx)
  return JSON.parse(e.salida) as SalidaHerramienta
}

/** Filas de una consulta como lista. */
export async function filas<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}
