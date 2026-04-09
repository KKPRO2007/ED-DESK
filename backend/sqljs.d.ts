declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    run(values?: unknown[]): void
    free(): void
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
    prepare(sql: string, params?: unknown[]): Statement
    export(): Uint8Array
  }

  export interface SqlJsStatic {
    Database: {
      new (data?: Uint8Array | ArrayLike<number>): Database
    }
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}
