// SAP simulado sobre Postgres/PGlite: tabla `ordenes` con numeración por SEQUENCE e idempotencia por solicitud_id.
// El maestro de proveedores sigue siendo el JSON de fixtures (es dato de referencia, no estado).
import { readFile } from "node:fs/promises"
import type { Db } from "../db/index.js"
import { esquemaProveedores, type OrdenCompra } from "../tools/tipos.js"
import type { ResultadoCreacion, SapAdapter } from "./adapter.js"

interface FilaOrden {
  numero_oc: string
  creada_en: Date | string
}

const fechaIso = (f: Date | string): string => (f instanceof Date ? f : new Date(f)).toISOString()

/** Implementación de `SapAdapter` sobre la base de datos de la aplicación. */
export class SapPostgres implements SapAdapter {
  /**
   * @param db base abierta con `abrirDb` (migraciones aplicadas).
   * @param archivoProveedores ruta al maestro `proveedores.json`.
   */
  constructor(
    private readonly db: Db,
    private readonly archivoProveedores: string,
  ) {}

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = esquemaProveedores.parse(JSON.parse(await readFile(this.archivoProveedores, "utf8")))
    const p = proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra, usuario: string): Promise<ResultadoCreacion> {
    const solicitud = orden.referencia.solicitud_id
    return this.db.transaccion(async (tx) => {
      // Serializa por solicitud (también entre instancias): el segundo en llegar espera al COMMIT del primero
      // y luego ve su fila. Así no se consume un número de la SEQUENCE en vano ni hay huecos en la numeración.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [solicitud])
      const previa = await tx.query<FilaOrden>("SELECT numero_oc, creada_en FROM ordenes WHERE solicitud_id = $1", [solicitud])
      if (previa.rows[0]) return { numero_oc: previa.rows[0].numero_oc, fecha: fechaIso(previa.rows[0].creada_en), creada: false }
      // Red de seguridad: si algo esquivara el lock, UNIQUE(solicitud_id) + DO NOTHING impide el duplicado sin lanzar.
      const nueva = await tx.query<FilaOrden>(
        `INSERT INTO ordenes (solicitud_id, orden, creada_por) VALUES ($1, $2, $3)
         ON CONFLICT (solicitud_id) DO NOTHING RETURNING numero_oc, creada_en`,
        [solicitud, JSON.stringify(orden), usuario],
      )
      if (nueva.rows[0]) return { numero_oc: nueva.rows[0].numero_oc, fecha: fechaIso(nueva.rows[0].creada_en), creada: true }
      const otra = await tx.query<FilaOrden>("SELECT numero_oc, creada_en FROM ordenes WHERE solicitud_id = $1", [solicitud])
      const fila = otra.rows[0]
      if (!fila) throw new Error(`conflicto al crear la OC de ${solicitud} sin fila existente`)
      return { numero_oc: fila.numero_oc, fecha: fechaIso(fila.creada_en), creada: false }
    })
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = await this.db.query<{ numero_oc: string }>("SELECT numero_oc FROM ordenes WHERE solicitud_id = $1", [solicitud_id])
    return r.rows[0] ?? null
  }
}
