import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
let SQL = null;
export class Database {
    db;
    dbPath;
    saveTimer = null;
    dirty = false;
    constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
    }
    static async open(dbPath) {
        if (!SQL)
            SQL = await initSqlJs();
        const dir = dirname(dbPath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        let db;
        if (existsSync(dbPath)) {
            const buffer = readFileSync(dbPath);
            db = new SQL.Database(buffer);
        }
        else {
            db = new SQL.Database();
        }
        db.exec("PRAGMA journal_mode = WAL");
        return new Database(db, dbPath);
    }
    scheduleSave() {
        if (!this.dirty)
            return;
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 2000);
    }
    flush() {
        if (!this.dirty)
            return;
        try {
            const data = this.db.export();
            writeFileSync(this.dbPath, Buffer.from(data));
            this.dirty = false;
        }
        catch (err) {
            console.error("[db] flush error:", err);
        }
    }
    run(sql, params = []) {
        this.db.run(sql, params);
        this.dirty = true;
        this.scheduleSave();
        return { changes: this.db.getRowsModified() };
    }
    query(sql) {
        return {
            get: (...params) => {
                const stmt = this.db.prepare(sql);
                stmt.bind(params);
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    stmt.free();
                    return row;
                }
                stmt.free();
                return undefined;
            },
            all: (...params) => {
                const results = [];
                const stmt = this.db.prepare(sql);
                stmt.bind(params);
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                return results;
            },
        };
    }
    close() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.flush();
        this.db.close();
    }
}
//# sourceMappingURL=db.js.map