// Registro de herramientas: nombre <archivo>_<export>, validación zod, ejecución segura y trazas en `log_herramientas` (CA4, RN5).
import { z } from "zod"
import * as oc from "./oc.js"
import { mensajeError, type CtxHerramienta } from "./comun.js"

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

/** Definiciones (nombre, descripción, JSON Schema) que se envían al modelo. */
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

/** Inserta la traza de la llamada en `log_herramientas`. Nunca lanza: el log no debe tumbar la ejecución. */
async function registrarLog(ctx: CtxHerramienta, e: EjecucionHerramienta): Promise<void> {
  const caso = (e.args as { caso?: unknown } | null)?.caso
  try {
    await ctx.db.query(
      "INSERT INTO log_herramientas (sesion, usuario, herramienta, caso, ok, resumen) VALUES ($1, $2, $3, $4, $5, $6)",
      [ctx.sessionId, ctx.usuario, e.nombre, typeof caso === "string" ? caso.slice(0, 200) : null, e.ok, e.resumen],
    )
  } catch (err) {
    console.error(JSON.stringify({ nivel: "error", evento: "log_herramienta_no_registrado", herramienta: e.nombre, error: mensajeError(err) }))
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
