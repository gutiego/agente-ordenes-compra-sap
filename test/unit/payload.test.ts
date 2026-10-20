// Construcción del payload OrdenCompra: esquema zod, texto breve SAP ≤ 40, unidad derivada y comparación canónica.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import type { Db } from "../../src/db/index.js"
import { validarPaquete } from "../../src/tools/controles.js"
import { cargarReferencia, type Referencia } from "../../src/tools/maestros.js"
import { leerPaquete } from "../../src/tools/paquete.js"
import { canonico, construirOrden, derivarUnidad, sinConfirmador, textoBreve } from "../../src/tools/payload.js"
import { esquemaOrdenCompra, type OrdenCompra, type Paquete } from "../../src/tools/tipos.js"
import { RAIZ } from "../helpers/entorno.js"

const ctx = { directory: RAIZ, sessionId: "unit", db: null as unknown as Db, usuario: "unit" }
const SHA = "a".repeat(64)
let ref: Referencia

async function paquete(caso: string): Promise<Paquete> {
  const r = await leerPaquete(ctx, caso, "aprobado")
  assert.ok(r.ok)
  return r.valor
}

async function orden(caso: string): Promise<OrdenCompra> {
  const p = await paquete(caso)
  const r = construirOrden(p, validarPaquete(p, ref), ref, SHA)
  assert.ok(r.ok, r.ok ? "" : r.error)
  return r.valor.orden
}

before(async () => {
  const r = await cargarReferencia(ctx)
  assert.ok(r.ok)
  ref = r.valor
})

describe("construirOrden", () => {
  for (const caso of ["sol-001", "sol-004", "sol-005", "sol-006"]) {
    test(`${caso}: el payload cumple el esquema OrdenCompra y la descripción ≤ 40 caracteres`, async () => {
      const o = await orden(caso)
      assert.equal(esquemaOrdenCompra.safeParse(o).success, true)
      assert.ok(o.posiciones[0].descripcion.length <= 40)
      assert.equal(o.posiciones[0].numero, 10)
      assert.equal(o.sociedad, "1000")
    })
  }

  test("sol-001 toma valores de la solicitud y del maestro", async () => {
    const o = await orden("sol-001")
    assert.equal(o.proveedor.codigo_sap, "100234")
    assert.equal(o.posiciones[0].precio_unitario, 95_000)
    assert.equal(o.posiciones[0].cantidad, 120)
    assert.equal(o.posiciones[0].unidad, "UN")
    assert.equal(o.aprobador.email, "mlopez@periferia-ficticia.com")
    assert.equal(o.aprobador.evidencia_sha256, SHA)
    assert.deepEqual(o.excepciones, [])
  })

  test("sol-004 (bolsa de horas) usa unidad H y precio de la solicitud, no de la cotización", async () => {
    const o = await orden("sol-004")
    assert.equal(o.posiciones[0].unidad, "H")
    assert.equal(o.posiciones[0].precio_unitario, 250_000)
    assert.deepEqual(o.excepciones.map((e) => [e.codigo, e.confirmado_por]), [["RC5", null]])
  })

  test("sol-006 usa IVA y condiciones derivados del maestro del proveedor", async () => {
    const o = await orden("sol-006")
    assert.equal(o.posiciones[0].indicador_iva, "C1")
    assert.equal(o.condiciones_pago, "Z030")
    assert.equal(o.proveedor.nit, "900555111")
  })

  test("no construye la OC de un paquete con bloqueos (sol-003)", async () => {
    const p = await paquete("sol-003")
    const r = construirOrden(p, validarPaquete(p, ref), ref, SHA)
    assert.equal(r.ok, false)
  })

  test("la trazabilidad indica la fuente de cada campo", async () => {
    const p = await paquete("sol-006")
    const r = construirOrden(p, validarPaquete(p, ref), ref, SHA)
    assert.ok(r.ok)
    const iva = r.valor.trazabilidad.find((t) => t.campo === "posiciones[0].indicador_iva")
    assert.equal(iva?.fuente, "maestro.proveedores")
    assert.ok(r.valor.trazabilidad.every((t) => t.fuente.length > 0))
  })
})

describe("textoBreve", () => {
  test("no toca descripciones cortas", () => assert.equal(textoBreve("Papelería y tóner", 40), "Papelería y tóner"))
  test("corta en límite de palabra y sin conectores colgando", () => {
    const t = textoBreve("Bolsa de 100 horas de arquitectura de nube para migración", 40)
    assert.ok(t.length <= 40)
    assert.doesNotMatch(t, /\s(de|para|y)$/)
    assert.ok("Bolsa de 100 horas de arquitectura de nube para migración".startsWith(t))
  })
  test("respeta el máximo con una palabra muy larga", () => assert.ok(textoBreve("x".repeat(80), 40).length <= 40))
})

describe("derivarUnidad", () => {
  test("detecta servicios mensuales como MES", async () => {
    const p = structuredClone(await paquete("sol-001"))
    p.solicitud.descripcion = "Soporte mensual de infraestructura"
    p.cotizacion = null
    assert.equal(derivarUnidad(p, ref.reglas), "MES")
  })
  test("usa UN por defecto", async () => assert.equal(derivarUnidad(await paquete("sol-001"), ref.reglas), "UN"))
})

describe("canonico y sinConfirmador", () => {
  test("canonico no depende del orden de las claves", () => {
    assert.equal(canonico({ a: 1, b: { c: 2, d: [1, 2] } }), canonico({ b: { d: [1, 2], c: 2 }, a: 1 }))
  })
  test("canonico distingue un cambio de valor", () => {
    assert.notEqual(canonico({ precio: 180_000 }), canonico({ precio: 175_000 }))
  })
  test("sinConfirmador borra quién confirmó sin mutar el original", async () => {
    const o = await orden("sol-004")
    const confirmada = { ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: "ana" })) }
    const limpia = sinConfirmador(confirmada)
    assert.ok(limpia.excepciones.every((e) => e.confirmado_por === null))
    assert.equal(confirmada.excepciones[0].confirmado_por, "ana")
    assert.equal(canonico(limpia), canonico(o))
  })
})
