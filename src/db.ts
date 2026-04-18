import initSqlJs, { Database as SqlJsDatabase, type SqlValue } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export class Database {
  private db: SqlJsDatabase;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async open(dbPath: string): Promise<Database> {
    if (!SQL) SQL = await initSqlJs();

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let db: SqlJsDatabase;
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
    db.exec("PRAGMA journal_mode = WAL");
    return new Database(db, dbPath);
  }

  private scheduleSave(): void {
    if (!this.dirty) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
    } catch (err) {
      console.error("[db] flush error:", err);
    }
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    this.db.run(sql, params as SqlValue[]);
    this.dirty = true;
    this.scheduleSave();
    return { changes: this.db.getRowsModified() };
  }

  query(sql: string): { get: (...params: unknown[]) => Record<string, unknown> | undefined; all: (...params: unknown[]) => Record<string, unknown>[] } {
    return {
      get: (...params: unknown[]): Record<string, unknown> | undefined => {
        const stmt = this.db.prepare(sql);
        stmt.bind(params as SqlValue[]);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all: (...params: unknown[]): Record<string, unknown>[] => {
        const results: Record<string, unknown>[] = [];
        const stmt = this.db.prepare(sql);
        stmt.bind(params as SqlValue[]);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
    };
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flush();
    this.db.close();
  }
}