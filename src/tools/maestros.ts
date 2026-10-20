// Carga de maestros y reglas, y búsquedas en maestros. No exporta herramientas.
import path from "node:path"
import { leerJson, rutas, type CtxHerramienta, type Lectura } from "./comun.js"
import { esquemaCentros, esquemaCodigos, esquemaProveedores, esquemaReglas, type Maestros, type Proveedor, type Reglas } from "./tipos.js"

export interface Referencia {
  maestros: Maestros
  reglas: Reglas
}

/** Lee los cuatro maestros y las reglas configurables. Falla con un mensaje claro si alguno está dañado. */
export async function cargarReferencia(ctx: CtxHerramienta): Promise<Lectura<Referencia>> {
  const r = rutas(ctx)
  const m = (archivo: string) => path.join(r.maestros, archivo)
  const [proveedores, centros, iva, condiciones, reglas] = await Promise.all([
    leerJson(m("proveedores.json"), esquemaProveedores),
    leerJson(m("centros-costo.json"), esquemaCentros),
    leerJson(m("indicadores-iva.json"), esquemaCodigos),
    leerJson(m("condiciones-pago.json"), esquemaCodigos),
    leerJson(r.reglas, esquemaReglas),
  ])
  for (const l of [proveedores, centros, iva, condiciones, reglas]) if (!l.ok) return { ok: false, error: `maestro inválido: ${l.error}` }
  if (!proveedores.ok || !centros.ok || !iva.ok || !condiciones.ok || !reglas.ok) return { ok: false, error: "maestros inválidos" }
  return { ok: true, valor: { maestros: { proveedores: proveedores.valor, centros: centros.valor, iva: iva.valor, condiciones: condiciones.valor }, reglas: reglas.valor } }
}

/** Minúsculas, sin tildes ni puntuación, espacios simples: "TecnoSuministros S.A.S." → "tecnosuministros s a s". */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export interface ProveedorEncontrado {
  proveedor: Proveedor
  por: "nit" | "nombre"
}

/** RC1: busca por NIT; si no hay NIT, por nombre normalizado. */
export function buscarProveedor(proveedores: Proveedor[], nit: string | undefined, nombre: string): ProveedorEncontrado | null {
  if (nit) {
    const p = proveedores.find((x) => x.nit === nit.replace(/\D/g, ""))
    return p ? { proveedor: p, por: "nit" } : null
  }
  const objetivo = normalizarNombre(nombre)
  const p = proveedores.find((x) => normalizarNombre(x.nombre) === objetivo)
  return p ? { proveedor: p, por: "nombre" } : null
}
