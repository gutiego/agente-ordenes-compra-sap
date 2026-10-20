// Interfaz del adaptador SAP (PRD 7.4). El agente solo conoce esta interfaz; la implementación real se diseña en SOLUCION.md.
import type { OrdenCompra } from "../tools/tipos.js"

export type { OrdenCompra }

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
