// Herramientas del agente de órdenes de compra. Cada export es una herramienta: oc_<export>.
// Todas devuelven JSON { ok: true, data } o { ok: false, error } y nunca lanzan.
import path from "node:path"
import { z } from "zod"
import { definir, esquemaCaso, escribir, fallo, mensajeError, ok, relativa, rutas, type CtxHerramienta } from "./comun.js"
import { registrarControl, type FilaControl, type ResultadoControl } from "./control.js"
import { escribirEvidencia } from "./evidencia.js"
import { crearSap, diferenciaPaquete, preparar, recalcularOrden, type Preparado } from "./flujo.js"
import { leerAprobacionCruda } from "./paquete.js"
import { canonico, sinConfirmador } from "./payload.js"
import { esquemaOrdenCompra, type Hallazgo, type OrdenCompra } from "./tipos.js"

const paqueteOpcional = z
  .unknown()
  .optional()
  .describe("Paquete devuelto por oc_leer_paquete, sin modificar. Opcional: la herramienta relee el caso y rechaza si los montos enviados difieren.")

const codigos = (hs: Hallazgo[]) => hs.map((h) => h.codigo)

export const leer_paquete = definir({
  description: "Lee y normaliza el paquete de una solicitud de compra: correo, solicitud, cotización, aprobación y factura (si existe); reporta adjuntos faltantes.",
  args: { caso: esquemaCaso },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const p = prep.valor.paquete
      const resumen = `${p.solicitud.solicitud_id}: ${p.solicitud.proveedor_nombre}, ${p.solicitud.moneda} ${p.solicitud.valor_total.toLocaleString("es-CO")}${p.faltantes.length ? `; faltan: ${p.faltantes.join(", ")}` : ""}${p.factura ? "; trae factura" : ""}`
      return ok({ ...p, resumen })
    } catch (e) {
      return fallo(`no se pudo leer el paquete: ${mensajeError(e)}`)
    }
  },
})

export const validar = definir({
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve apta, bloqueos (impiden crear), confirmaciones (requieren confirmación humana), derivados y retroactiva.",
  args: { caso: esquemaCaso, paquete: paqueteOpcional },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const difiere = diferenciaPaquete(args.paquete, prep.valor.paquete)
      if (difiere) return fallo(difiere)
      const v = prep.valor.validacion
      const resumen = v.apta
        ? `apta${v.confirmaciones.length ? `, requiere confirmar ${codigos(v.confirmaciones).join(", ")}` : ", sin confirmaciones"}${v.retroactiva ? ", RETROACTIVA" : ""}`
        : `NO apta: ${codigos(v.bloqueos).join(", ")}`
      const pide = v.apta && v.confirmaciones.length > 0
      const accion = v.bloqueos.map((b) => b.accion_sugerida).filter(Boolean)
      return ok({ ...v, accion_sugerida: accion, ...(pide ? { pide_confirmacion: true } : {}), resumen })
    } catch (e) {
      return fallo(`no se pudo validar: ${mensajeError(e)}`)
    }
  },
})

export const construir_payload = definir({
  description: "Construye la OC tal como quedaría en SAP (esquema OrdenCompra validado con zod) y guarda la trazabilidad de cada valor en out/<caso>/trazabilidad.json.",
  args: {
    caso: esquemaCaso,
    paquete: paqueteOpcional,
    derivados: z.record(z.string(), z.unknown()).optional().describe("Derivados devueltos por oc_validar. Informativo: la herramienta los recalcula."),
  },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const difiere = diferenciaPaquete(args.paquete, prep.valor.paquete)
      if (difiere) return fallo(difiere)
      const v = prep.valor.validacion
      if (!v.apta) return fallo(`no se construye la OC: el paquete tiene bloqueos (${codigos(v.bloqueos).join(", ")})`, { bloqueos: v.bloqueos })
      const c = await recalcularOrden(ctx, args.caso, prep.valor)
      if (!c.ok) return fallo(c.error)
      const r = rutas(ctx, args.caso)
      const archivoTraza = path.join(r.outCaso, "trazabilidad.json")
      await escribir(archivoTraza, JSON.stringify(c.valor.trazabilidad, null, 2))
      await escribir(path.join(r.outCaso, "payload.json"), JSON.stringify(c.valor.orden, null, 2))
      const pide = v.confirmaciones.length > 0
      const pos = c.valor.orden.posiciones[0]
      const resumen = `${c.valor.orden.proveedor.nombre} · ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario.toLocaleString("es-CO")} ${c.valor.orden.moneda}${pide ? ` · excepciones: ${codigos(v.confirmaciones).join(", ")}` : ""}`
      return ok({ payload: c.valor.orden, trazabilidad: relativa(ctx, archivoTraza), derivados: v.derivados, confirmaciones: v.confirmaciones, ...(pide ? { pide_confirmacion: true } : {}), resumen })
    } catch (e) {
      return fallo(`no se pudo construir el payload: ${mensajeError(e)}`)
    }
  },
})

