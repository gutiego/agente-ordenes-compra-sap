// Ejecuta las herramientas sobre los 6 casos, sin modelo de lenguaje (PRD 6.6), sobre PGlite en memoria.
// Termina con código ≠ 0 si algún resultado esperado no se cumple. Uso: npm run demo   (o: npx tsx demo.ts)
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { abrirDb, type Db } from "./src/db/index.js"
import { ejecutarHerramienta } from "./src/tools/registro.js"
import type { CtxHerramienta } from "./src/tools/comun.js"

const directory = path.dirname(fileURLToPath(import.meta.url))
const nuevoCtx = (db: Db, sessionId = "demo"): CtxHerramienta => ({ directory, sessionId, db, usuario: "demo" })
let ctx: CtxHerramienta

interface Hallazgo {
  codigo: string
  detalle: string
  accion_sugerida?: string
}
interface Salida {
  ok: boolean
  error?: string
  confirmaciones?: Hallazgo[]
  data?: {
    apta?: boolean
    bloqueos?: Hallazgo[]
    confirmaciones?: Hallazgo[]
    retroactiva?: boolean
    derivados?: Record<string, { valor: string; fuente: string }>
    payload?: unknown
    numero_oc?: string
    idempotente?: boolean
  }
}

const fallas: string[] = []
/** Comprobación de la demo: si no se cumple se anota, y al final la demo sale con código 1. */
function esperar(condicion: boolean, mensaje: string): void {
  if (condicion) return
  fallas.push(mensaje)
  console.log(`  ‼ INESPERADO: ${mensaje}`)
}

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Salida> {
  const e = await ejecutarHerramienta(nombre, args, ctx)
  console.log(`  ${e.ok ? "✔" : "✖"} ${nombre.padEnd(22)} ${e.resumen}`)
  return JSON.parse(e.salida) as Salida
}

function imprimirValidacion(v: Salida["data"]): void {
  console.log(`  · apta: ${v?.apta}   retroactiva: ${v?.retroactiva}`)
  for (const b of v?.bloqueos ?? []) console.log(`  · BLOQUEO ${b.codigo}: ${b.detalle}\n      → acción: ${b.accion_sugerida ?? "-"}`)
  for (const c of v?.confirmaciones ?? []) console.log(`  · CONFIRMAR ${c.codigo}: ${c.detalle}`)
  for (const [k, d] of Object.entries(v?.derivados ?? {})) console.log(`  · derivado ${k} = ${d.valor} (${d.fuente})`)
}

async function procesar(caso: string): Promise<Salida | null> {
  console.log(`\n━━━ ${caso} ━━━`)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok) return null
  const v = await llamar("oc_validar", { caso })
  imprimirValidacion(v.data)
  if (!v.data?.apta) return await llamar("oc_crear", { caso })
  const c = await llamar("oc_construir_payload", { caso })
  await llamar("oc_generar_evidencia", { caso })
  const r = await llamar("oc_crear", { caso, payload: c.data?.payload, confirmado: false })
  console.log(`  · resultado: ${r.ok ? `OC ${r.data?.numero_oc}` : `sin OC — ${r.error}`}`)
  return r
}

async function confirmar(caso: string): Promise<Salida> {
  console.log(`\n━━━ Confirmación explícita del usuario: ${caso} ━━━`)
  const c = await llamar("oc_construir_payload", { caso })
  for (const h of c.data?.confirmaciones ?? []) console.log(`  · el usuario confirma ${h.codigo}: ${h.detalle}`)
  const r = await llamar("oc_crear", { caso, payload: c.data?.payload, confirmado: true })
  console.log(`  · resultado: ${r.ok ? `OC ${r.data?.numero_oc}` : r.error}`)
  return r
}

