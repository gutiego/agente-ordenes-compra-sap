// Log de control para contabilidad/auditoría (HU-5): tabla `control`, una fila por intento de creación, solo inserciones.
import type { Db } from "../db/index.js"
import { mensajeError } from "./comun.js"

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "rechazada" | "error"

export interface FilaControl {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  /** Usuario autenticado que hizo el intento. */
  usuario: string
}

/** Inserta la fila en `control`. Nunca lanza: un fallo se reporta por stderr y no tumba la herramienta. */
export async function registrarControl(db: Db, f: FilaControl): Promise<void> {
  try {
    await db.query(
      `INSERT INTO control (solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, usuario)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [f.solicitud_id, f.resultado, f.numero_oc, f.retroactiva, f.bloqueos, f.confirmaciones, f.usuario],
    )
  } catch (e) {
    console.error(JSON.stringify({ nivel: "error", evento: "control_no_registrado", solicitud_id: f.solicitud_id, resultado: f.resultado, error: mensajeError(e) }))
  }
}
