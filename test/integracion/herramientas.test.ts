// Herramientas oc_* contra la base (PGlite en memoria): idempotencia, numeración sin huecos, bloqueos,
// doble candado de confirmación, rechazo de payloads/paquetes alterados (CA2) y ausencia de escrituras en disco.
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { abrirDb, type Db } from "../../src/db/index.js"
import { ejecutarHerramienta } from "../../src/tools/registro.js"
import { ctxDe, filas, herramienta, RAIZ } from "../helpers/entorno.js"

let db: Db
beforeEach(async () => {
  db = await abrirDb()
})
afterEach(() => db.cerrar())

const ordenes = () => filas<{ numero_oc: string; solicitud_id: string; creada_por: string }>(db, "SELECT numero_oc, solicitud_id, creada_por FROM ordenes ORDER BY numero_oc")
const control = () => filas<{ solicitud_id: string; resultado: string; numero_oc: string | null; usuario: string; retroactiva: boolean }>(db, "SELECT solicitud_id, resultado, numero_oc, usuario, retroactiva FROM control ORDER BY id")

describe("oc_crear: idempotencia y numeración", () => {
  test("crear dos veces el mismo caso devuelve el mismo número y deja una sola OC", async () => {
    const ctx = ctxDe(db)
    const a = await herramienta("oc_crear", { caso: "sol-001" }, ctx)
    const b = await herramienta("oc_crear", { caso: "sol-001" }, ctx)
    assert.equal(a.ok, true)
    assert.equal(a.data?.numero_oc, "4500000001")
    assert.equal(a.data?.idempotente, false)
    assert.equal(b.ok, true)
    assert.equal(b.data?.numero_oc, "4500000001")
    assert.equal(b.data?.idempotente, true)
    assert.equal((await ordenes()).length, 1)
    assert.deepEqual((await control()).map((f) => f.resultado), ["creada", "existente"])
  })

  test("10 creaciones simultáneas del mismo caso producen una sola OC", async () => {
    const ctx = ctxDe(db)
    const rs = await Promise.all(Array.from({ length: 10 }, () => herramienta("oc_crear", { caso: "sol-001" }, ctx)))
    assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)))
    assert.deepEqual(new Set(rs.map((r) => r.data?.numero_oc)), new Set(["4500000001"]))
    assert.equal(rs.filter((r) => r.data?.idempotente === false).length, 1, "exactamente una llamada crea")
    const os_ = await ordenes()
    assert.equal(os_.length, 1)
    const ctl = await control()
    assert.equal(ctl.length, 10, "una fila de control por intento")
    assert.equal(ctl.filter((f) => f.resultado === "creada").length, 1)
  })

  test("las simultáneas no consumen números: la siguiente OC es la consecutiva", async () => {
    const ctx = ctxDe(db)
    await Promise.all(Array.from({ length: 10 }, () => herramienta("oc_crear", { caso: "sol-001" }, ctx)))
    const siguiente = await herramienta("oc_crear", { caso: "sol-006", confirmado: true }, ctx)
    assert.equal(siguiente.data?.numero_oc, "4500000002")
  })

  test("casos distintos en paralelo reciben números únicos y consecutivos desde 4500000001", async () => {
    const ctx = ctxDe(db) // sin confirmacionHumana (modo demo): basta confirmado=true
    const casos = ["sol-001", "sol-004", "sol-005", "sol-006"]
    const rs = await Promise.all(casos.map((caso) => herramienta("oc_crear", { caso, confirmado: true }, ctx)))
    assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)))
    const numeros = rs.map((r) => r.data?.numero_oc).sort()
    assert.deepEqual(numeros, ["4500000001", "4500000002", "4500000003", "4500000004"])
    assert.equal((await ordenes()).length, 4)
  })

  test("los intentos bloqueados o pendientes no dejan huecos en la numeración", async () => {
    const ctx = ctxDe(db)
    await herramienta("oc_crear", { caso: "sol-002" }, ctx) // bloqueada
    await herramienta("oc_crear", { caso: "sol-004" }, ctx) // pendiente de confirmación
    const r = await herramienta("oc_crear", { caso: "sol-001" }, ctx)
    assert.equal(r.data?.numero_oc, "4500000001")
  })

  test("la OC registra quién la creó y la fila de control lleva el usuario y la marca retroactiva", async () => {
    await herramienta("oc_crear", { caso: "sol-005", confirmado: true }, ctxDe(db, { usuario: "beto" }))
    assert.deepEqual(await ordenes(), [{ numero_oc: "4500000001", solicitud_id: "SOL-2026-005", creada_por: "beto" }])
    assert.deepEqual(await control(), [{ solicitud_id: "SOL-2026-005", resultado: "creada", numero_oc: "4500000001", usuario: "beto", retroactiva: true }])
  })
})

