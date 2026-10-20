// Controles RC1–RC10 (funciones puras): por cada regla, un caso real o modificado que la dispara y uno que no.
// Los paquetes salen de los fixtures reales y se clonan antes de alterarlos.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import type { Db } from "../../src/db/index.js"
import type { CtxHerramienta } from "../../src/tools/comun.js"
import { validarPaquete } from "../../src/tools/controles.js"
import { cargarReferencia, type Referencia } from "../../src/tools/maestros.js"
import { leerPaquete } from "../../src/tools/paquete.js"
import type { Paquete, Validacion } from "../../src/tools/tipos.js"
import { RAIZ } from "../helpers/entorno.js"

// Estas funciones solo leen fixtures: no tocan la base.
const ctx: CtxHerramienta = { directory: RAIZ, sessionId: "unit", db: null as unknown as Db, usuario: "unit" }
let ref: Referencia

async function paquete(caso: string): Promise<Paquete> {
  const r = await leerPaquete(ctx, caso, ref.reglas.palabra_aprobacion)
  assert.ok(r.ok, `no se pudo leer ${caso}`)
  return structuredClone(r.valor)
}

const bloqueos = (v: Validacion) => v.bloqueos.map((b) => b.codigo)
const confirmaciones = (v: Validacion) => v.confirmaciones.map((c) => c.codigo)

before(async () => {
  const r = await cargarReferencia(ctx)
  assert.ok(r.ok, "los maestros deben cargar")
  ref = r.valor
})

describe("clasificación de los 6 casos de los fixtures", () => {
  const esperado: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean }> = {
    "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
    "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
    "sol-003": { apta: false, bloqueos: ["RC2", "RC3"], confirmaciones: [], retroactiva: false },
    "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
    "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
    "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
  }
  for (const [caso, e] of Object.entries(esperado)) {
    test(`${caso}: apta=${e.apta}, bloqueos [${e.bloqueos}], confirmaciones [${e.confirmaciones}]`, async () => {
      const v = validarPaquete(await paquete(caso), ref)
      assert.equal(v.apta, e.apta)
      assert.deepEqual(bloqueos(v), e.bloqueos)
      assert.deepEqual(confirmaciones(v), e.confirmaciones)
      assert.equal(v.retroactiva, e.retroactiva)
    })
  }
})

describe("RC1 proveedor", () => {
  test("bloquea si el proveedor no existe en el maestro (sol-002)", async () => {
    const v = validarPaquete(await paquete("sol-002"), ref)
    assert.ok(bloqueos(v).includes("RC1"))
    assert.match(v.bloqueos[0].detalle, /no existe/)
    assert.ok(v.bloqueos[0].accion_sugerida, "debe sugerir una acción")
  })
  test("bloquea si el proveedor está inactivo", async () => {
    const p = await paquete("sol-001")
    p.solicitud.proveedor_nit = "901777888" // Consultores Ágiles, activo=false
    const v = validarPaquete(p, ref)
    assert.ok(bloqueos(v).includes("RC1"))
    assert.match(v.bloqueos.find((b) => b.codigo === "RC1")?.detalle ?? "", /inactivo/)
  })
  test("no dispara con proveedor activo por NIT (sol-001)", async () => {
    const v = validarPaquete(await paquete("sol-001"), ref)
    assert.ok(!bloqueos(v).includes("RC1"))
  })
  test("sin NIT busca por nombre normalizado y deriva el NIT (sol-006)", async () => {
    const v = validarPaquete(await paquete("sol-006"), ref)
    assert.ok(!bloqueos(v).includes("RC1"))
    assert.equal(v.derivados.proveedor_nit?.valor, "900555111")
  })
})

describe("RC2 aprobación", () => {
  test("bloquea si quien aprueba no es aprobador del centro de costo (sol-003)", async () => {
    const v = validarPaquete(await paquete("sol-003"), ref)
    assert.ok(bloqueos(v).includes("RC2"))
  })
  test("bloquea si no hay correo de aprobación", async () => {
    const p = await paquete("sol-001")
    p.aprobacion = null
    assert.ok(bloqueos(validarPaquete(p, ref)).includes("RC2"))
  })
  test("bloquea si el correo no contiene la palabra Aprobado", async () => {
    const p = await paquete("sol-001")
    assert.ok(p.aprobacion)
    p.aprobacion.aprobado = false
    assert.ok(bloqueos(validarPaquete(p, ref)).includes("RC2"))
  })
  test("no dispara con aprobación válida del aprobador del centro (sol-001)", async () => {
    assert.ok(!bloqueos(validarPaquete(await paquete("sol-001"), ref)).includes("RC2"))
  })
})

describe("RC3 tope de aprobación", () => {
  test("bloquea si el valor supera el tope del aprobador", async () => {
    const p = await paquete("sol-001") // mlopez, tope 50.000.000
    p.solicitud.cantidad = 600
    p.solicitud.valor_total = 57_000_000
    const v = validarPaquete(p, ref)
    assert.ok(bloqueos(v).includes("RC3"))
    assert.ok(!bloqueos(v).includes("RC10"), "la aritmética sigue cuadrando")
  })
  test("bloquea si el valor supera el tope máximo del centro (sol-003)", async () => {
    assert.ok(bloqueos(validarPaquete(await paquete("sol-003"), ref)).includes("RC3"))
  })
  test("no dispara si el valor está dentro del tope (sol-001)", async () => {
    assert.ok(!bloqueos(validarPaquete(await paquete("sol-001"), ref)).includes("RC3"))
  })
})

