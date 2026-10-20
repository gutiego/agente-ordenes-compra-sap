// Interfaz propia del proveedor de LLM. El ciclo del agente solo conoce estos tipos.
import type { DefinicionHerramienta } from "../tools/registro.js"

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
}

export interface ResultadoHerramienta {
  id: string
  contenido: string
  esError: boolean
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  /** `nativo`: contenido original del proveedor (p. ej. bloques de razonamiento) para reenviarlo intacto. */
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; nativo?: unknown }
  | { rol: "herramientas"; resultados: ResultadoHerramienta[] }

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  nativo?: unknown
  fin: "fin" | "herramientas" | "limite_tokens" | "rechazo"
  tokens: { entrada: number; salida: number }
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], sistema: string): Promise<RespuestaLLM>
}

/** Error del proveedor ya traducido a lenguaje claro para el chat (CA5). */
export class ErrorLLM extends Error {}
