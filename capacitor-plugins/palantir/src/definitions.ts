import type { PluginListenerHandle } from '@capacitor/core'

export interface PalantirStatus {
  /** Whether moria.db exists and is a valid SQLite database */
  installed: boolean
  /** version_addon column from the version table (e.g. "3.3.11") */
  version: string
  /** ISO date of the last applied update (commits API committer date) */
  lastUpdate: string
  sizeBytes: number
}

export interface PalantirQueryResult {
  columns: string[]
  /** Rows as arrays aligned with `columns` */
  rows: any[][]
}

export interface PalantirPlugin {
  /** Status of the local moria.db catalog database */
  getStatus(): Promise<PalantirStatus>
  /**
   * Downloads a .zm3 archive (zip missing its local file header), restores the
   * header and extracts `settings.xml` as the SQLite database.
   * Emits 'palantirProgress' ({phase:'download'|'extract', received, total, percent}).
   */
  install(options: { url: string }): Promise<{ ok: boolean; version: string }>
  /**
   * Runs a read-only query. Only SELECT statements are allowed.
   * `args` are bound positionally to `?` placeholders.
   * Returns at most 2000 rows.
   */
  query(options: { sql: string; args?: Array<string | number> }): Promise<PalantirQueryResult>
  /**
   * Executes a multi-statement SQL script (used for `.up` incremental updates)
   * inside a transaction.
   */
  execScript(options: { sql: string }): Promise<{ ok: boolean }>
  /**
   * Decrypts catalog links (AES-OFB, fixed key embedded in the addon).
   * Returns the cleartext URLs in the same order.
   */
  decryptLinks(options: { links: string[] }): Promise<{ urls: string[] }>
  /** Persists the date of the last applied update (PalCO equivalent). */
  setLastUpdate(options: { date: string }): Promise<void>
  addListener(
    eventName: 'palantirProgress',
    listener: (data: { phase: string; received: number; total: number; percent: number }) => void
  ): Promise<PluginListenerHandle>
}
