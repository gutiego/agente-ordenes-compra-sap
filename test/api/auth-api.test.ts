// API HTTP: salud, autenticación (401), autorización por rol (403), sesiones ajenas (404), límites (400/413/429).
// Se ejercita la app con app.request(), sin puerto ni red; base PGlite en memoria por suite.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { cabeceras, chat, crearEntorno, type EntornoApp, TOKENS } from "../helpers/entorno.js"
import { LlmFalso, responder } from "../helpers/llm-falso.js"

let e: EntornoApp
const llm = new LlmFalso()

before(async () => {
  e = await crearEntorno(llm)
})
after(() => e.cerrar())

describe("GET /api/health", () => {
  test("es pública y responde 200 con la base ok", async () => {
    const r = await e.app.request("/api/health")
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.ok, true)
    assert.equal(b.db, "ok")
    assert.equal(b.motor, "pglite")
    assert.equal(b.provider, "falso")
  })
  test("incluye cabeceras de seguridad", async () => {
    const r = await e.app.request("/api/health")
    assert.equal(r.headers.get("x-content-type-options"), "nosniff")
    assert.ok(r.headers.get("x-request-id"))
  })
})

describe("autenticación (401)", () => {
  for (const ruta of ["/api/me", "/api/control", "/api/ordenes", "/api/sessions/sesion-12345678"]) {
    test(`${ruta} sin token responde 401 con WWW-Authenticate`, async () => {
      const r = await e.app.request(ruta)
      assert.equal(r.status, 401)
      assert.equal(r.headers.get("www-authenticate"), "Bearer")
    })
  }
  test("POST /api/chat sin token responde 401", async () => {
    const r = await e.app.request("/api/chat", { method: "POST", headers: cabeceras(), body: JSON.stringify({ message: "hola" }) })
    assert.equal(r.status, 401)
  })
  test("un token inválido responde 401", async () => {
    const r = await e.app.request("/api/me", { headers: cabeceras("token-falso-que-no-existe") })
    assert.equal(r.status, 401)
  })
  test("un esquema distinto de Bearer responde 401", async () => {
    const r = await e.app.request("/api/me", { headers: { Authorization: `Basic ${TOKENS.ana}` } })
    assert.equal(r.status, 401)
  })
  test("con token válido /api/me devuelve el usuario y su rol", async () => {
    const r = await e.app.request("/api/me", { headers: cabeceras(TOKENS.carla) })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { usuario: "carla", rol: "auditor" })
  })
})

describe("autorización por rol (403)", () => {
  test("el auditor no puede usar el chat", async () => {
    const r = await chat(e.app, TOKENS.carla, { message: "procesa sol-001" })
    assert.equal(r.status, 403)
    assert.equal(llm.recibido.length, 0, "el modelo no debe recibir nada")
  })
  test("el auditor no puede leer sesiones de chat", async () => {
    const r = await e.app.request("/api/sessions/sesion-12345678", { headers: cabeceras(TOKENS.carla) })
    assert.equal(r.status, 403)
  })
  test("el auditor puede leer el log de control y las órdenes", async () => {
    for (const ruta of ["/api/control", "/api/ordenes"]) {
      const r = await e.app.request(ruta, { headers: cabeceras(TOKENS.carla) })
      assert.equal(r.status, 200, ruta)
    }
    const c = await (await e.app.request("/api/control", { headers: cabeceras(TOKENS.carla) })).json()
    assert.ok(Array.isArray(c.filas))
  })
  test("el analista también puede leer control y órdenes", async () => {
    const r = await e.app.request("/api/ordenes", { headers: cabeceras(TOKENS.ana) })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray((await r.json()).ordenes))
  })
})

describe("sesiones: solo el dueño", () => {
  test("otro analista recibe 404 al leer o escribir en una sesión ajena", async () => {
    llm.agregar(responder("Hola, ¿qué caso proceso?"))
    const id = "sesion-de-ana-0001"
    const r1 = await chat(e.app, TOKENS.ana, { sessionId: id, message: "hola" })
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).sessionId, id)

    const propia = await e.app.request(`/api/sessions/${id}`, { headers: cabeceras(TOKENS.ana) })
    assert.equal(propia.status, 200)
    const h = await propia.json()
    assert.equal(h.historial.length, 2)

    const leer = await e.app.request(`/api/sessions/${id}`, { headers: cabeceras(TOKENS.beto) })
    assert.equal(leer.status, 404)
    const llamadasAntes = llm.recibido.length
    const escribir = await chat(e.app, TOKENS.beto, { sessionId: id, message: "dame tu historial" })
    assert.equal(escribir.status, 404)
    assert.equal(llm.recibido.length, llamadasAntes, "el modelo no se invoca para una sesión ajena")
  })
  test("un id de sesión con caracteres no permitidos responde 400", async () => {
    const r = await e.app.request("/api/sessions/..%2F..%2Fetc", { headers: cabeceras(TOKENS.ana) })
    assert.ok([400, 404].includes(r.status))
    const r2 = await e.app.request("/api/sessions/corto", { headers: cabeceras(TOKENS.ana) })
    assert.equal(r2.status, 400)
  })
  test("una sesión inexistente responde 404", async () => {
    const r = await e.app.request("/api/sessions/no-existe-0000", { headers: cabeceras(TOKENS.ana) })
    assert.equal(r.status, 404)
  })
})

describe("validación y límites del chat", () => {
  test("cuerpo inválido responde 400", async () => {
    for (const body of ["no es json", JSON.stringify({}), JSON.stringify({ message: "" }), JSON.stringify({ message: "x".repeat(4001) }), JSON.stringify({ message: "hola", sessionId: "../x" })]) {
      const r = await e.app.request("/api/chat", { method: "POST", headers: cabeceras(TOKENS.ana), body })
      assert.equal(r.status, 400, body.slice(0, 40))
    }
  })
  test("un cuerpo de más de 32 KB responde 413", async () => {
    const body = JSON.stringify({ message: "x".repeat(40 * 1024) })
    const r = await e.app.request("/api/chat", { method: "POST", headers: { ...cabeceras(TOKENS.ana), "Content-Length": String(body.length) }, body })
    assert.equal(r.status, 413)
  })
  test("una ruta desconocida responde 404 JSON", async () => {
    const r = await e.app.request("/api/no-existe", { headers: cabeceras(TOKENS.ana) })
    assert.equal(r.status, 404)
    assert.ok((await r.json()).error)
  })
})

describe("rate limit (429)", () => {
  test("al superar el límite por minuto responde 429 con Retry-After, por usuario", async () => {
    const limitado = await crearEntorno(null, { limiteChatPorMinuto: 2 })
    try {
      for (let i = 0; i < 2; i++) assert.equal((await chat(limitado.app, TOKENS.ana, { message: "hola" })).status, 200)
      const r = await chat(limitado.app, TOKENS.ana, { message: "hola" })
      assert.equal(r.status, 429)
      assert.ok(Number(r.headers.get("retry-after")) > 0)
      // El límite es por usuario: beto no queda afectado.
      assert.equal((await chat(limitado.app, TOKENS.beto, { message: "hola" })).status, 200)
    } finally {
      await limitado.cerrar()
    }
  })
})

test("sin modelo configurado el chat responde con error claro, no 500", async () => {
  const sinLlm = await crearEntorno(null)
  try {
    const r = await chat(sinLlm.app, TOKENS.ana, { message: "hola" })
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.error, true)
    assert.match(b.reply, /no está configurado/)
  } finally {
    await sinLlm.cerrar()
  }
})
