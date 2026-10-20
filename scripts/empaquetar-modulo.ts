// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md desde las fuentes que usa la app
// (agent/prompt.md y src/knowledge/ordenes-compra.md), para que nunca diverjan. Uso: npm run modulo
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (rel: string) => readFile(path.join(raiz, rel), "utf8")

const agente = `---
description: Prepara, valida (RC1–RC10) y crea órdenes de compra en SAP a partir del paquete de solicitud, cotización y aprobación.
mode: primary
permission:
  edit: deny
  bash: deny
---

${await leer("agent/prompt.md")}`

const skill = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra SAP de Periferia - maestros, controles RC1–RC10, estructura de la OC y OC retroactivas.
---

${await leer("src/knowledge/ordenes-compra.md")}`

await mkdir(path.join(raiz, "modulo", "skill", "ordenes-compra"), { recursive: true })
await writeFile(path.join(raiz, "modulo", "agent.md"), agente)
await writeFile(path.join(raiz, "modulo", "skill", "ordenes-compra", "SKILL.md"), skill)
console.log("modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md regenerados")
