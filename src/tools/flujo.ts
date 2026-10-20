// Pasos compartidos por las herramientas: preparar un caso (paquete + maestros + validación) y recalcular la OC.
// Las herramientas nunca confían en valores enviados por el modelo: todo se recalcula desde los fixtures (CA2).
import { z } from "zod"
import { rutas, type CtxHerramienta, type Lectura } from "./comun.js"
import { validarPaquete } from "./controles.js"
import { contenidoEvidencia, sha256 } from "./evidencia.js"
import { cargarReferencia, type Referencia } from "./maestros.js"
import { leerAprobacionCruda, leerPaquete } from "./paquete.js"
import { construirOrden, type Construccion } from "./payload.js"
import type { Paquete, Validacion } from "./tipos.js"
import { SapMock } from "../sap/mock.js"
import type { SapAdapter } from "../sap/adapter.js"
import path from "node:path"

export interface Preparado {
  paquete: Paquete
  ref: Referencia
  validacion: Validacion
}

export async function preparar(ctx: CtxHerramienta, caso: string): Promise<Lectura<Preparado>> {
  const ref = await cargarReferencia(ctx)
  if (!ref.ok) return ref
  const paquete = await leerPaquete(ctx, caso, ref.valor.reglas.palabra_aprobacion)
  if (!paquete.ok) return paquete
  return { ok: true, valor: { paquete: paquete.valor, ref: ref.valor, validacion: validarPaquete(paquete.valor, ref.valor) } }
}

/** Recalcula la OC desde el caso (incluye el sha256 de la evidencia de aprobación). */
export async function recalcularOrden(ctx: CtxHerramienta, caso: string, prep: Preparado): Promise<Lectura<Construccion>> {
  const aprob = await leerAprobacionCruda(ctx, caso)
  if (!aprob.ok) return { ok: false, error: `no hay aprobación utilizable: ${aprob.error}` }
  const hash = sha256(contenidoEvidencia(prep.paquete.solicitud.solicitud_id, aprob.valor))
  const r = construirOrden(prep.paquete, prep.validacion, prep.ref, hash)
  return r.ok ? { ok: true, valor: r.valor } : r
}

const esquemaEnviado = z
  .object({
    solicitud: z.object({ valor_total: z.unknown(), cantidad: z.unknown(), valor_unitario: z.unknown(), proveedor_nit: z.unknown(), centro_costo: z.unknown() }).partial(),
  })
  .partial()

/** Si el modelo envía un paquete, sus montos y claves deben coincidir con el caso. Devuelve el motivo si difiere. */
export function diferenciaPaquete(enviado: unknown, real: Paquete): string | null {
  if (enviado === undefined || enviado === null) return null
  const e = esquemaEnviado.safeParse(enviado)
  if (!e.success || !e.data.solicitud) return null
  const campos = ["valor_total", "cantidad", "valor_unitario", "proveedor_nit", "centro_costo"] as const
  const distintos = campos.filter((c) => e.data.solicitud?.[c] !== undefined && e.data.solicitud[c] !== real.solicitud[c])
  return distintos.length ? `el paquete enviado no coincide con el caso en: ${distintos.join(", ")}. Usa los valores de oc_leer_paquete sin modificarlos.` : null
}

export function crearSap(ctx: CtxHerramienta, ref: Referencia): SapAdapter {
  const r = rutas(ctx)
  return new SapMock(r.sap, path.join(r.maestros, "proveedores.json"), ref.reglas.numero_oc_inicial)
}
