// Implementación del adaptador para Anthropic (Claude).
import Anthropic from "@anthropic-ai/sdk"
import type { DefinicionHerramienta } from "../tools/registro.js"
import { ErrorLLM, type Mensaje, type ProveedorLLM, type RespuestaLLM, type LlamadaHerramienta } from "./adapter.js"

type Bloque = Anthropic.Beta.Messages.BetaContentBlockParam
type MensajeApi = Anthropic.Beta.Messages.BetaMessageParam

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  private readonly cliente: Anthropic

  constructor(
    readonly modelo: string,
    apiKey: string,
    timeoutMs: number,
  ) {
    this.cliente = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], sistema: string): Promise<RespuestaLLM> {
    try {
      const r = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        system: sistema,
        messages: mensajes.map(aMensajeApi),
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.esquema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        })),
        output_config: { effort: "medium" },
        // Si el modelo declina por política, la API reintenta en un modelo alternativo.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      const llamadas: LlamadaHerramienta[] = r.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : [],
      )
      const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
      return {
        texto,
        llamadas,
        nativo: r.content,
        fin: r.stop_reason === "tool_use" ? "herramientas" : r.stop_reason === "max_tokens" ? "limite_tokens" : r.stop_reason === "refusal" ? "rechazo" : "fin",
        tokens: { entrada: r.usage.input_tokens, salida: r.usage.output_tokens },
      }
    } catch (e) {
      throw new ErrorLLM(traducirError(e))
    }
  }
}

function aMensajeApi(m: Mensaje): MensajeApi {
  if (m.rol === "usuario") return { role: "user", content: m.texto }
  if (m.rol === "herramientas") {
    return {
      role: "user",
      content: m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
    }
  }
  // Se reenvía el contenido original (incluye bloques de razonamiento) sin editarlo.
  if (Array.isArray(m.nativo)) return { role: "assistant", content: m.nativo as Bloque[] }
  const bloques: Bloque[] = []
  if (m.texto) bloques.push({ type: "text", text: m.texto })
  for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
  return { role: "assistant", content: bloques.length ? bloques : [{ type: "text", text: "(sin respuesta)" }] }
}

function traducirError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "La clave del modelo no es válida. Revisa ANTHROPIC_API_KEY en el servidor."
  if (e instanceof Anthropic.RateLimitError) return "El proveedor del modelo está limitando las peticiones. Espera unos segundos y reintenta."
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "El modelo tardó demasiado en responder (timeout). Reintenta el mensaje."
  if (e instanceof Anthropic.APIConnectionError) return "No hay conexión con el proveedor del modelo."
  if (e instanceof Anthropic.BadRequestError) return `El proveedor rechazó la petición: ${e.message}`
  if (e instanceof Anthropic.APIError) return `Error del proveedor del modelo (${String(e.status)}). Reintenta en un momento.`
  return "Error inesperado al llamar al modelo."
}
