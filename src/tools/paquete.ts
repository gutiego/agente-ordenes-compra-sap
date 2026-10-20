// Lectura y normalización del paquete de un caso (HU-1, PRD 7.2). No exporta herramientas.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { leerJson, rutas, type CtxHerramienta, type Lectura } from "./comun.js"
import {
  esquemaAprobacionCruda,
  esquemaCorreo,
  esquemaSolicitud,
  type Aprobacion,
  type Cotizacion,
  type Factura,
  type ItemCotizacion,
  type Paquete,
} from "./tipos.js"

/** "COP 11.400.000" / "1.850.000,50" → número. Formato colombiano: punto de miles, coma decimal. */
export function parsearMonto(texto: string): number {
  return Number(texto.replace(/\./g, "").replace(",", "."))
}

/** NIT sin puntos ni dígito de verificación: "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0].replace(/\D/g, "")
}

const capturar = (texto: string, re: RegExp): string | null => re.exec(texto)?.[1]?.trim() ?? null

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

function parsearItems(texto: string): ItemCotizacion[] {
  const re = /^\d+\.\s*(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*[A-Z]{3}\s*([\d.,]+)/gm
  return [...texto.matchAll(re)].map((m) => ({ descripcion: m[1], cantidad: parsearMonto(m[2]), precio_unitario: parsearMonto(m[3]) }))
}

/** Extrae los campos de la cotización en texto. Devuelve null si no encuentra el total. */
export function parsearCotizacion(texto: string): Cotizacion | null {
  const total = /^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/m.exec(texto)
  if (!total) return null
  const fecha = capturar(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const dias = capturar(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)
  const nit = capturar(texto, /^NIT:\s*([\d.\-]+)/m)
  return {
    referencia: capturar(texto, /^COTIZACI[ÓO]N\s+(\S+)/m),
    fecha,
    proveedor: capturar(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: parsearMonto(total[2]),
    moneda: total[1],
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    items: parsearItems(texto),
    texto,
  }
}

/** Extrae número, fecha de emisión y total de la factura en texto. */
export function parsearFactura(texto: string): Factura | null {
  const numero = capturar(texto, /No\.\s*(\S+)/)
  const fecha = capturar(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const total = capturar(texto, /^TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/m)
  if (!numero || !fecha || !total) return null
  return { numero, fecha, total: parsearMonto(total) }
}

async function leerTexto(archivo: string): Promise<string | null> {
  try {
    return await readFile(archivo, "utf8")
  } catch {
    return null
  }
}

function normalizarAprobacion(a: { de: string; para: string; asunto: string; fecha: string; cuerpo: string }, palabra: string): Aprobacion {
  const aprobado = new RegExp(`\\b${palabra}\\b`, "i").test(a.cuerpo)
  return { de: a.de.toLowerCase(), para: a.para, asunto: a.asunto, fecha: a.fecha, aprobado, texto: a.cuerpo }
}

/** Lee el paquete completo. Solo correo y solicitud son obligatorios; el resto se reporta como null + faltante. */
export async function leerPaquete(ctx: CtxHerramienta, caso: string, palabraAprobacion: string): Promise<Lectura<Paquete>> {
  const dir = rutas(ctx, caso).caso
  const correo = await leerJson(path.join(dir, "correo.json"), esquemaCorreo)
  if (!correo.ok) return { ok: false, error: `${correo.error}. Verifica que el caso '${caso}' exista.` }
  const solicitud = await leerJson(path.join(dir, "solicitud.json"), esquemaSolicitud)
  if (!solicitud.ok) return { ok: false, error: `${solicitud.error}. Pide al solicitante reenviar la solicitud corregida.` }

  const faltantes: string[] = []
  const advertencias: string[] = []
  const textoCot = await leerTexto(path.join(dir, "cotizacion.txt"))
  const cotizacion = textoCot ? parsearCotizacion(textoCot) : null
  if (!textoCot) faltantes.push("cotizacion (cotizacion.pdf)")
  else if (!cotizacion) advertencias.push("la cotización no tiene un TOTAL legible")

  const aprobCruda = await leerJson(path.join(dir, "aprobacion.json"), esquemaAprobacionCruda)
  const aprobacion = aprobCruda.ok ? normalizarAprobacion(aprobCruda.valor, palabraAprobacion) : null
  if (!aprobCruda.ok) faltantes.push(`aprobacion (${aprobCruda.error})`)

  const textoFac = await leerTexto(path.join(dir, "factura.txt"))
  const factura = textoFac ? parsearFactura(textoFac) : null
  if (textoFac && !factura) advertencias.push("la factura no tiene número, fecha o total legibles")

  const { id, de, asunto, fecha } = correo.valor
  return { ok: true, valor: { correo: { id, de, asunto, fecha }, solicitud: solicitud.valor, cotizacion, aprobacion, factura, faltantes, advertencias } }
}

/** Contenido canónico de la evidencia de aprobación; su sha256 va al payload. */
export async function leerAprobacionCruda(ctx: CtxHerramienta, caso: string) {
  return leerJson(path.join(rutas(ctx, caso).caso, "aprobacion.json"), esquemaAprobacionCruda)
}