export const generar_evidencia = definir({
  description: "Genera la evidencia del correo de aprobación en out/<caso>/aprobacion.txt (con sha256) y out/<caso>/aprobacion.pdf.",
  args: { caso: esquemaCaso },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const aprob = await leerAprobacionCruda(ctx, args.caso)
      if (!aprob.ok) return fallo(`no hay correo de aprobación: ${aprob.error}. Pide al solicitante el correo de aprobación de su líder.`)
      const ev = await escribirEvidencia(rutas(ctx, args.caso).outCaso, prep.valor.paquete.solicitud.solicitud_id, aprob.valor)
      return ok({ ruta: relativa(ctx, ev.txt), ruta_pdf: relativa(ctx, ev.pdf), sha256: ev.sha256, resumen: `${relativa(ctx, ev.txt)} · sha256 ${ev.sha256.slice(0, 12)}…` })
    } catch (e) {
      return fallo(`no se pudo generar la evidencia: ${mensajeError(e)}`)
    }
  },
})

async function controlar(ctx: CtxHerramienta, prep: Preparado, resultado: ResultadoControl, numero: string | null = null): Promise<void> {
  const v = prep.validacion
  const fila: FilaControl = { solicitud_id: prep.paquete.solicitud.solicitud_id, resultado, numero_oc: numero, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones) }
  await registrarControl(rutas(ctx).control, fila)
}

/** CA2: si el modelo envía un payload, debe ser idéntico al recalculado (salvo quién confirmó). */
function payloadDifiere(enviado: OrdenCompra | undefined, recalculado: OrdenCompra): boolean {
  return enviado !== undefined && canonico(sinConfirmador(enviado)) !== canonico(sinConfirmador(recalculado))
}

export const crear = definir({
  description: "Crea la OC en SAP (simulado) solo si el caso es apto y, si hay confirmaciones, con confirmado=true tras la confirmación explícita del usuario; idempotente por solicitud_id.",
  args: {
    caso: esquemaCaso,
    payload: esquemaOrdenCompra.optional().describe("Payload devuelto por oc_construir_payload, sin modificar. Se compara con el recalculado y se rechaza si difiere."),
    confirmado: z.boolean().default(false).describe("true solo si el usuario confirmó explícitamente en su último mensaje las excepciones pendientes"),
  },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const p = prep.valor
      const v = p.validacion
      if (!v.apta) {
        await controlar(ctx, p, "bloqueada")
        return fallo(`OC no creada: bloqueos ${codigos(v.bloqueos).join(", ")}`, { bloqueos: v.bloqueos, accion_sugerida: v.bloqueos.map((b) => b.accion_sugerida).filter(Boolean) })
      }
      const sap = crearSap(ctx, p.ref)
      const existente = await sap.buscarOrdenPorReferencia(p.paquete.solicitud.solicitud_id)
      if (existente) {
        await controlar(ctx, p, "existente", existente.numero_oc)
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, resumen: `ya existía la OC ${existente.numero_oc} para ${p.paquete.solicitud.solicitud_id} (idempotente)` })
      }
      return await crearNueva(args, ctx, p, sap)
    } catch (e) {
      return fallo(`no se pudo crear la OC: ${mensajeError(e)}`)
    }
  },
})

async function crearNueva(args: { caso: string; payload?: OrdenCompra; confirmado: boolean }, ctx: CtxHerramienta, p: Preparado, sap: ReturnType<typeof crearSap>): Promise<string> {
  const v = p.validacion
  const c = await recalcularOrden(ctx, args.caso, p)
  if (!c.ok) {
    await controlar(ctx, p, "error")
    return fallo(c.error)
  }
  if (payloadDifiere(args.payload, c.valor.orden)) {
    await controlar(ctx, p, "rechazada")
    return fallo("el payload enviado no coincide con el recalculado desde el caso; no se crea. Vuelve a llamar a oc_construir_payload y envía su payload sin modificar.")
  }
  if (v.confirmaciones.length > 0 && (!args.confirmado || ctx.confirmacionHumana === false)) {
    await controlar(ctx, p, "pendiente_confirmacion")
    return fallo(`requiere confirmación explícita del usuario para: ${codigos(v.confirmaciones).join(", ")}`, { pide_confirmacion: true, confirmaciones: v.confirmaciones })
  }
  const proveedor = await sap.consultarProveedor(c.valor.orden.proveedor.nit)
  if (!proveedor?.activo) {
    await controlar(ctx, p, "bloqueada")
    return fallo("SAP no reconoce el proveedor como activo; no se crea la OC.")
  }
  const confirmador = `analista (sesión ${ctx.sessionId})`
  const orden: OrdenCompra = { ...c.valor.orden, excepciones: c.valor.orden.excepciones.map((e) => ({ ...e, confirmado_por: confirmador })) }
  const ev = await generarEvidenciaInterna(ctx, args.caso, p)
  const r = await sap.crearOrden(orden)
  await escribir(path.join(rutas(ctx, args.caso).outCaso, "payload.json"), JSON.stringify(orden, null, 2))
  await controlar(ctx, p, "creada", r.numero_oc)
  return ok({ numero_oc: r.numero_oc, fecha: r.fecha, idempotente: false, retroactiva: v.retroactiva, evidencia: ev, control: relativa(ctx, rutas(ctx).control), resumen: `OC ${r.numero_oc} creada${v.retroactiva ? " (retroactiva)" : ""}` })
}

async function generarEvidenciaInterna(ctx: CtxHerramienta, caso: string, p: Preparado): Promise<{ txt: string; pdf: string } | null> {
  const aprob = await leerAprobacionCruda(ctx, caso)
  if (!aprob.ok) return null
  const ev = await escribirEvidencia(rutas(ctx, caso).outCaso, p.paquete.solicitud.solicitud_id, aprob.valor)
  return { txt: relativa(ctx, ev.txt), pdf: relativa(ctx, ev.pdf) }
}
