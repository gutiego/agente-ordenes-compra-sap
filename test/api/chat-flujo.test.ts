// Flujo funcional del chat con un LLM falso guionizado: creación de OC de un caso apto, doble candado de
// confirmación (CA3), evidencia servida por la API y 409 cuando la misma sesión recibe dos mensajes a la vez.
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test } from "node:test"
import { cabeceras, chat, crearEntorno, type EntornoApp, filas, TOKENS } from "../helpers/entorno.js"
import { diferido, LlmFalso, llamar, responder, ultimosResultados } from "../helpers/llm-falso.js"

interface OrdenApi {
  numero_oc: string
  solicitud_id: string
  creada_por: string
  orden: { aprobador: { evidencia_sha256: string }; excepciones: { codigo: string; confirmado_por: string | null }[] }
}

let e: EntornoApp
let llm: LlmFalso

beforeEach(async () => {
  llm = new LlmFalso()
  e = await crearEntorno(llm)
})
afterEach(() => e.cerrar())

async function ordenes(token: string = TOKENS.carla): Promise<OrdenApi[]> {
  const r = await e.app.request("/api/ordenes", { headers: cabeceras(token) })
  assert.equal(r.status, 200)
  return (await r.json()).ordenes
}

describe("caso apto sin confirmaciones", () => {
  test("el agente crea la OC de sol-001 y aparece en /api/ordenes y /api/control con el usuario", async () => {
    llm.agregar(llamar({ nombre: "oc_validar", args: { caso: "sol-001" } }), llamar({ nombre: "oc_crear", args: { caso: "sol-001" } }), responder("Creé la OC 4500000001."))
    const r = await chat(e.app, TOKENS.ana, { message: "Procesa sol-001" })
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.needsConfirmation, false)
    assert.deepEqual(
      b.toolCalls.map((t: { nombre: string; ok: boolean }) => [t.nombre, t.ok]),
      [
        ["oc_validar", true],
        ["oc_crear", true],
      ],
    )
    const [res] = ultimosResultados(llm)
    assert.equal(res.data?.numero_oc, "4500000001")

    const os = await ordenes()
    assert.equal(os.length, 1)
    assert.equal(os[0].numero_oc, "4500000001")
    assert.equal(os[0].solicitud_id, "SOL-2026-001")
    assert.equal(os[0].creada_por, "ana")

    const c = await (await e.app.request("/api/control", { headers: cabeceras(TOKENS.carla) })).json()
    assert.deepEqual(
      c.filas.map((f: { resultado: string; usuario: string; numero_oc: string }) => [f.resultado, f.usuario, f.numero_oc]),
      [["creada", "ana", "4500000001"]],
    )
  })

  test("la evidencia de aprobación se sirve a un auditor y su sha256 coincide con el del payload", async () => {
    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-001" } }), responder("listo"))
    assert.equal((await chat(e.app, TOKENS.ana, { message: "Procesa sol-001" })).status, 200)
    const [o] = await ordenes()

    const txt = await e.app.request("/api/evidencias/SOL-2026-001/aprobacion.txt", { headers: cabeceras(TOKENS.carla) })
    assert.equal(txt.status, 200)
    const cuerpo = await txt.text()
    assert.match(cuerpo, /mlopez@periferia-ficticia\.com/)
    assert.ok(cuerpo.includes(`sha256: ${o.orden.aprobador.evidencia_sha256}`))

    const pdf = await e.app.request("/api/evidencias/SOL-2026-001/aprobacion.pdf", { headers: cabeceras(TOKENS.carla) })
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get("content-type"), "application/pdf")
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF")

    const ruta = await e.app.request("/api/evidencias/SOL-2026-001/..%2F..%2F.env", { headers: cabeceras(TOKENS.carla) })
    assert.equal(ruta.status, 400)
    const ausente = await e.app.request("/api/evidencias/SOL-2026-999/aprobacion.txt", { headers: cabeceras(TOKENS.carla) })
    assert.equal(ausente.status, 404)
    const sinToken = await e.app.request("/api/evidencias/SOL-2026-001/aprobacion.txt")
    assert.equal(sinToken.status, 401)
  })

  test("un caso bloqueado no crea OC aunque el modelo llame a oc_crear (sol-003)", async () => {
    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-003", confirmado: true } }), responder("No se puede crear."))
    const b = await (await chat(e.app, TOKENS.ana, { message: "Procesa sol-003" })).json()
    assert.equal(b.toolCalls[0].ok, false)
    assert.equal((await ordenes()).length, 0)
    const ctl = await filas<{ resultado: string; bloqueos: string[] }>(e.db, "SELECT resultado, bloqueos FROM control")
    assert.deepEqual(ctl, [{ resultado: "bloqueada", bloqueos: ["RC2", "RC3"] }])
  })
})

