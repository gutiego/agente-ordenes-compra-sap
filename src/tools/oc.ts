// Herramientas del agente de órdenes de compra. Cada export es una herramienta: oc_<export>.
// Todas devuelven JSON { ok: true, data } o { ok: false, error } y nunca lanzan.
// El estado (OC, control, evidencias, trazas) se escribe en la base del contexto; los fixtures son solo lectura.
import { z } from "zod"
import { definir, esquemaCaso, fallo, mensajeError, ok, type CtxHerramienta } from "./comun.js"
import { registrarControl, type FilaControl, type ResultadoControl } from "./control.js"
import { guardarEvidencia, type Evidencia } from "./evidencia.js"
import type { SapAdapter } from "../sap/adapter.js"
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
  description: "Construye la OC tal como quedaría en SAP (esquema OrdenCompra validado con zod) y devuelve la trazabilidad (fuente) de cada valor.",
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
      const pide = v.confirmaciones.length > 0
      const pos = c.valor.orden.posiciones[0]
      const resumen = `${c.valor.orden.proveedor.nombre} · ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario.toLocaleString("es-CO")} ${c.valor.orden.moneda}${pide ? ` · excepciones: ${codigos(v.confirmaciones).join(", ")}` : ""}`
      return ok({ payload: c.valor.orden, trazabilidad: c.valor.trazabilidad, derivados: v.derivados, confirmaciones: v.confirmaciones, ...(pide ? { pide_confirmacion: true } : {}), resumen })
    } catch (e) {
      return fallo(`no se pudo construir el payload: ${mensajeError(e)}`)
    }
  },
})

export const generar_evidencia = definir({
  description: "Genera y guarda la evidencia del correo de aprobación (texto canónico con sha256 y PDF); devuelve las rutas api/evidencias/<solicitud>/aprobacion.txt y .pdf.",
  args: { caso: esquemaCaso },
  async execute(args, ctx) {
    try {
      const prep = await preparar(ctx, args.caso)
      if (!prep.ok) return fallo(prep.error)
      const aprob = await leerAprobacionCruda(ctx, args.caso)
      if (!aprob.ok) return fallo(`no hay correo de aprobación: ${aprob.error}. Pide al solicitante el correo de aprobación de su líder.`)
      const ev = await guardarEvidencia(ctx.db, prep.valor.paquete.solicitud.solicitud_id, aprob.valor)
      return ok({ ruta: ev.txt, ruta_pdf: ev.pdf, sha256: ev.sha256, resumen: `${ev.txt} · sha256 ${ev.sha256.slice(0, 12)}…` })
    } catch (e) {
      return fallo(`no se pudo generar la evidencia: ${mensajeError(e)}`)
    }
  },
})

async function controlar(ctx: CtxHerramienta, prep: Preparado, resultado: ResultadoControl, numero: string | null = null): Promise<void> {
  const v = prep.validacion
  const fila: FilaControl = { solicitud_id: prep.paquete.solicitud.solicitud_id, resultado, numero_oc: numero, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones), usuario: ctx.usuario }
  await registrarControl(ctx.db, fila)
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
      const sap = crearSap(ctx)
      // Atajo de solo lectura: conserva la semántica de siempre (una OC ya creada se devuelve sin pedir
      // confirmación ni payload). No es la guarda contra duplicados: esa es crearOrden, atómica.
      const existente = await sap.buscarOrdenPorReferencia(p.paquete.solicitud.solicitud_id)
      if (existente) return await responderExistente(ctx, p, existente.numero_oc, null)
      return await crearNueva(args, ctx, p, sap)
    } catch (e) {
      return fallo(`no se pudo crear la OC: ${mensajeError(e)}`)
    }
  },
})

async function responderExistente(ctx: CtxHerramienta, p: Preparado, numero: string, fecha: string | null): Promise<string> {
  await controlar(ctx, p, "existente", numero)
  return ok({ numero_oc: numero, fecha, idempotente: true, resumen: `ya existía la OC ${numero} para ${p.paquete.solicitud.solicitud_id} (idempotente)` })
}

async function crearNueva(args: { caso: string; payload?: OrdenCompra; confirmado: boolean }, ctx: CtxHerramienta, p: Preparado, sap: SapAdapter): Promise<string> {
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
  const orden: OrdenCompra = { ...c.valor.orden, excepciones: c.valor.orden.excepciones.map((e) => ({ ...e, confirmado_por: ctx.usuario })) }
  const ev = await generarEvidenciaInterna(ctx, args.caso, p)
  // Comprobar "ya existe" y crear es un solo paso atómico: si otra llamada se adelantó, llega creada=false.
  const r = await sap.crearOrden(orden, ctx.usuario)
  if (!r.creada) return await responderExistente(ctx, p, r.numero_oc, r.fecha)
  await controlar(ctx, p, "creada", r.numero_oc)
  return ok({ numero_oc: r.numero_oc, fecha: r.fecha, idempotente: false, retroactiva: v.retroactiva, evidencia: ev, control: "api/control", resumen: `OC ${r.numero_oc} creada${v.retroactiva ? " (retroactiva)" : ""}` })
}

async function generarEvidenciaInterna(ctx: CtxHerramienta, caso: string, p: Preparado): Promise<Pick<Evidencia, "txt" | "pdf"> | null> {
  const aprob = await leerAprobacionCruda(ctx, caso)
  if (!aprob.ok) return null
  const ev = await guardarEvidencia(ctx.db, p.paquete.solicitud.solicitud_id, aprob.valor)
  return { txt: ev.txt, pdf: ev.pdf }
}