describe("oc_crear: controles que impiden crear", () => {
  for (const [caso, solicitud, codigos] of [
    ["sol-002", "SOL-2026-002", ["RC1"]],
    ["sol-003", "SOL-2026-003", ["RC2", "RC3"]],
  ] as const) {
    test(`${caso} bloqueado no crea OC y registra 'bloqueada' en control`, async () => {
      const r = await herramienta("oc_crear", { caso, confirmado: true }, ctxDe(db))
      assert.equal(r.ok, false)
      assert.match(r.error ?? "", /bloqueos/)
      assert.equal((await ordenes()).length, 0)
      const ctl = await filas<{ solicitud_id: string; resultado: string; bloqueos: string[]; numero_oc: string | null }>(db, "SELECT solicitud_id, resultado, bloqueos, numero_oc FROM control")
      assert.deepEqual(ctl, [{ solicitud_id: solicitud, resultado: "bloqueada", bloqueos: [...codigos], numero_oc: null }])
    })
  }

  for (const caso of ["sol-004", "sol-005", "sol-006"]) {
    test(`${caso} con confirmaciones pendientes no se crea sin confirmado=true`, async () => {
      const r = await herramienta("oc_crear", { caso }, ctxDe(db))
      assert.equal(r.ok, false)
      assert.equal(r.pide_confirmacion, true)
      assert.equal((await ordenes()).length, 0)
      assert.deepEqual((await control()).map((f) => f.resultado), ["pendiente_confirmacion"])
    })
  }

  test("confirmado=true no basta si el servidor no vio confirmación humana (confirmacionHumana=false)", async () => {
    const r = await herramienta("oc_crear", { caso: "sol-004", confirmado: true }, ctxDe(db, { confirmacionHumana: false }))
    assert.equal(r.ok, false)
    assert.equal(r.pide_confirmacion, true)
    assert.equal((await ordenes()).length, 0)
  })

  test("con confirmación humana y confirmado=true se crea y confirmado_por es el usuario", async () => {
    const r = await herramienta("oc_crear", { caso: "sol-004", confirmado: true }, ctxDe(db, { usuario: "ana", confirmacionHumana: true }))
    assert.equal(r.ok, true)
    const [o] = await filas<{ orden: { excepciones: { codigo: string; confirmado_por: string }[] } }>(db, "SELECT orden FROM ordenes")
    assert.deepEqual(o.orden.excepciones.map((e) => [e.codigo, e.confirmado_por]), [["RC5", "ana"]])
  })
})

describe("CA2: el modelo no puede alterar montos", () => {
  test("un payload con el precio alterado se rechaza y queda 'rechazada' en control", async () => {
    const ctx = ctxDe(db)
    const c = await herramienta("oc_construir_payload", { caso: "sol-006" }, ctx)
    assert.equal(c.ok, true)
    const alterado = structuredClone(c.data?.payload) as { posiciones: { precio_unitario: number }[] }
    alterado.posiciones[0].precio_unitario = 175_000
    const r = await herramienta("oc_crear", { caso: "sol-006", payload: alterado, confirmado: true }, ctx)
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /no coincide/)
    assert.equal((await ordenes()).length, 0)
    assert.deepEqual((await control()).map((f) => f.resultado), ["rechazada"])
  })

  test("el payload devuelto por oc_construir_payload, sin modificar, sí se acepta", async () => {
    const ctx = ctxDe(db)
    const c = await herramienta("oc_construir_payload", { caso: "sol-006" }, ctx)
    const r = await herramienta("oc_crear", { caso: "sol-006", payload: c.data?.payload, confirmado: true }, ctx)
    assert.equal(r.ok, true, r.error ?? "")
  })

  test("un payload con otro proveedor se rechaza", async () => {
    const ctx = ctxDe(db)
    const c = await herramienta("oc_construir_payload", { caso: "sol-001" }, ctx)
    const alterado = structuredClone(c.data?.payload) as { proveedor: { codigo_sap: string; nit: string } }
    alterado.proveedor.codigo_sap = "100310"
    alterado.proveedor.nit = "901222333"
    const r = await herramienta("oc_crear", { caso: "sol-001", payload: alterado }, ctx)
    assert.equal(r.ok, false)
    assert.equal((await ordenes()).length, 0)
  })

  test("un paquete enviado con valor_total distinto al del caso se rechaza en validar y construir", async () => {
    const ctx = ctxDe(db)
    const p = await herramienta("oc_leer_paquete", { caso: "sol-003" }, ctx)
    assert.equal(p.ok, true)
    const alterado = structuredClone(p.data) as { solicitud: { valor_total: number; valor_unitario: number } }
    alterado.solicitud.valor_total = 25_000_000 // bajo el tope, para "pasar" RC3
    alterado.solicitud.valor_unitario = 625_000
    for (const nombre of ["oc_validar", "oc_construir_payload"]) {
      const r = await herramienta(nombre, { caso: "sol-003", paquete: alterado }, ctx)
      assert.equal(r.ok, false, nombre)
      assert.match(r.error ?? "", /valor_total/)
    }
  })

  test("argumentos con inyección de ruta se rechazan por esquema", async () => {
    const r = await herramienta("oc_leer_paquete", { caso: "../../.env" }, ctxDe(db))
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /argumentos inválidos/)
  })

  test("una herramienta desconocida devuelve error sin lanzar", async () => {
    const e = await ejecutarHerramienta("oc_borrar_todo", {}, ctxDe(db))
    assert.equal(e.ok, false)
    assert.match(e.resumen, /desconocida/)
  })
})

