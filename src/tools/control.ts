// Log de control para contabilidad/auditoría: out/control.csv (HU-5). Una fila por intento de creación.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "rechazada" | "error"

export interface FilaControl {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"
const celda = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** Agrega la fila (crea el archivo con encabezado si no existe). Nunca lanza. */
export async function registrarControl(archivo: string, f: FilaControl): Promise<void> {
  try {
    await mkdir(path.dirname(archivo), { recursive: true })
    const existe = await readFile(archivo, "utf8").then(() => true, () => false)
    const valores = [f.solicitud_id, f.resultado, f.numero_oc ?? "", String(f.retroactiva), f.bloqueos.join("|"), f.confirmaciones.join("|"), new Date().toISOString()]
    await appendFile(archivo, (existe ? "" : ENCABEZADO) + valores.map(celda).join(",") + "\n")
  } catch {
    // el log de control no debe tumbar la herramienta
  }
}
