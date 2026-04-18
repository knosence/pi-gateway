export declare class Database {
    private db;
    private dbPath;
    private saveTimer;
    private dirty;
    private constructor();
    static open(dbPath: string): Promise<Database>;
    private scheduleSave;
    flush(): void;
    run(sql: string, params?: unknown[]): {
        changes: number;
    };
    query(sql: string): {
        get: (...params: unknown[]) => Record<string, unknown> | undefined;
        all: (...params: unknown[]) => Record<string, unknown>[];
    };
    close(): void;
}
