// Ciclo del agente: prompt -> modelo -> herramientas -> modelo ... -> respuesta.
import { ErrorLLM, type ProveedorLLM, type RespuestaLLM, type ResultadoHerramienta } from "../llm/adapter.js"
import { definiciones, ejecutarHerramienta } from "../tools/registro.js"
import type { Db } from "../db/index.js"
import type { Sesion, LlamadaVisible } from "./sesiones.js"

export interface ConfigCiclo {
  llm: ProveedorLLM | null
  sistema: string
  directorio: string
  db: Db
  maxIteraciones: number
  maxTokensSesion: number
}

export interface RespuestaTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  error?: boolean
}

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

/** ¿El mensaje del usuario es una confirmación explícita? Una negación siempre gana. */
export function esConfirmacion(mensaje: string): boolean {
  const m = normalizar(mensaje)
  if (/\b(no|todavia|aun no|espera|cancela|cancelar|detente)\b/.test(m)) return false
  return /\b(si|confirmo|confirmado|envia|envialo|enviar|adelante|procede|hazlo|de acuerdo|ok|dale)\b/.test(m)
}

function pideConfirmacion(salida: string): boolean {
  try {
    const r = JSON.parse(salida) as { pide_confirmacion?: boolean; data?: { pide_confirmacion?: boolean } }
    return r.pide_confirmacion === true || r.data?.pide_confirmacion === true
  } catch {
    return false
  }
}

function finTurno(sesion: Sesion, texto: string, toolCalls: LlamadaVisible[], needsConfirmation: boolean, error = false): RespuestaTurno {
  sesion.esperandoConfirmacion = needsConfirmation
  sesion.vista.push({ rol: "agente", texto, toolCalls, needsConfirmation, error, ts: new Date().toISOString() })
  return { reply: texto, toolCalls, needsConfirmation, error }
}

export async function ejecutarTurno(sesion: Sesion, mensaje: string, cfg: ConfigCiclo): Promise<RespuestaTurno> {
  // CA3: la confirmación solo vale si el turno anterior la pidió y este mensaje la da.
  const confirmacionHumana = sesion.esperandoConfirmacion && esConfirmacion(mensaje)
  sesion.vista.push({ rol: "usuario", texto: mensaje, ts: new Date().toISOString() })

  if (!cfg.llm) return finTurno(sesion, "El modelo no está configurado en el servidor (falta la clave). Las herramientas funcionan con `npm run demo`.", [], false, true)
  if (sesion.tokens >= cfg.maxTokensSesion) {
    return finTurno(sesion, `Esta sesión alcanzó el tope de ${cfg.maxTokensSesion} tokens. Abre una sesión nueva para continuar.`, [], false, true)
  }

  sesion.mensajes.push({ rol: "usuario", texto: mensaje })
  const toolCalls: LlamadaVisible[] = []
  const herramientas = definiciones()
  let pidio = false

  for (let i = 0; i < cfg.maxIteraciones; i++) {
    let r: RespuestaLLM
    try {
      r = await cfg.llm.enviar(sesion.mensajes, herramientas, cfg.sistema)
    } catch (e) {
      const texto = e instanceof ErrorLLM ? e.message : "Error inesperado al llamar al modelo."
      sesion.mensajes.push({ rol: "asistente", texto: `[error del proveedor: ${texto}]`, llamadas: [] })
      return finTurno(sesion, `⚠️ ${texto}`, toolCalls, false, true)
    }
    sesion.tokens += r.tokens.entrada + r.tokens.salida
    sesion.mensajes.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas, nativo: r.nativo })

    if (r.fin === "rechazo") return finTurno(sesion, "El modelo declinó responder a este mensaje. Reformúlalo, por favor.", toolCalls, false, true)
    if (r.llamadas.length === 0) {
      const texto = r.texto || "(el modelo no devolvió texto)"
      const preguntaConfirmacion = /¿[^?]*confirm[^?]*\?/i.test(texto)
      return finTurno(sesion, texto, toolCalls, pidio || preguntaConfirmacion)
    }

    const resultados: ResultadoHerramienta[] = []
    for (const llamada of r.llamadas) {
      const e = await ejecutarHerramienta(llamada.nombre, llamada.args, { directory: cfg.directorio, sessionId: sesion.id, db: cfg.db, usuario: sesion.usuario, confirmacionHumana })
      toolCalls.push({ nombre: e.nombre, args: e.args, ok: e.ok, resumen: e.resumen, resultado: e.salida.slice(0, 4000) })
      resultados.push({ id: llamada.id, contenido: e.salida, esError: !e.ok })
      pidio ||= pideConfirmacion(e.salida)
    }
    sesion.mensajes.push({ rol: "herramientas", resultados })
  }

  // CA1: tope alcanzado. Se responde con lo hecho, sin otra llamada al modelo.
  const hechas = toolCalls.map((t) => `- ${t.ok ? "✔" : "✖"} ${t.nombre}: ${t.resumen}`).join("\n")
  const texto = `Alcancé el tope de ${cfg.maxIteraciones} iteraciones en este turno. Esto es lo que hice:\n\n${hechas}\n\nDime cómo quieres continuar.`
  sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
  return finTurno(sesion, texto, toolCalls, pidio)
}
