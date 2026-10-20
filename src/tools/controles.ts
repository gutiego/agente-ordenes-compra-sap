// Reglas de control RC1–RC10 (PRD 7.3). Funciones puras: paquete + maestros + reglas → validación.
import { buscarProveedor, type ProveedorEncontrado, type Referencia } from "./maestros.js"
import type { CentroCosto, Derivado, Hallazgo, Paquete, Validacion } from "./tipos.js"

interface Acumulado {
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Record<string, Derivado>
  ok: string[]
}

const cop = (n: number) => n.toLocaleString("es-CO")
const soloFecha = (iso: string) => iso.slice(0, 10)

function rc1Proveedor(p: Paquete, ref: Referencia, a: Acumulado): ProveedorEncontrado | null {
  const s = p.solicitud
  const hallado = buscarProveedor(ref.maestros.proveedores, s.proveedor_nit, s.proveedor_nombre)
  const clave = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
  if (!hallado) {
    a.bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor ${s.proveedor_nombre} (${clave}) no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar a Datos Maestros la creación del proveedor en SAP (RUT, certificación bancaria) o confirmar con el solicitante un proveedor ya registrado.",
    })
    return null
  }
  if (!hallado.proveedor.activo) {
    a.bloqueos.push({ codigo: "RC1", detalle: `El proveedor ${hallado.proveedor.nombre} (${hallado.proveedor.codigo_sap}) está inactivo.`, accion_sugerida: "Solicitar a Datos Maestros la reactivación del proveedor o usar otro proveedor activo." })
    return null
  }
  if (hallado.por === "nombre") a.derivados.proveedor_nit = { valor: hallado.proveedor.nit, fuente: "maestro.proveedores (búsqueda por nombre normalizado)" }
  a.ok.push(`RC1: proveedor ${hallado.proveedor.nombre} (${hallado.proveedor.codigo_sap}) activo, encontrado por ${hallado.por}`)
  return hallado
}

function listaAprobadores(cc: CentroCosto): string {
  return cc.aprobadores.map((x) => `${x.email} (tope ${cop(x.tope)})`).join(", ")
}

function rc2rc3Aprobacion(p: Paquete, cc: CentroCosto | undefined, a: Acumulado): void {
  const ap = p.aprobacion
  if (!ap) {
    a.bloqueos.push({ codigo: "RC2", detalle: "No hay correo de aprobación en el paquete.", accion_sugerida: "Pedir al solicitante el correo de aprobación de su líder." })
    return
  }
  if (!ap.aprobado) a.bloqueos.push({ codigo: "RC2", detalle: `El correo de ${ap.de} no contiene la palabra "Aprobado".`, accion_sugerida: "Pedir al líder una aprobación explícita." })
  if (!cc) return
  const aprobador = cc.aprobadores.find((x) => x.email.toLowerCase() === ap.de)
  const total = p.solicitud.valor_total
  if (!aprobador) {
    a.bloqueos.push({ codigo: "RC2", detalle: `${ap.de} no es aprobador del centro de costo ${cc.centro_costo}. Aprobadores válidos: ${listaAprobadores(cc)}.`, accion_sugerida: `Solicitar la aprobación a un aprobador de ${cc.centro_costo} con tope suficiente.` })
    const topeMax = Math.max(0, ...cc.aprobadores.map((x) => x.tope))
    if (total > topeMax) a.bloqueos.push({ codigo: "RC3", detalle: `El valor ${cop(total)} supera el tope máximo de aprobación de ${cc.centro_costo} (${cop(topeMax)}).`, accion_sugerida: "Escalar a un aprobador de nivel superior o ajustar el monto/centro de costo con el solicitante.", valores: { valor_total: total, tope_maximo_centro: topeMax } })
    return
  }
  if (ap.aprobado) a.ok.push(`RC2: aprobación de ${ap.de}, aprobador de ${cc.centro_costo}`)
  if (total > aprobador.tope) {
    a.bloqueos.push({ codigo: "RC3", detalle: `El valor ${cop(total)} supera el tope de ${ap.de} (${cop(aprobador.tope)}).`, accion_sugerida: `Solicitar aprobación de un aprobador de ${cc.centro_costo} con tope suficiente.`, valores: { valor_total: total, tope: aprobador.tope } })
  } else a.ok.push(`RC3: ${cop(total)} ≤ tope ${cop(aprobador.tope)}`)
}

function rc4Centro(p: Paquete, ref: Referencia, a: Acumulado): CentroCosto | undefined {
  const s = p.solicitud
  const cc = ref.maestros.centros.find((c) => c.centro_costo === s.centro_costo)
  if (!cc) {
    a.bloqueos.push({ codigo: "RC4", detalle: `El centro de costo ${s.centro_costo} no existe.`, accion_sugerida: "Confirmar el centro de costo con el solicitante." })
  } else if (!cc.subareas.includes(s.subarea)) {
    a.bloqueos.push({ codigo: "RC4", detalle: `La subárea "${s.subarea}" no pertenece a ${cc.centro_costo} (válidas: ${cc.subareas.join(", ")}).`, accion_sugerida: "Confirmar la subárea correcta con el solicitante." })
  } else a.ok.push(`RC4: subárea ${s.subarea} pertenece a ${cc.centro_costo}`)
  return cc
}