/** 10 oc_crear simultáneos sobre la misma solicitud en una base nueva: debe quedar una sola OC. */
async function concurrencia(): Promise<void> {
  console.log("\n━━━ Concurrencia: 10 oc_crear simultáneos sobre sol-001 en una base nueva → 1 sola OC ━━━")
  const db = await abrirDb()
  try {
    const salidas = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ejecutarHerramienta("oc_crear", { caso: "sol-001" }, nuevoCtx(db, `concurrente-${i}`))),
    )
    const datos = salidas.map((e) => JSON.parse(e.salida) as Salida)
    const numeros = new Set(datos.map((d) => d.data?.numero_oc))
    const creadas = datos.filter((d) => d.ok && d.data?.idempotente === false).length
    const idempotentes = datos.filter((d) => d.ok && d.data?.idempotente === true).length
    const filas = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ordenes")).rows[0]?.n
    console.log(`  · respuestas ok: ${datos.filter((d) => d.ok).length}/10   creadas: ${creadas}   idempotentes: ${idempotentes}`)
    console.log(`  · números devueltos: ${[...numeros].join(", ")}   filas en ordenes: ${filas}`)
    esperar(datos.every((d) => d.ok), "todas las llamadas concurrentes deben responder ok")
    esperar(creadas === 1 && numeros.size === 1 && filas === 1, "debe existir exactamente 1 OC y todas las respuestas deben traer su número")
  } finally {
    await db.cerrar()
  }
}

async function main(): Promise<void> {
  const db = await abrirDb()
  ctx = nuevoCtx(db)
  const casos = (await readdir(path.join(directory, "fixtures", "reto-03", "solicitudes"))).sort()
  const resultados = new Map<string, Salida | null>()
  for (const caso of casos) resultados.set(caso, await procesar(caso))
  esperar(resultados.get("sol-001")?.data?.numero_oc === "4500000001", "sol-001 debe crear la OC 4500000001")

  console.log("\n━━━ Idempotencia: sol-001 por segunda vez ━━━")
  const r = await llamar("oc_crear", { caso: "sol-001" })
  console.log(`  · numero_oc: ${r.data?.numero_oc}   idempotente: ${r.data?.idempotente}`)
  esperar(r.ok && r.data?.idempotente === true && r.data?.numero_oc === "4500000001", "la segunda creación de sol-001 debe devolver la misma OC")

  for (const caso of ["sol-004", "sol-005"]) {
    const c = await confirmar(caso)
    esperar(c.ok && c.data?.idempotente === false && Boolean(c.data?.numero_oc), `${caso} debe crear la OC tras confirmar`)
  }

  console.log("\n━━━ CA2: payload alterado por el modelo (precio de sol-006 'ajustado') ━━━")
  const c = await llamar("oc_construir_payload", { caso: "sol-006" })
  const alterado = JSON.parse(JSON.stringify(c.data?.payload)) as { posiciones: { precio_unitario: number }[] }
  alterado.posiciones[0].precio_unitario = 175000
  const ca2 = await llamar("oc_crear", { caso: "sol-006", payload: alterado, confirmado: true })
  esperar(!ca2.ok, "CA2: el payload alterado debe rechazarse")

  console.log("\n━━━ Manejo de errores ━━━")
  esperar(!(await llamar("oc_leer_paquete", { caso: "sol-999" })).ok, "un caso inexistente debe fallar")
  esperar(!(await llamar("oc_leer_paquete", { caso: "../secreto" })).ok, "una ruta fuera de fixtures debe rechazarse")

  console.log("\n━━━ Tabla control ━━━")
  const filas = await db.query<{ solicitud_id: string; resultado: string; numero_oc: string | null; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[]; usuario: string }>(
    "SELECT solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, usuario FROM control ORDER BY id",
  )
  console.table(filas.rows.map((f) => ({ ...f, bloqueos: f.bloqueos.join("|"), confirmaciones: f.confirmaciones.join("|") })))
  await db.cerrar()

  await concurrencia()

  if (fallas.length) throw new Error(`${fallas.length} resultado(s) inesperado(s):\n- ${fallas.join("\n- ")}`)
  console.log("\nDemo completa: todos los resultados esperados se cumplieron.")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e)
  process.exit(1)
})
