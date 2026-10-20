// Acceso a datos. Un solo dialecto SQL (Postgres) con dos motores:
// - `pg` (Pool) cuando hay DATABASE_URL → producción en Neon.
// - PGlite (Postgres compilado a WASM, en proceso) cuando no hay → demo, tests y CI, sin servicios externos.
import { PGlite } from "@electric-sql/pglite"
import pg from "pg"
import { migrar } from "./esquema.js"

export interface Filas<T> {
  rows: T[]
}

/** Interfaz mínima que usa el resto del código. No se filtra ningún tipo del driver. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Filas<T>>
  /** Ejecuta varias sentencias sin parámetros (migraciones). */
  exec(sql: string): Promise<void>
  /** Ejecuta `fn` en una transacción: COMMIT si resuelve, ROLLBACK si lanza. */
  transaccion<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  cerrar(): Promise<void>
  readonly motor: "postgres" | "pglite"
}

export interface OpcionesDb {
  /** Cadena de conexión Postgres. Si falta se usa PGlite. */
  url?: string
  /** Directorio de datos de PGlite. Sin él, PGlite vive en memoria (se pierde al cerrar). */
  dirPglite?: string
}

class DbPostgres implements Db {
  readonly motor = "postgres" as const
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<Filas<T>> {
    const r = await this.pool.query(sql, params)
    return { rows: r.rows as T[] }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async transaccion<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect()
    const tx: Db = {
      motor: this.motor,
      query: async <R>(sql: string, params: unknown[] = []) => ({ rows: (await cliente.query(sql, params)).rows as R[] }),
      exec: async (sql) => void (await cliente.query(sql)),
      transaccion: (f) => f(tx), // anidada: reutiliza la misma transacción
      cerrar: async () => {},
    }
    try {
      await cliente.query("BEGIN")
      const r = await fn(tx)
      await cliente.query("COMMIT")
      return r
    } catch (e) {
      await cliente.query("ROLLBACK").catch(() => {})
      throw e
    } finally {
      cliente.release()
    }
  }

  cerrar(): Promise<void> {
    return this.pool.end()
  }
}

class DbPglite implements Db {
  readonly motor = "pglite" as const
  constructor(private readonly pg: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<Filas<T>> {
    const r = await this.pg.query<T>(sql, params)
    return { rows: r.rows }
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql)
  }

  transaccion<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // PGlite es de una sola conexión: su transaction() ya serializa.
    return this.pg.transaction(async (t) => {
      const tx: Db = {
        motor: this.motor,
        query: async <R>(sql: string, params: unknown[] = []) => ({ rows: (await t.query<R>(sql, params)).rows }),
        exec: async (sql) => void (await t.exec(sql)),
        transaccion: (f) => f(tx),
        cerrar: async () => {},
      }
      return fn(tx)
    })
  }

  cerrar(): Promise<void> {
    return this.pg.close()
  }
}

/** Abre la base y aplica las migraciones pendientes. */
export async function abrirDb(op: OpcionesDb = {}): Promise<Db> {
  let db: Db
  if (op.url) {
    // verify-full: valida el certificado del servidor (Neon usa certificados públicos).
    const url = new URL(op.url)
    url.searchParams.set("sslmode", "verify-full")
    db = new DbPostgres(new pg.Pool({ connectionString: url.toString(), max: 10, idleTimeoutMillis: 30_000 }))
  } else {
    db = new DbPglite(new PGlite(op.dirPglite))
  }
  await migrar(db)
  return db
}