function rc5Cotizacion(p: Paquete, ref: Referencia, a: Acumulado): void {
  const total = p.solicitud.valor_total
  if (!p.cotizacion) {
    a.confirmaciones.push({ codigo: "RC5", detalle: "No hay cotización legible en el paquete; no se puede contrastar el valor.", valores: { solicitud: total, cotizacion: null } })
    return
  }
  const dif = Math.abs(p.cotizacion.total - total) / total
  const pct = `${(dif * 100).toFixed(2)} %`
  if (dif > ref.reglas.tolerancia_cotizacion) {
    a.confirmaciones.push({
      codigo: "RC5",
      detalle: `La cotización (${cop(p.cotizacion.total)}) difiere de la solicitud (${cop(total)}) en ${pct}, más del ${ref.reglas.tolerancia_cotizacion * 100} % permitido. La OC se crearía por el valor de la solicitud.`,
      valores: { solicitud: total, cotizacion: p.cotizacion.total, diferencia: p.cotizacion.total - total, porcentaje: pct },
    })
  } else a.ok.push(`RC5: cotización ${cop(p.cotizacion.total)} vs solicitud ${cop(total)} (${pct})`)
}

function rc6rc7Derivados(p: Paquete, prov: ProveedorEncontrado | null, a: Acumulado): void {
  const s = p.solicitud
  if (!s.indicador_iva && prov) {
    const iva = prov.proveedor.indicador_iva_default
    a.derivados.indicador_iva = { valor: iva, fuente: "maestro.proveedores.indicador_iva_default" }
    a.confirmaciones.push({ codigo: "RC6", detalle: `La solicitud no informa indicador de IVA; se propone ${iva} (default del proveedor ${prov.proveedor.nombre}).`, valores: { indicador_iva_propuesto: iva } })
  } else if (s.indicador_iva) a.ok.push(`RC6: indicador IVA ${s.indicador_iva} informado`)
  if (!s.condiciones_pago && prov) {
    a.derivados.condiciones_pago = { valor: prov.proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
  } else if (s.condiciones_pago) a.ok.push(`RC7: condiciones de pago ${s.condiciones_pago} informadas`)
}

function rc8Retroactiva(p: Paquete, a: Acumulado): boolean {
  const f = p.factura
  if (!f || f.fecha >= p.solicitud.fecha_solicitud) {
    a.ok.push("RC8: sin factura anterior a la solicitud")
    return false
  }
  a.confirmaciones.push({
    codigo: "RC8",
    detalle: `OC retroactiva: la factura ${f.numero} (${f.fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}). Quedará marcada retroactiva = true en el log de control.`,
    valores: { fecha_factura: f.fecha, fecha_solicitud: p.solicitud.fecha_solicitud, total_factura: f.total },
  })
  return true
}

function rc9FechaAprobacion(p: Paquete, a: Acumulado): void {
  if (!p.aprobacion) return
  const fecha = soloFecha(p.aprobacion.fecha)
  if (fecha < p.solicitud.fecha_solicitud) {
    a.confirmaciones.push({ codigo: "RC9", detalle: `La aprobación (${fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`, valores: { fecha_aprobacion: fecha, fecha_solicitud: p.solicitud.fecha_solicitud } })
  } else a.ok.push(`RC9: aprobación ${fecha} ≥ solicitud ${p.solicitud.fecha_solicitud}`)
}

function rc10Aritmetica(p: Paquete, ref: Referencia, a: Acumulado): void {
  const s = p.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > ref.reglas.tolerancia_monto) {
    a.bloqueos.push({ codigo: "RC10", detalle: `cantidad × valor_unitario = ${cop(calculado)} no coincide con valor_total ${cop(s.valor_total)}.`, accion_sugerida: "Pedir al solicitante corregir la solicitud (cantidad, valor unitario o total).", valores: { calculado, valor_total: s.valor_total } })
  } else a.ok.push(`RC10: ${s.cantidad} × ${cop(s.valor_unitario)} = ${cop(s.valor_total)}`)
}

/** Aplica RC1–RC10. Nunca "arregla" montos: solo clasifica. */
export function validarPaquete(p: Paquete, ref: Referencia): Validacion {
  const a: Acumulado = { bloqueos: [], confirmaciones: [], derivados: {}, ok: [] }
  const prov = rc1Proveedor(p, ref, a)
  const cc = rc4Centro(p, ref, a)
  rc2rc3Aprobacion(p, cc, a)
  rc5Cotizacion(p, ref, a)
  rc6rc7Derivados(p, prov, a)
  const retroactiva = rc8Retroactiva(p, a)
  rc9FechaAprobacion(p, a)
  rc10Aritmetica(p, ref, a)
  const orden = (h: Hallazgo) => Number(h.codigo.slice(2))
  return {
    apta: a.bloqueos.length === 0,
    bloqueos: a.bloqueos.sort((x, y) => orden(x) - orden(y)),
    confirmaciones: a.confirmaciones.sort((x, y) => orden(x) - orden(y)),
    derivados: a.derivados,
    retroactiva,
    controles_ok: a.ok,
  }
}
