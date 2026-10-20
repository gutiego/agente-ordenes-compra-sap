// Persistencia: con PGlite en un directorio temporal, las OC, el control, las evidencias y las sesiones
// sobreviven a cerrar y reabrir la base, y la numeración continúa donde quedó. Las migraciones no se repiten.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { AlmacenSesiones } from "../../src/agent/sesiones.js"
import { MIGRACIONES } from "../../src/db/esquema.js"
import { abrirDb } from "../../src/db/index.js"
import { ctxDe, filas, herramienta } from "../helpers/entorno.js"

let dir: string
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oc-pglite-"))
})
after(() => rm(dir, { recursive: true, force: true }))

test("la OC y el control siguen tras reabrir la base y la siguiente OC continúa la numeración", async () => {
  const db1 = await abrirDb({ dirPglite: dir })
  const creada = await herramienta("oc_crear", { caso: "sol-001" }, ctxDe(db1))
  assert.equal(creada.data?.numero_oc, "4500000001")
  await herramienta("oc_crear", { caso: "sol-002" }, ctxDe(db1)) // bloqueada
  const sesiones1 = new AlmacenSesiones(db1)
  const toma = await sesiones1.tomar("sesion-persistente-01", "ana")
  assert.equal(toma.estado, "ok")
  if (toma.estado === "ok") {
    toma.sesion.vista.push({ rol: "usuario", texto: "hola", ts: new Date().toISOString() })
    await sesiones1.soltar(toma.sesion)
  }
  await db1.cerrar()

  const db2 = await abrirDb({ dirPglite: dir })
  try {
    const os_ = await filas<{ numero_oc: string; solicitud_id: string }>(db2, "SELECT numero_oc, solicitud_id FROM ordenes")
    assert.deepEqual(os_, [{ numero_oc: "4500000001", solicitud_id: "SOL-2026-001" }])
    const ctl = await filas<{ solicitud_id: string; resultado: string }>(db2, "SELECT solicitud_id, resultado FROM control ORDER BY id")
    assert.deepEqual(ctl, [
      { solicitud_id: "SOL-2026-001", resultado: "creada" },
      { solicitud_id: "SOL-2026-002", resultado: "bloqueada" },
    ])
    assert.equal((await filas(db2, "SELECT 1 FROM evidencias WHERE solicitud_id = 'SOL-2026-001'")).length, 1)

    // Idempotencia tras reinicio y numeración consecutiva.
    const repetida = await herramienta("oc_crear", { caso: "sol-001" }, ctxDe(db2))
    assert.equal(repetida.data?.numero_oc, "4500000001")
    assert.equal(repetida.data?.idempotente, true)
    const siguiente = await herramienta("oc_crear", { caso: "sol-006", confirmado: true }, ctxDe(db2))
    assert.equal(siguiente.data?.numero_oc, "4500000002")

    const s = await new AlmacenSesiones(db2).buscar("sesion-persistente-01", "ana")
    assert.equal(s?.vista[0].texto, "hola")

    const migraciones = await filas<{ version: number }>(db2, "SELECT version FROM schema_migrations ORDER BY version")
    assert.deepEqual(migraciones.map((m) => m.version), MIGRACIONES.map((m) => m.version),"cada migración se aplica una sola vez")
  } finally {
    await db2.cerrar()
  }
})
