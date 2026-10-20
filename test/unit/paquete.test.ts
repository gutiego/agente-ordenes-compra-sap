// Parsers del paquete (montos colombianos, NIT, cotización y factura en texto) y lectura de casos reales.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"
import type { Db } from "../../src/db/index.js"
import { leerPaquete, normalizarNit, parsearCotizacion, parsearFactura, parsearMonto } from "../../src/tools/paquete.js"
import { RAIZ } from "../helpers/entorno.js"

const fixture = (caso: string, archivo: string) => readFile(path.join(RAIZ, "fixtures", "reto-03", "solicitudes", caso, archivo), "utf8")
const ctx = { directory: RAIZ, sessionId: "unit", db: null as unknown as Db, usuario: "unit" }

describe("parsearMonto", () => {
  test("interpreta punto de miles", () => assert.equal(parsearMonto("11.400.000"), 11_400_000))
  test("interpreta coma decimal", () => assert.equal(parsearMonto("1.850.000,50"), 1_850_000.5))
  test("acepta números sin separadores", () => assert.equal(parsearMonto("95000"), 95_000))
})

describe("normalizarNit", () => {
  test("quita puntos y dígito de verificación", () => assert.equal(normalizarNit("900.555.111-2"), "900555111"))
  test("deja intacto un NIT ya normalizado", () => assert.equal(normalizarNit("900555111"), "900555111"))
})

describe("parsearCotizacion", () => {
  test("extrae referencia, NIT, total, moneda, validez e ítems (sol-004)", async () => {
    const c = parsearCotizacion(await fixture("sol-004", "cotizacion.txt"))
    assert.ok(c)
    assert.equal(c.referencia, "CA-2026-0310")
    assert.equal(c.fecha, "2026-08-25")
    assert.equal(c.nit, "901222333")
    assert.equal(c.total, 26_500_000)
    assert.equal(c.moneda, "COP")
    assert.equal(c.validez_hasta, "2026-09-14") // 20 días
    assert.equal(c.items.length, 1)
    assert.deepEqual({ cantidad: c.items[0].cantidad, precio: c.items[0].precio_unitario }, { cantidad: 100, precio: 265_000 })
    assert.match(c.items[0].descripcion, /arquitecto de nube/i)
  })
  test("devuelve null si no encuentra la línea TOTAL", () => {
    assert.equal(parsearCotizacion("COTIZACIÓN X-1\nFecha: 2026-01-01\nSin total"), null)
  })
})

describe("parsearFactura", () => {
  test("extrae número, fecha de emisión y total (sol-005)", async () => {
    const f = parsearFactura(await fixture("sol-005", "factura.txt"))
    assert.deepEqual(f, { numero: "FC-88231", fecha: "2026-08-10", total: 3_200_000 })
  })
  test("devuelve null si falta la fecha de emisión", () => {
    assert.equal(parsearFactura("FACTURA No. F-1\nTOTAL: COP 1.000"), null)
  })
})

describe("leerPaquete", () => {
  test("normaliza un caso completo sin faltantes (sol-001)", async () => {
    const r = await leerPaquete(ctx, "sol-001", "aprobado")
    assert.ok(r.ok)
    assert.equal(r.valor.solicitud.solicitud_id, "SOL-2026-001")
    assert.deepEqual(r.valor.faltantes, [])
    assert.equal(r.valor.aprobacion?.aprobado, true)
    assert.equal(r.valor.factura, null)
  })
  test("incluye la factura cuando el caso la trae (sol-005)", async () => {
    const r = await leerPaquete(ctx, "sol-005", "aprobado")
    assert.ok(r.ok)
    assert.equal(r.valor.factura?.numero, "FC-88231")
  })
  test("falla con mensaje claro si el caso no existe", async () => {
    const r = await leerPaquete(ctx, "sol-999", "aprobado")
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /sol-999/)
  })
})
