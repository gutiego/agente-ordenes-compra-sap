// Ejecuta las herramientas sobre los 6 casos, sin modelo de lenguaje (PRD 6.6).
// Uso: npm run demo   (o: npx tsx demo.ts)
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarHerramienta } from "./src/tools/registro.js"
import type { CtxHerramienta } from "./src/tools/comun.js"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx: CtxHerramienta = { directory, sessionId: "demo" }

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

async function procesar(caso: string): Promise<void> {
  console.log(`\n━━━ ${caso} ━━━`)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok) return
  const v = await llamar("oc_validar", { caso })
  imprimirValidacion(v.data)
  if (!v.data?.apta) {
    await llamar("oc_crear", { caso })
    return
  }
  const c = await llamar("oc_construir_payload", { caso })
  await llamar("oc_generar_evidencia", { caso })
  const r = await llamar("oc_crear", { caso, payload: c.data?.payload, confirmado: false })
  console.log(`  · resultado: ${r.ok ? `OC ${r.data?.numero_oc}` : `sin OC — ${r.error}`}`)
}

async function confirmar(caso: string): Promise<void> {
  console.log(`\n━━━ Confirmación explícita del usuario: ${caso} ━━━`)
  const c = await llamar("oc_construir_payload", { caso })
  for (const h of (c.data?.confirmaciones ?? [])) console.log(`  · el usuario confirma ${h.codigo}: ${h.detalle}`)
  const r = await llamar("oc_crear", { caso, payload: c.data?.payload, confirmado: true })
  console.log(`  · resultado: ${r.ok ? `OC ${r.data?.numero_oc}` : r.error}`)
}

async function main(): Promise<void> {
  await rm(path.join(directory, process.env.OUT_DIR ?? "out"), { recursive: true, force: true })
  const casos = (await readdir(path.join(directory, "fixtures", "reto-03", "solicitudes"))).sort()
  for (const caso of casos) await procesar(caso)

  console.log("\n━━━ Idempotencia: sol-001 por segunda vez ━━━")
  const r = await llamar("oc_crear", { caso: "sol-001" })
  console.log(`  · numero_oc: ${r.data?.numero_oc}   idempotente: ${r.data?.idempotente}`)

  await confirmar("sol-004")
  await confirmar("sol-005")

  console.log("\n━━━ CA2: payload alterado por el modelo (precio de sol-006 'ajustado') ━━━")
  const c = await llamar("oc_construir_payload", { caso: "sol-006" })
  const alterado = JSON.parse(JSON.stringify(c.data?.payload)) as { posiciones: { precio_unitario: number }[] }
  alterado.posiciones[0].precio_unitario = 175000
  await llamar("oc_crear", { caso: "sol-006", payload: alterado, confirmado: true })

  console.log("\n━━━ Manejo de errores ━━━")
  await llamar("oc_leer_paquete", { caso: "sol-999" })
  await llamar("oc_leer_paquete", { caso: "../secreto" })

  console.log("\n━━━ out/control.csv ━━━")
  console.log(await readFile(path.join(directory, process.env.OUT_DIR ?? "out", "control.csv"), "utf8"))
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e)
  process.exit(1)
})