describe("RC4 centro de costo y subárea", () => {
  test("bloquea si el centro de costo no existe", async () => {
    const p = await paquete("sol-001")
    p.solicitud.centro_costo = "CC-9999"
    assert.ok(bloqueos(validarPaquete(p, ref)).includes("RC4"))
  })
  test("bloquea si la subárea no pertenece al centro", async () => {
    const p = await paquete("sol-001")
    p.solicitud.subarea = "Marketing"
    const v = validarPaquete(p, ref)
    assert.ok(bloqueos(v).includes("RC4"))
    assert.match(v.bloqueos.find((b) => b.codigo === "RC4")?.detalle ?? "", /no pertenece/)
  })
  test("no dispara con subárea válida (sol-001)", async () => {
    assert.ok(!bloqueos(validarPaquete(await paquete("sol-001"), ref)).includes("RC4"))
  })
})

describe("RC5 cotización vs solicitud", () => {
  test("pide confirmación si la cotización difiere más del 2 % (sol-004: 6 %)", async () => {
    const v = validarPaquete(await paquete("sol-004"), ref)
    assert.ok(confirmaciones(v).includes("RC5"))
    assert.equal(v.apta, true, "RC5 no bloquea")
    assert.equal(v.confirmaciones[0].valores?.cotizacion, 26_500_000)
  })
  test("pide confirmación si no hay cotización legible", async () => {
    const p = await paquete("sol-001")
    p.cotizacion = null
    assert.ok(confirmaciones(validarPaquete(p, ref)).includes("RC5"))
  })
  test("no dispara si la diferencia está dentro de la tolerancia", async () => {
    const p = await paquete("sol-001")
    assert.ok(p.cotizacion)
    p.cotizacion.total = 11_500_000 // +0,88 %
    assert.ok(!confirmaciones(validarPaquete(p, ref)).includes("RC5"))
  })
})

describe("RC6 indicador de IVA y RC7 condiciones de pago", () => {
  test("RC6: sin indicador de IVA propone el default del proveedor y pide confirmación (sol-006)", async () => {
    const v = validarPaquete(await paquete("sol-006"), ref)
    assert.ok(confirmaciones(v).includes("RC6"))
    assert.equal(v.derivados.indicador_iva?.valor, "C1")
  })
  test("RC6: no dispara si la solicitud trae indicador de IVA (sol-001)", async () => {
    const v = validarPaquete(await paquete("sol-001"), ref)
    assert.ok(!confirmaciones(v).includes("RC6"))
    assert.equal(v.derivados.indicador_iva, undefined)
  })
  test("RC7: sin condiciones de pago deriva el default del proveedor sin pedir confirmación (sol-006)", async () => {
    const v = validarPaquete(await paquete("sol-006"), ref)
    assert.equal(v.derivados.condiciones_pago?.valor, "Z030")
    assert.ok(!confirmaciones(v).includes("RC7"))
  })
  test("RC7: no deriva si la solicitud trae condiciones de pago (sol-001)", async () => {
    assert.equal(validarPaquete(await paquete("sol-001"), ref).derivados.condiciones_pago, undefined)
  })
})

describe("RC8 OC retroactiva", () => {
  test("marca retroactiva y pide confirmación si la factura es anterior a la solicitud (sol-005)", async () => {
    const v = validarPaquete(await paquete("sol-005"), ref)
    assert.equal(v.retroactiva, true)
    assert.ok(confirmaciones(v).includes("RC8"))
  })
  test("no es retroactiva si la factura es posterior a la solicitud", async () => {
    const p = await paquete("sol-005")
    assert.ok(p.factura)
    p.factura.fecha = "2026-09-01"
    const v = validarPaquete(p, ref)
    assert.equal(v.retroactiva, false)
    assert.ok(!confirmaciones(v).includes("RC8"))
  })
  test("no es retroactiva sin factura (sol-001)", async () => {
    assert.equal(validarPaquete(await paquete("sol-001"), ref).retroactiva, false)
  })
})

describe("RC9 fecha de aprobación", () => {
  test("pide confirmación si la aprobación es anterior a la solicitud", async () => {
    const p = await paquete("sol-001")
    assert.ok(p.aprobacion)
    p.aprobacion.fecha = "2026-08-01T09:00:00-05:00"
    const v = validarPaquete(p, ref)
    assert.ok(confirmaciones(v).includes("RC9"))
    assert.equal(v.apta, true)
  })
  test("no dispara si la aprobación es posterior a la solicitud (sol-001)", async () => {
    assert.ok(!confirmaciones(validarPaquete(await paquete("sol-001"), ref)).includes("RC9"))
  })
})

describe("RC10 aritmética de la solicitud", () => {
  test("bloquea si cantidad × valor unitario no cuadra con el total", async () => {
    const p = await paquete("sol-001")
    p.solicitud.valor_total = 11_000_000
    const v = validarPaquete(p, ref)
    assert.ok(bloqueos(v).includes("RC10"))
    assert.equal(v.apta, false)
  })
  test("tolera diferencias de redondeo de hasta 1 peso", async () => {
    const p = await paquete("sol-001")
    p.solicitud.valor_total = 11_400_001
    assert.ok(!bloqueos(validarPaquete(p, ref)).includes("RC10"))
  })
  test("no dispara si cuadra (sol-001)", async () => {
    assert.ok(!bloqueos(validarPaquete(await paquete("sol-001"), ref)).includes("RC10"))
  })
})

test("los bloqueos y confirmaciones salen ordenados por número de regla", async () => {
  const p = await paquete("sol-001")
  p.solicitud.valor_total = 99_000_000 // RC3 y RC10
  p.solicitud.subarea = "Marketing" // RC4
  p.cotizacion = null // RC5
  const v = validarPaquete(p, ref)
  const numeros = bloqueos(v).map((c) => Number(c.slice(2)))
  assert.deepEqual(numeros, [...numeros].sort((a, b) => a - b))
  assert.ok(numeros.length >= 2)
})
