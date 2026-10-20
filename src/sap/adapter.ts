// Interfaz del adaptador SAP (PRD 7.4). El agente solo conoce esta interfaz; la implementación real se diseña en SOLUCION.md.
import type { OrdenCompra } from "../tools/tipos.js"

export type { OrdenCompra }

/** Resultado de `crearOrden`. `creada` es false si la solicitud ya tenía OC (respuesta idempotente). */
export interface ResultadoCreacion {
  numero_oc: string
  /** Fecha ISO de creación de la OC (la original si ya existía). */
  fecha: string
  creada: boolean
}

export interface SapAdapter {
  /** Estado del proveedor en SAP por NIT; null si no existe. */
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  /**
   * Crea la OC de forma idempotente por `orden.referencia.solicitud_id`: si ya existe devuelve la previa
   * con `creada: false`. Debe ser seguro ante llamadas simultáneas (nunca dos OC para la misma solicitud).
   */
  crearOrden(orden: OrdenCompra, usuario: string): Promise<ResultadoCreacion>
  /** OC asociada a una solicitud, si existe. Solo lectura: no sirve como guarda de creación. */
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
