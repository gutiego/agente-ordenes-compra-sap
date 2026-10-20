// Autenticación (Bearer token) y autorización por rol.
// Los tokens llegan por la variable AUTH_TOKENS y solo se guardan como sha256 en memoria.
import { createHash, timingSafeEqual } from "node:crypto"
import { createMiddleware } from "hono/factory"
import { z } from "zod"

export const ROLES = ["analista", "auditor"] as const
export type Rol = (typeof ROLES)[number]

export interface Usuario {
  usuario: string
  rol: Rol
}

/** Variables que el middleware deja en el contexto de Hono para las rutas. */
export type VarsAuth = { Variables: { usuario: Usuario; requestId: string } }

const esquemaTokens = z.record(z.string().min(16, "cada token debe tener al menos 16 caracteres"), z.object({ usuario: z.string().min(1), rol: z.enum(ROLES) }))

const hash = (t: string) => createHash("sha256").update(t, "utf8").digest()

export class Autenticador {
  private readonly usuarios: { hash: Buffer; usuario: Usuario }[]

  /** `json`: {"<token>": {"usuario": "ana", "rol": "analista"}, ...}. Lanza si el formato es inválido. */
  constructor(json: string) {
    const tokens = esquemaTokens.parse(JSON.parse(json))
    this.usuarios = Object.entries(tokens).map(([t, u]) => ({ hash: hash(t), usuario: u }))
  }

  /**
   * Compara contra todos los tokens con timingSafeEqual sobre sus sha256 (misma longitud siempre),
   * sin cortar al primer acierto: el tiempo de respuesta no revela cuál token existe.
   */
  verificar(token: string): Usuario | null {
    const h = hash(token)
    let encontrado: Usuario | null = null
    for (const u of this.usuarios) if (timingSafeEqual(h, u.hash)) encontrado = u.usuario
    return encontrado
  }
}

/** Exige `Authorization: Bearer <token>` válido. 401 si falta o no es válido. */
export function autenticar(auth: Autenticador) {
  return createMiddleware<VarsAuth>(async (c, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")
    const usuario = m ? auth.verificar(m[1].trim()) : null
    if (!usuario) return c.json({ error: "No autenticado: envía Authorization: Bearer <token>." }, 401, { "WWW-Authenticate": "Bearer" })
    c.set("usuario", usuario)
    await next()
  })
}

/** Exige uno de los roles indicados. 403 si el usuario autenticado no lo tiene. */
export function exigirRol(...roles: Rol[]) {
  return createMiddleware<VarsAuth>(async (c, next) => {
    if (!roles.includes(c.get("usuario").rol)) return c.json({ error: `Prohibido: requiere rol ${roles.join(" o ")}.` }, 403)
    await next()
  })
}

/**
 * Límite de peticiones por usuario en ventana fija. En memoria: vale por instancia
 * (con varias instancias se movería a la base o a Redis; ver SOLUCION.md).
 */
export function limitarPeticiones(maximo: number, ventanaMs: number) {
  const contadores = new Map<string, { inicio: number; n: number }>()
  return createMiddleware<VarsAuth>(async (c, next) => {
    const clave = c.get("usuario").usuario
    const ahora = Date.now()
    const e = contadores.get(clave)
    if (!e || ahora - e.inicio >= ventanaMs) contadores.set(clave, { inicio: ahora, n: 1 })
    else if (++e.n > maximo) {
      const espera = Math.ceil((e.inicio + ventanaMs - ahora) / 1000)
      return c.json({ error: `Demasiadas peticiones. Intenta de nuevo en ${espera} s.` }, 429, { "Retry-After": String(espera) })
    }
    await next()
  })
}
