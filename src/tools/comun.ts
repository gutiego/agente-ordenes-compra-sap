// Utilidades compartidas por las herramientas. No exporta herramientas.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Db } from "../db/index.js"

export interface CtxHerramienta {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /** Base de datos (Postgres o PGlite). Toda escritura de estado pasa por aquí, nunca por el disco. */
  db: Db
  /** Usuario autenticado que origina la acción. Queda en el log de control y en `confirmado_por`. */
  usuario: string
  /**
   * Lo fija el servidor: true solo si el turno anterior del agente pidió confirmación
   * y el mensaje actual del usuario la da. Sin servidor (demo) queda undefined.
   */
  confirmacionHumana?: boolean
}

export interface Herramienta<S extends z.ZodRawShape> {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: CtxHerramienta): Promise<string>
}

/** Identidad tipada: deja que TypeScript infiera los argumentos desde el esquema zod. */
export function definir<S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> {
  return h
}

export const ok = (data: object): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string, extra: object = {}): string =>
  JSON.stringify({ ok: false, error, ...extra })

export const esquemaCaso = z
  .string()
  .regex(/^[a-z0-9-]+$/, "solo minúsculas, números y guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'")

/** Rutas de solo lectura (fixtures y reglas). El estado no vive en disco: va a la base (`ctx.db`). */
export interface Rutas {
  fixtures: string
  caso: string
  maestros: string
  reglas: string
}

/** Resuelve las rutas de lectura desde la raíz del proyecto; `caso` apunta a fixtures/reto-03/solicitudes/<caso>. */
export function rutas(ctx: CtxHerramienta, caso = ""): Rutas {
  const fixtures = path.join(ctx.directory, "fixtures", "reto-03")
  return {
    fixtures,
    caso: path.join(fixtures, "solicitudes", caso),
    maestros: path.join(fixtures, "maestros"),
    reglas: path.join(ctx.directory, "src", "knowledge", "reglas-oc.json"),
  }
}

export type Lectura<T> = { ok: true; valor: T } | { ok: false; error: string }

/** Lee y parsea JSON sin lanzar. Distingue archivo ausente de archivo corrupto. */
export async function leerJson<T>(archivo: string, esquema: z.ZodType<T>): Promise<Lectura<T>> {
  let texto: string
  try {
    texto = await readFile(archivo, "utf8")
  } catch {
    return { ok: false, error: `no existe ${path.basename(archivo)}` }
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: `${path.basename(archivo)} está corrupto (JSON inválido)` }
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    return { ok: false, error: `${path.basename(archivo)} no tiene la estructura esperada (${detalle})` }
  }
  return { ok: true, valor: r.data }
}

/** Mensaje legible de cualquier valor lanzado. */
export function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
