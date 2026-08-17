/**
 * Minimal declaration for the optional `pg` driver.
 *
 * `pg` is deliberately NOT a dependency — see `client.ts`: it is imported
 * lazily, and a run that never executes a DB step must never demand it. That
 * also means `@types/pg` is not installed, so the few members `client.ts`
 * actually calls are declared here. If a real `@types/pg` ever lands in
 * devDependencies, delete this file.
 */
declare module 'pg' {
  export interface PgQueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
    end(): Promise<void>;
  }
}
