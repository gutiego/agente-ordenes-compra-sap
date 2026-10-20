// Sesiones del chat en Postgres. Cada sesión pertenece a un usuario y solo él puede usarla.
// Concurrencia: un "lease" (ocupada_hasta) impide dos turnos simultáneos de la misma sesión,
// también entre varias instancias del servidor, sin mantener una transacción abierta durante la llamada al LLM.
import type { Db } from "../db/index.js"
import type { Mensaje } from "../llm/adapter.js"

export interface LlamadaVisible {
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: string
}

export interface EntradaVisible {
  rol: "usuario" | "agente"
  texto: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  error?: boolean
  ts: string
}

export interface Sesion {
  id: string
  usuario: string
  mensajes: Mensaje[] // historial que ve el modelo
  vista: EntradaVisible[] // historial que ve el usuario
  tokens: number
  esperandoConfirmacion: boolean
}

type DatosSesion = Omit<Sesion, "id" | "usuario">

export const ID_VALIDO = /^[a-zA-Z0-9-]{8,64}$/

/** Si un proceso muere a mitad de turno, el lease caduca solo y la sesión vuelve a estar disponible. */
const LEASE = "5 minutes"

export type Toma = { estado: "ok"; sesion: Sesion } | { estado: "ocupada" } | { estado: "ajena" }

export class AlmacenSesiones {
  constructor(private readonly db: Db) {}

  /**
   * Toma la sesión para procesar un turno. La crea si no existe.
   * Un solo UPDATE condicional hace el "test-and-set" de forma atómica en la base.
   */
  async tomar(id: string, usuario: string): Promise<Toma> {
    const vacia: DatosSesion = { mensajes: [], vista: [], tokens: 0, esperandoConfirmacion: false }
    await this.db.query("INSERT INTO sesiones (id, usuario, datos) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [id, usuario, vacia])
    const r = await this.db.query<{ usuario: string; datos: DatosSesion }>(
      `UPDATE sesiones SET ocupada_hasta = now() + interval '${LEASE}'
       WHERE id = $1 AND usuario = $2 AND (ocupada_hasta IS NULL OR ocupada_hasta < now())
       RETURNING usuario, datos`,
      [id, usuario],
    )
    if (r.rows[0]) return { estado: "ok", sesion: { id, usuario, ...r.rows[0].datos } }
    const duena = await this.db.query<{ usuario: string }>("SELECT usuario FROM sesiones WHERE id = $1", [id])
    return duena.rows[0]?.usuario === usuario ? { estado: "ocupada" } : { estado: "ajena" }
  }

  /** Guarda el estado y libera el lease. */
  async soltar(sesion: Sesion): Promise<void> {
    const { id, usuario, ...datos } = sesion
    await this.db.query("UPDATE sesiones SET datos = $3, ocupada_hasta = NULL, actualizada_en = now() WHERE id = $1 AND usuario = $2", [id, usuario, datos])
  }

  /** Sesión del usuario, o null si no existe, es de otro o está vacía. */
  async buscar(id: string, usuario: string): Promise<Sesion | null> {
    const r = await this.db.query<{ datos: DatosSesion }>("SELECT datos FROM sesiones WHERE id = $1 AND usuario = $2", [id, usuario])
    const d = r.rows[0]?.datos
    return d && d.vista.length > 0 ? { id, usuario, ...d } : null
  }
}
