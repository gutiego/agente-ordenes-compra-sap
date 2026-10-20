// Esquemas zod de fixtures, maestros, reglas y del payload de la OC (PRD 7.1, 7.2 y 7.4). No exporta herramientas.
import { z } from "zod"

// ---------- Fixtures del caso ----------

export const esquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().default(""),
  adjuntos: z.array(z.string()).default([]),
})

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha con formato YYYY-MM-DD")
const monto = (campo: string) => z.number({ error: `${campo} debe ser numérico` }).finite()

export const esquemaSolicitud = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: monto("cantidad").positive(),
  valor_unitario: monto("valor_unitario"),
  valor_total: monto("valor_total").positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fecha,
})
export type Solicitud = z.infer<typeof esquemaSolicitud>

export const esquemaAprobacionCruda = z.object({
  de: z.string(),
  para: z.string().default(""),
  cc: z.array(z.string()).default([]),
  fecha: z.string(),
  asunto: z.string().default(""),
  cuerpo: z.string(),
})
export type AprobacionCruda = z.infer<typeof esquemaAprobacionCruda>

// ---------- Paquete normalizado (7.2, con campos adicionales para trazabilidad) ----------

export interface ItemCotizacion {
  descripcion: string
  cantidad: number
  precio_unitario: number
}

export interface Cotizacion {
  referencia: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  items: ItemCotizacion[]
  texto: string
}

export interface Aprobacion {
  de: string
  para: string
  asunto: string
  fecha: string
  aprobado: boolean
  texto: string
}

export interface Factura {
  numero: string
  fecha: string
  total: number
}

export interface Paquete {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  faltantes: string[]
  advertencias: string[]
}

// ---------- Maestros ----------

export const esquemaProveedores = z.array(
  z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
    condiciones_pago_default: z.string(),
    indicador_iva_default: z.string(),
    activo: z.boolean(),
  }),
)
export type Proveedor = z.infer<typeof esquemaProveedores>[number]

export const esquemaCentros = z.array(
  z.object({
    centro_costo: z.string(),
    nombre: z.string().optional(),
    subareas: z.array(z.string()),
    aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
  }),
)
export type CentroCosto = z.infer<typeof esquemaCentros>[number]

export const esquemaCodigos = z.array(z.object({ codigo: z.string(), descripcion: z.string() }).passthrough())

export interface Maestros {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: z.infer<typeof esquemaCodigos>
  condiciones: z.infer<typeof esquemaCodigos>
}

// ---------- Reglas configurables (src/knowledge/reglas-oc.json) ----------

export const esquemaReglas = z.object({
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  tolerancia_cotizacion: z.number(),
  tolerancia_monto: z.number(),
  palabra_aprobacion: z.string(),
  max_descripcion: z.number().int(),
  paso_posicion: z.number().int(),
  numero_oc_inicial: z.number().int(),
  unidades: z.array(z.object({ unidad: z.enum(["H", "MES"]), patron: z.string() })),
})
export type Reglas = z.infer<typeof esquemaReglas>

// ---------- Resultado de validación (HU-2) ----------

export interface Hallazgo {
  codigo: string
  detalle: string
  accion_sugerida?: string
  valores?: Record<string, string | number | null>
}

export interface Derivado {
  valor: string
  fuente: string
}

export interface Validacion {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  controles_ok: string[]
}

// ---------- Payload de la OC (7.4) ----------

export const esquemaOrdenCompra = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().describe("código, ej. Z030"),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive().multipleOf(10),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof esquemaOrdenCompra>

export interface Traza {
  campo: string
  valor: string | number | null
  fuente: string
  nota?: string
}
