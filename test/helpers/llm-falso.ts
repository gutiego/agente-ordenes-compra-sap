// LLM falso guionizado: devuelve respuestas predefinidas en orden, sin red. Registra cada llamada
// para que los tests comprueben qué recibió el "modelo" (historial y resultados de herramientas).
import type { LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "../../src/llm/adapter.js"
import type { DefinicionHerramienta } from "../../src/tools/registro.js"

/** Un paso del guion: una respuesta fija o una función que la calcula a partir del historial. */
export type Paso = RespuestaLLM | ((mensajes: Mensaje[]) => RespuestaLLM | Promise<RespuestaLLM>)

let contador = 0

/** Respuesta que pide ejecutar herramientas. */
export function llamar(...llamadas: { nombre: string; args: unknown }[]): RespuestaLLM {
  const conId: LlamadaHerramienta[] = llamadas.map((l) => ({ id: `llamada-${++contador}`, ...l }))
  return { texto: "", llamadas: conId, fin: "herramientas", tokens: { entrada: 10, salida: 5 } }
}

/** Respuesta final de texto (cierra el turno). */
export function responder(texto: string): RespuestaLLM {
  return { texto, llamadas: [], fin: "fin", tokens: { entrada: 10, salida: 5 } }
}

export class LlmFalso implements ProveedorLLM {
  readonly nombre = "falso"
  readonly modelo = "guion-v1"
  /** Copia del historial recibido en cada llamada. */
  readonly recibido: Mensaje[][] = []
  private readonly pasos: Paso[]

  constructor(pasos: Paso[] = []) {
    this.pasos = [...pasos]
  }

  /** Agrega pasos al final del guion (p. ej. para el segundo turno). */
  agregar(...pasos: Paso[]): void {
    this.pasos.push(...pasos)
  }

  get pendientes(): number {
    return this.pasos.length
  }

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[], _sistema: string): Promise<RespuestaLLM> {
    this.recibido.push(structuredClone(mensajes))
    const paso = this.pasos.shift()
    if (!paso) return responder("(fin del guion)")
    return typeof paso === "function" ? paso(mensajes) : paso
  }
}

/** Resultados de herramientas que el modelo recibió en su última llamada, ya parseados. */
export function ultimosResultados(llm: LlmFalso): { ok: boolean; data?: Record<string, unknown>; error?: string; pide_confirmacion?: boolean }[] {
  const ultimo = llm.recibido.at(-1) ?? []
  const m = ultimo.at(-1)
  if (m?.rol !== "herramientas") return []
  return m.resultados.map((r) => JSON.parse(r.contenido))
}

/** Promesa controlable desde fuera (para simular un LLM lento). */
export function diferido<T = void>(): { promesa: Promise<T>; resolver: (v: T) => void } {
  let resolver!: (v: T) => void
  const promesa = new Promise<T>((r) => {
    resolver = r
  })
  return { promesa, resolver }
}