describe("otras herramientas", () => {
  test("oc_validar informa apta y pide confirmación en sol-004", async () => {
    const r = await herramienta("oc_validar", { caso: "sol-004" }, ctxDe(db))
    assert.equal(r.ok, true)
    assert.equal(r.data?.apta, true)
    assert.equal(r.data?.pide_confirmacion, true)
  })

  test("oc_generar_evidencia guarda contenido, sha256 y PDF en la tabla evidencias", async () => {
    const r = await herramienta("oc_generar_evidencia", { caso: "sol-001" }, ctxDe(db))
    assert.equal(r.ok, true)
    const [ev] = await filas<{ sha256: string; contenido: string; pdf: Uint8Array }>(db, "SELECT sha256, contenido, pdf FROM evidencias WHERE solicitud_id = 'SOL-2026-001'")
    assert.equal(ev.sha256, r.data?.sha256)
    assert.match(ev.contenido, /EVIDENCIA DE APROBACIÓN · SOL-2026-001/)
    assert.equal(Buffer.from(ev.pdf).subarray(0, 4).toString(), "%PDF")
    // Idempotente: regenerar no duplica.
    await herramienta("oc_generar_evidencia", { caso: "sol-001" }, ctxDe(db))
    assert.equal((await filas(db, "SELECT 1 FROM evidencias")).length, 1)
  })

  test("el sha256 de la evidencia coincide con el del payload de la OC creada", async () => {
    await herramienta("oc_crear", { caso: "sol-001" }, ctxDe(db))
    const [o] = await filas<{ orden: { aprobador: { evidencia_sha256: string } } }>(db, "SELECT orden FROM ordenes")
    const [ev] = await filas<{ sha256: string }>(db, "SELECT sha256 FROM evidencias")
    assert.equal(o.orden.aprobador.evidencia_sha256, ev.sha256)
  })

  test("un caso inexistente devuelve error claro", async () => {
    const r = await herramienta("oc_leer_paquete", { caso: "sol-999" }, ctxDe(db))
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /sol-999/)
  })
})

test("las herramientas no escriben estado en disco (ni out/ ni OUT_DIR)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "oc-out-"))
  const destino = path.join(tmp, "salida")
  const previo = process.env.OUT_DIR
  process.env.OUT_DIR = destino
  const outRaiz = path.join(RAIZ, "out")
  const existiaOut = existsSync(outRaiz)
  try {
    const ctx = ctxDe(db)
    for (const caso of ["sol-001", "sol-003", "sol-006"]) {
      await herramienta("oc_leer_paquete", { caso }, ctx)
      await herramienta("oc_validar", { caso }, ctx)
      await herramienta("oc_construir_payload", { caso }, ctx)
      await herramienta("oc_generar_evidencia", { caso }, ctx)
      await herramienta("oc_crear", { caso, confirmado: true }, ctx)
    }
    assert.equal(existsSync(destino), false, "no debe crearse OUT_DIR")
    if (!existiaOut) assert.equal(existsSync(outRaiz), false, "no debe crearse out/")
    assert.equal((await ordenes()).length, 2)
  } finally {
    if (previo === undefined) delete process.env.OUT_DIR
    else process.env.OUT_DIR = previo
    await rm(tmp, { recursive: true, force: true })
  }
})