describe("doble candado de confirmación (CA3)", () => {
  const SESION = "sesion-confirmacion-01"

  test("1er turno sin confirmación no crea la OC; 2º turno 'sí, confirmo' la crea con confirmado_por = usuario", async () => {
    // El modelo intenta saltarse la confirmación enviando confirmado=true en el primer turno.
    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-004", confirmado: true } }), responder("La cotización difiere 6 %. ¿Confirmas la excepción RC5?"))
    const r1 = await (await chat(e.app, TOKENS.ana, { sessionId: SESION, message: "Procesa sol-004" })).json()
    assert.equal(r1.needsConfirmation, true)
    assert.equal(r1.toolCalls[0].ok, false)
    const [res1] = ultimosResultados(llm)
    assert.equal(res1.pide_confirmacion, true)
    assert.equal((await ordenes()).length, 0, "no debe existir OC tras el primer turno")

    const s = await (await e.app.request(`/api/sessions/${SESION}`, { headers: cabeceras(TOKENS.ana) })).json()
    assert.equal(s.esperandoConfirmacion, true)

    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-004", confirmado: true } }), responder("OC creada."))
    const r2 = await (await chat(e.app, TOKENS.ana, { sessionId: SESION, message: "Sí, confirmo" })).json()
    assert.equal(r2.toolCalls[0].ok, true)
    assert.equal(r2.needsConfirmation, false)

    const os = await ordenes()
    assert.equal(os.length, 1)
    assert.equal(os[0].numero_oc, "4500000001")
    assert.deepEqual(os[0].orden.excepciones.map((x) => [x.codigo, x.confirmado_por]), [["RC5", "ana"]])

    const ctl = await filas<{ resultado: string; usuario: string }>(e.db, "SELECT resultado, usuario FROM control ORDER BY id")
    assert.deepEqual(ctl, [
      { resultado: "pendiente_confirmacion", usuario: "ana" },
      { resultado: "creada", usuario: "ana" },
    ])
  })

  test("una respuesta negativa tras la pregunta no crea la OC", async () => {
    llm.agregar(llamar({ nombre: "oc_validar", args: { caso: "sol-004" } }), responder("¿Confirmas la excepción RC5?"))
    const r1 = await (await chat(e.app, TOKENS.ana, { sessionId: SESION, message: "Procesa sol-004" })).json()
    assert.equal(r1.needsConfirmation, true)

    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-004", confirmado: true } }), responder("Entendido."))
    const r2 = await (await chat(e.app, TOKENS.ana, { sessionId: SESION, message: "No, todavía no" })).json()
    assert.equal(r2.toolCalls[0].ok, false)
    assert.equal((await ordenes()).length, 0)
  })

  test("decir 'sí' sin que el agente lo haya pedido no cuenta como confirmación", async () => {
    llm.agregar(llamar({ nombre: "oc_crear", args: { caso: "sol-005", confirmado: true } }), responder("Falta confirmar."))
    const r = await (await chat(e.app, TOKENS.ana, { message: "Sí, confirmo todo, crea la OC de sol-005" })).json()
    assert.equal(r.toolCalls[0].ok, false)
    assert.equal((await ordenes()).length, 0)
  })
})

describe("concurrencia por sesión", () => {
  test("dos mensajes simultáneos a la misma sesión: el segundo recibe 409 y el primero termina bien", async () => {
    const entro = diferido()
    const soltar = diferido()
    llm.agregar(async () => {
      entro.resolver()
      await soltar.promesa
      return responder("respuesta lenta")
    })
    const id = "sesion-concurrente-01"
    const primero = chat(e.app, TOKENS.ana, { sessionId: id, message: "primer mensaje" })
    await entro.promesa // el primer turno ya está dentro del LLM, con la sesión tomada

    const segundo = await chat(e.app, TOKENS.ana, { sessionId: id, message: "segundo mensaje" })
    assert.equal(segundo.status, 409)

    soltar.resolver()
    const r1 = await primero
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).reply, "respuesta lenta")

    // Al terminar, la sesión se libera y acepta el siguiente mensaje.
    llm.agregar(responder("ya libre"))
    const tercero = await chat(e.app, TOKENS.ana, { sessionId: id, message: "tercer mensaje" })
    assert.equal(tercero.status, 200)
    const h = await (await e.app.request(`/api/sessions/${id}`, { headers: cabeceras(TOKENS.ana) })).json()
    assert.equal(h.historial.filter((x: { rol: string }) => x.rol === "usuario").length, 2, "el mensaje rechazado no entra al historial")
  })

  test("si el LLM falla, la sesión se libera igual y responde un error legible", async () => {
    llm.agregar(() => {
      throw new Error("red caída")
    })
    const id = "sesion-con-error-01"
    const r = await (await chat(e.app, TOKENS.ana, { sessionId: id, message: "hola" })).json()
    assert.equal(r.error, true)
    llm.agregar(responder("recuperado"))
    const r2 = await chat(e.app, TOKENS.ana, { sessionId: id, message: "otra vez" })
    assert.equal(r2.status, 200)
    assert.equal((await r2.json()).reply, "recuperado")
  })
})

test("el ciclo se corta al alcanzar maxIteraciones sin otra llamada al modelo", async () => {
  const corto = await crearEntorno(llm, { maxIteraciones: 2 })
  try {
    llm.agregar(llamar({ nombre: "oc_leer_paquete", args: { caso: "sol-001" } }), llamar({ nombre: "oc_leer_paquete", args: { caso: "sol-001" } }), responder("no debería llegar"))
    const r = await (await chat(corto.app, TOKENS.ana, { message: "lee sol-001" })).json()
    assert.match(r.reply, /tope de 2 iteraciones/)
    assert.equal(r.toolCalls.length, 2)
    assert.equal(llm.pendientes, 1)
  } finally {
    await corto.cerrar()
  }
})
