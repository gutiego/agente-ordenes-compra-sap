// SAP simulado sobre archivos: out/sap/ordenes.jsonl. Numeración secuencial e idempotencia por solicitud_id.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { esquemaProveedores, type OrdenCompra } from "../tools/tipos.js"
import type { SapAdapter } from "./adapter.js"

interface Registro {
  numero_oc: string
  fecha: string
  solicitud_id: string
  orden: OrdenCompra
}

const esquemaRegistro = z.object({ numero_oc: z.string(), fecha: z.string(), solicitud_id: z.string() }).passthrough()

export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(
    dirSap: string,
    private readonly archivoProveedores: string,
    private readonly numeroInicial: number,
  ) {
    this.archivo = path.join(dirSap, "ordenes.jsonl")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = esquemaProveedores.parse(JSON.parse(await readFile(this.archivoProveedores, "utf8")))
    const p = proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.leer()
    const previa = existentes.find((r) => r.solicitud_id === orden.referencia.solicitud_id)
    if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
    const registro: Registro = {
      numero_oc: String(this.numeroInicial + existentes.length),
      fecha: new Date().toISOString(),
      solicitud_id: orden.referencia.solicitud_id,
      orden,
    }
    await mkdir(path.dirname(this.archivo), { recursive: true })
    await appendFile(this.archivo, JSON.stringify(registro) + "\n")
    return { numero_oc: registro.numero_oc, fecha: registro.fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.leer()).find((x) => x.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  private async leer(): Promise<z.infer<typeof esquemaRegistro>[]> {
    let texto = ""
    try {
      texto = await readFile(this.archivo, "utf8")
    } catch {
      return []
    }
    return texto.split("\n").filter(Boolean).map((l) => esquemaRegistro.parse(JSON.parse(l)))
  }
}
