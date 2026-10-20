// Migraciones versionadas. Cada una se aplica una sola vez y queda anotada en schema_migrations.
// Para cambiar el esquema se AGREGA una migración nueva; nunca se edita una ya aplicada.
import type { Db } from "./index.js"

export const MIGRACIONES: { version: number; nombre: string; sql: string }[] = [
  {
    version: 1,
    nombre: "esquema inicial",
    sql: `
      -- Numeración de OC tipo SAP. La SEQUENCE es atómica: dos creaciones simultáneas nunca reciben el mismo número.
      CREATE SEQUENCE IF NOT EXISTS seq_numero_oc START WITH 4500000001;

      -- SAP simulado. UNIQUE(solicitud_id) es la garantía de idempotencia: una solicitud = una OC, aunque lleguen reintentos en paralelo.
      CREATE TABLE IF NOT EXISTS ordenes (
        numero_oc     TEXT PRIMARY KEY DEFAULT nextval('seq_numero_oc')::text,
        solicitud_id  TEXT NOT NULL UNIQUE,
        orden         JSONB NOT NULL,
        creada_por    TEXT NOT NULL,
        creada_en     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Log de control para contabilidad/auditoría (HU-5): una fila por intento, solo inserciones.
      CREATE TABLE IF NOT EXISTS control (
        id             BIGSERIAL PRIMARY KEY,
        solicitud_id   TEXT NOT NULL,
        resultado      TEXT NOT NULL,
        numero_oc      TEXT,
        retroactiva    BOOLEAN NOT NULL,
        bloqueos       TEXT[] NOT NULL DEFAULT '{}',
        confirmaciones TEXT[] NOT NULL DEFAULT '{}',
        usuario        TEXT NOT NULL,
        ts             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS control_solicitud ON control (solicitud_id);

      -- Evidencia de aprobación (HU-4): contenido canónico y su sha256.
      CREATE TABLE IF NOT EXISTS evidencias (
        solicitud_id TEXT PRIMARY KEY,
        contenido    TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        pdf          BYTEA,
        creada_en    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Conversaciones del chat. El historial completo va en JSONB.
      CREATE TABLE IF NOT EXISTS sesiones (
        id             TEXT PRIMARY KEY,
        usuario        TEXT NOT NULL,
        datos          JSONB NOT NULL,
        -- Lease de procesamiento: evita dos turnos simultáneos de la misma sesión, también entre instancias.
        ocupada_hasta  TIMESTAMPTZ,
        actualizada_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Trazas de cada llamada a herramienta (RN5).
      CREATE TABLE IF NOT EXISTS log_herramientas (
        id          BIGSERIAL PRIMARY KEY,
        sesion      TEXT NOT NULL,
        usuario     TEXT,
        herramienta TEXT NOT NULL,
        caso        TEXT,
        ok          BOOLEAN NOT NULL,
        resumen     TEXT NOT NULL,
        ts          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
]

/** Aplica las migraciones pendientes en orden, cada una en su transacción. */
export async function migrar(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, nombre TEXT NOT NULL, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())`)
  // Lock global: si dos instancias arrancan a la vez, solo una migra.
  await db.transaccion(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(4500)")
    const hechas = new Set((await tx.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version))
    for (const m of MIGRACIONES) {
      if (hechas.has(m.version)) continue
      await tx.exec(m.sql)
      await tx.query("INSERT INTO schema_migrations (version, nombre) VALUES ($1, $2)", [m.version, m.nombre])
    }
  })
}
