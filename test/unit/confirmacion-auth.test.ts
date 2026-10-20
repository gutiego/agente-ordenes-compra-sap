// Detección de confirmación explícita del usuario (CA3) y Autenticador de tokens Bearer.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { esConfirmacion } from "../../src/agent/ciclo.js"
import { Autenticador } from "../../src/auth.js"
import { JSON_TOKENS, TOKENS } from "../helpers/entorno.js"

describe("esConfirmacion", () => {
  for (const m of ["sí, confirmo", "Si", "confirmo las excepciones", "Adelante", "procede", "ok, envíala", "de acuerdo", "dale"]) {
    test(`"${m}" es confirmación`, () => assert.equal(esConfirmacion(m), true))
  }
  for (const m of ["no", "No confirmo", "todavía no", "aún no, espera", "cancela la orden", "sí, pero espera", "hola", "¿qué falta?"]) {
    test(`"${m}" no es confirmación (la negación gana)`, () => assert.equal(esConfirmacion(m), false))
  }
})

describe("Autenticador", () => {
  const auth = new Autenticador(JSON_TOKENS)

  test("un token válido devuelve el usuario y su rol", () => {
    assert.deepEqual(auth.verificar(TOKENS.ana), { usuario: "ana", rol: "analista" })
    assert.deepEqual(auth.verificar(TOKENS.carla), { usuario: "carla", rol: "auditor" })
  })
  test("un token inválido o vacío devuelve null", () => {
    assert.equal(auth.verificar("token-que-no-existe-000"), null)
    assert.equal(auth.verificar(""), null)
    assert.equal(auth.verificar(`${TOKENS.ana} `), null)
  })
  test("JSON mal formado lanza", () => assert.throws(() => new Autenticador("{no es json")))
  test("token de menos de 16 caracteres lanza", () => assert.throws(() => new Autenticador(JSON.stringify({ corto: { usuario: "x", rol: "analista" } }))))
  test("rol desconocido lanza", () => assert.throws(() => new Autenticador(JSON.stringify({ "token-largo-0000000": { usuario: "x", rol: "admin" } }))))
})
