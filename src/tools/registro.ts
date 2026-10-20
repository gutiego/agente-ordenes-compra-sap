// Registro de herramientas: nombre <archivo>_<export>, validación zod, ejecución segura y logs (CA4, RN5).
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import * as oc from "./oc.js"
import { rutas, mensajeError, type CtxHerramienta } from "./comun.js"

interface HerramientaGenerica {
  description: string
  args: z.ZodRawShape
  execute(args: never, ctx: CtxHerramienta): Promise<string>
}

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown> // JSON Schema de los argumentos
}

export interface EjecucionHerramienta {
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  salida: string // JSON que recibe el modelo
}

const modulos: Record<string, Record<string, HerramientaGenerica>> = { oc }

export const herramientas: Map<string, HerramientaGenerica> = new Map(
  Object.entries(modulos).flatMap(([archivo, exports]) =>
    Object.entries(exports).map(([nombre, h]) => [`${archivo}_${nombre}`, h] as const),
  ),
)

export function definiciones(): DefinicionHerramienta[] {
  return [...herramientas.entries()].map(([nombre, h]) => {
    const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { nombre, descripcion: h.description, esquema }
  })
}

function resumir(salida: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(salida) as { ok?: boolean; error?: string; data?: { resumen?: string } }
    if (r.ok) return { ok: true, resumen: r.data?.resumen ?? "ok" }
    return { ok: false, resumen: r.error ?? "error" }
  } catch {
    return { ok: false, resumen: "salida no es JSON" }
  }
}

async function registrarLog(ctx: CtxHerramienta, e: EjecucionHerramienta): Promise<void> {
  try {
    const r = rutas(ctx)
    const caso = (e.args as { caso?: unknown } | null)?.caso
    const linea = JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, herramienta: e.nombre, caso, ok: e.ok, resumen: e.resumen }) + "\n"
    await mkdir(r.out, { recursive: true })
    await appendFile(path.join(r.out, "log.jsonl"), linea)
    if (typeof caso === "string" && /^[a-z0-9-]+$/.test(caso)) {
      await mkdir(path.join(r.out, caso), { recursive: true })
      await appendFile(path.join(r.out, caso, "log.jsonl"), linea)
    }
  } catch {
    // el log nunca debe tumbar la ejecución
  }
}

/** Valida argumentos, ejecuta y registra. Nunca lanza. */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: CtxHerramienta): Promise<EjecucionHerramienta> {
  const h = herramientas.get(nombre)
  let salida: string
  if (!h) {
    salida = JSON.stringify({ ok: false, error: `herramienta desconocida: ${nombre}` })
  } else {
    const parsed = z.object(h.args).safeParse(args)
    if (!parsed.success) {
      const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
      salida = JSON.stringify({ ok: false, error: `argumentos inválidos: ${detalle}` })
    } else {
      try {
        salida = await h.execute(parsed.data as never, ctx)
      } catch (e) {
        salida = JSON.stringify({ ok: false, error: `error inesperado: ${mensajeError(e)}` })
      }
    }
  }
  const ejecucion = { nombre, args, salida, ...resumir(salida) }
  await registrarLog(ctx, ejecucion)
  return ejecucion
}
