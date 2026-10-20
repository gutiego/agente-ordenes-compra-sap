// Evidencia de aprobación (HU-4): texto canónico + sha256 (P0) y PDF con el mismo contenido (P1).
import { createHash } from "node:crypto"
import path from "node:path"
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"
import { escribir } from "./comun.js"
import type { AprobacionCruda } from "./tipos.js"

/** Contenido canónico (determinista) del correo de aprobación. Su sha256 es el que viaja en el payload. */
export function contenidoEvidencia(solicitudId: string, a: AprobacionCruda): string {
  return [
    `EVIDENCIA DE APROBACIÓN · ${solicitudId}`,
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `CC: ${a.cc.join(", ") || "-"}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
  ].join("\n")
}

export const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex")

// Helvetica estándar usa WinAnsi: cubre tildes y ñ, no emojis.
const latin1 = (s: string) => s.replace(/[^\x20-\xFF]/g, "?")

function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of latin1(texto).split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  return [...lineas, actual]
}

async function generarPdf(archivo: string, contenido: string, hash: string): Promise<void> {
  const doc = await PDFDocument.create()
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const pagina = doc.addPage([595, 842])
  let y = 790
  const lineas = contenido.split("\n")
  lineas.forEach((l, i) => {
    const fuente = i === 0 ? negrita : normal
    for (const trozo of partir(l || " ", fuente, i === 0 ? 14 : 11, 495)) {
      pagina.drawText(trozo, { x: 50, y, size: i === 0 ? 14 : 11, font: fuente, color: rgb(0.1, 0.1, 0.1) })
      y -= i === 0 ? 24 : 16
    }
  })
  pagina.drawText(`sha256 del contenido: ${hash}`, { x: 50, y: y - 20, size: 8, font: normal, color: rgb(0.35, 0.35, 0.35) })
  await escribir(archivo, await doc.save())
}

export interface Evidencia {
  txt: string
  pdf: string
  sha256: string
}

/** Escribe aprobacion.txt (contenido + línea sha256) y aprobacion.pdf en el directorio del caso. Idempotente. */
export async function escribirEvidencia(dirCaso: string, solicitudId: string, a: AprobacionCruda): Promise<Evidencia> {
  const contenido = contenidoEvidencia(solicitudId, a)
  const hash = sha256(contenido)
  const txt = path.join(dirCaso, "aprobacion.txt")
  const pdf = path.join(dirCaso, "aprobacion.pdf")
  await escribir(txt, `${contenido}\n\n---\nsha256: ${hash}\n`)
  await generarPdf(pdf, contenido, hash)
  return { txt, pdf, sha256: hash }
}
