// Construcción del payload OrdenCompra (HU-3, PRD 7.4) con trazabilidad de cada valor.
import { buscarProveedor, type Referencia } from "./maestros.js"
import { esquemaOrdenCompra, type OrdenCompra, type Paquete, type Reglas, type Traza, type Validacion } from "./tipos.js"

type Unidad = OrdenCompra["posiciones"][number]["unidad"]

/** Unidad derivada por patrones configurables (reglas-oc.json) sobre la descripción y los ítems cotizados. */
export function derivarUnidad(p: Paquete, reglas: Reglas): Unidad {
  const textos = [p.solicitud.descripcion, ...(p.cotizacion?.items.map((i) => i.descripcion) ?? [])].join(" ")
  return reglas.unidades.find((u) => new RegExp(u.patron, "i").test(textos))?.unidad ?? "UN"
}

/** Texto breve SAP: máximo N caracteres, cortado en límite de palabra si es posible. */
export function textoBreve(descripcion: string, max: number): string {
  if (descripcion.length <= max) return descripcion
  const corte = descripcion.slice(0, max)
  const espacio = corte.lastIndexOf(" ")
  const recortado = espacio > max * 0.6 ? corte.slice(0, espacio) : corte
  // Sin conectores colgando al final ("... arquitectura de" → "... arquitectura").
  return recortado.replace(/(\s+(de|del|la|el|los|las|y|para|con|en|a))+$/i, "").replace(/[\s,.:;-]+$/, "")
}

export interface Construccion {
  orden: OrdenCompra
  trazabilidad: Traza[]
}

type Resultado = { ok: true; valor: Construccion } | { ok: false; error: string }

/** Arma la OC desde el paquete, la validación y los maestros. Solo para paquetes aptos. */
export function construirOrden(p: Paquete, v: Validacion, ref: Referencia, evidenciaSha: string): Resultado {
  const s = p.solicitud
  const prov = buscarProveedor(ref.maestros.proveedores, s.proveedor_nit, s.proveedor_nombre)
  if (!v.apta || !prov || !p.aprobacion) return { ok: false, error: "el paquete no es apto: hay bloqueos sin resolver" }
  const r = ref.reglas
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor ?? prov.proveedor.indicador_iva_default
  const condiciones = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor ?? prov.proveedor.condiciones_pago_default
  const descripcion = textoBreve(s.descripcion, r.max_descripcion)
  const unidad = derivarUnidad(p, r)
  const candidata = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: r.sociedad,
    organizacion_compras: r.organizacion_compras,
    proveedor: { codigo_sap: prov.proveedor.codigo_sap, nit: prov.proveedor.nit, nombre: prov.proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condiciones,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [{ numero: r.paso_posicion, descripcion, cantidad: s.cantidad, unidad, precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: iva }],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }
  const parsed = esquemaOrdenCompra.safeParse(candidata)
  if (!parsed.success) return { ok: false, error: `payload inválido: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }
  return { ok: true, valor: { orden: parsed.data, trazabilidad: trazar(p, v, parsed.data, prov.por) } }
}

function trazar(p: Paquete, v: Validacion, o: OrdenCompra, por: "nit" | "nombre"): Traza[] {
  const s = p.solicitud
  const pos = o.posiciones[0]
  const fuenteProv = `maestro.proveedores (por ${por})`
  return [
    { campo: "referencia.solicitud_id", valor: o.referencia.solicitud_id, fuente: "solicitud" },
    { campo: "referencia.correo_id", valor: o.referencia.correo_id, fuente: "correo" },
    { campo: "referencia.cotizacion_ref", valor: o.referencia.cotizacion_ref, fuente: "cotizacion" },
    { campo: "sociedad", valor: o.sociedad, fuente: "derivado", nota: "constante configurada en reglas-oc.json" },
    { campo: "organizacion_compras", valor: o.organizacion_compras, fuente: "derivado", nota: "constante configurada en reglas-oc.json" },
    { campo: "proveedor.codigo_sap", valor: o.proveedor.codigo_sap, fuente: fuenteProv },
    { campo: "proveedor.nit", valor: o.proveedor.nit, fuente: s.proveedor_nit ? "solicitud" : fuenteProv },
    { campo: "proveedor.nombre", valor: o.proveedor.nombre, fuente: fuenteProv },
    { campo: "moneda", valor: o.moneda, fuente: "solicitud" },
    { campo: "condiciones_pago", valor: o.condiciones_pago, fuente: s.condiciones_pago ? "solicitud" : "maestro.proveedores", nota: s.condiciones_pago ? undefined : "derivado (RC7)" },
    { campo: "aprobador.email", valor: o.aprobador.email, fuente: "aprobacion" },
    { campo: "aprobador.fecha_aprobacion", valor: o.aprobador.fecha_aprobacion, fuente: "aprobacion" },
    { campo: "aprobador.evidencia_sha256", valor: o.aprobador.evidencia_sha256, fuente: "derivado", nota: "sha256 de out/<caso>/aprobacion.txt (contenido)" },
    { campo: "posiciones[0].numero", valor: pos.numero, fuente: "derivado", nota: "posiciones de 10 en 10" },
    { campo: "posiciones[0].descripcion", valor: pos.descripcion, fuente: "solicitud", nota: pos.descripcion === s.descripcion ? undefined : `derivado: recortada a texto breve SAP (original ${s.descripcion.length} caracteres)` },
    { campo: "posiciones[0].cantidad", valor: pos.cantidad, fuente: "solicitud" },
    { campo: "posiciones[0].unidad", valor: pos.unidad, fuente: "derivado", nota: "patrones de unidad en reglas-oc.json" },
    { campo: "posiciones[0].precio_unitario", valor: pos.precio_unitario, fuente: "solicitud" },
    { campo: "posiciones[0].centro_costo", valor: pos.centro_costo, fuente: "solicitud" },
    { campo: "posiciones[0].subarea", valor: pos.subarea, fuente: "solicitud" },
    { campo: "posiciones[0].indicador_iva", valor: pos.indicador_iva, fuente: s.indicador_iva ? "solicitud" : "maestro.proveedores", nota: s.indicador_iva ? undefined : "derivado (RC6), requiere confirmación" },
    { campo: "excepciones", valor: v.confirmaciones.map((c) => c.codigo).join(", ") || null, fuente: "derivado", nota: "confirmaciones de oc_validar" },
  ]
}

/** Serialización estable (claves ordenadas) para comparar payloads. */
export function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`
  if (valor && typeof valor === "object") {
    const obj = valor as Record<string, unknown>
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonico(obj[k])}`).join(",")}}`
  }
  return JSON.stringify(valor)
}

/** Copia del payload sin quién confirmó: lo que se compara entre lo enviado por el modelo y lo recalculado. */
export function sinConfirmador(o: OrdenCompra): OrdenCompra {
  return { ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })) }
}
