import { Database } from "../db.js";
import { join } from "path";
import { homedir } from "os";
import { spawn, type ChildProcess } from "node:child_process";
import { createBackgroundSession, type SessionConfig } from "../sessions/store.js";
import { randomBytes } from "node:crypto";

export type BackgroundStatus = "running" | "completed" | "failed" | "timeout" | "delivered";

export interface BackgroundTask {
  id: string;
  sessionId: string;
  parentSessionId: string;
  command: string;
  status: BackgroundStatus;
  progress: number;
  progressMessage?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  deliveredAt?: number;
}

interface TaskRow {
  id: string;
  session_id: string;
  parent_session_id: string;
  command: string;
  status: string;
  progress: number;
  progress_message: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  delivered_at: number | null;
}

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const TASKS_DB = join(KOBOLD_DIR, "gateway-background-tasks.db");

let db: Database | null = null;
const runningProcesses: Map<string, ChildProcess> = new Map();
const progressCallbacks: Map<string, (task: BackgroundTask) => void> = new Map();

export async function initBackgroundTasks(): Promise<Database> {
  if (db) return db;

  db = await Database.open(TASKS_DB);

  db.run(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      progress INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      delivered_at INTEGER
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON background_tasks(parent_session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON background_tasks(status)`);

  console.log("[BackgroundTasks] Database initialized");
  return db;
}

export async function startBackgroundTask(
  parentSessionId: string,
  command: string,
  onProgress?: (task: BackgroundTask) => void
): Promise<BackgroundTask> {
  const database = await initBackgroundTasks();

  const id = `bg-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const now = Date.now();

  const session = await createBackgroundSession("background", id, "system", parentSessionId);

  const task: BackgroundTask = {
    id,
    sessionId: session.id,
    parentSessionId,
    command,
    status: "running",
    progress: 0,
    createdAt: now,
  };

  database.run(`
    INSERT INTO background_tasks
    (id, session_id, parent_session_id, command, status, progress, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, session.id, parentSessionId, command, "running", 0, now]);

  if (onProgress) {
    progressCallbacks.set(id, onProgress);
  }

  const proc = spawn("pi", ["--mode", "json", "--no-extensions", "--offline", "-p", command], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  runningProcesses.set(id, proc);

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();

    try {
      const lines = stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.progress !== undefined) {
          updateTaskProgress(id, parsed.progress, parsed.message);
        }
      }
    } catch {
      // Not JSON yet
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  proc.on("close", (code) => {
    runningProcesses.delete(id);

    if (code === 0) {
      try {
        const result = stdout.trim() ? JSON.parse(stdout) : { success: true };
        completeTask(id, result);
      } catch {
        completeTask(id, { success: true, output: stdout });
      }
    } else {
      failTask(id, stderr || `Process exited with code ${code}`);
    }
  });

  proc.on("error", (err) => {
    runningProcesses.delete(id);
    failTask(id, err.message);
  });

  console.log(`[BackgroundTasks] Started task ${id.slice(0, 12)}...`);
  return task;
}

export async function updateTaskProgress(taskId: string, progress: number, message?: string): Promise<void> {
  const database = await initBackgroundTasks();

  database.run(`
    UPDATE background_tasks SET progress = ?, progress_message = ?
    WHERE id = ?
  `, [progress, message ?? null, taskId]);

  const callback = progressCallbacks.get(taskId);
  if (callback) {
    const task = await getTask(taskId);
    if (task) callback(task);
  }
}

export async function completeTask(taskId: string, result: unknown): Promise<void> {
  const database = await initBackgroundTasks();
  const now = Date.now();

  database.run(`
    UPDATE background_tasks
    SET status = 'completed', progress = 100, result = ?, completed_at = ?
    WHERE id = ?
  `, [JSON.stringify(result), now, taskId]);

  console.log(`[BackgroundTasks] Task ${taskId.slice(0, 12)}... completed`);
}

export async function failTask(taskId: string, error: string): Promise<void> {
  const database = await initBackgroundTasks();
  const now = Date.now();

  database.run(`
    UPDATE background_tasks
    SET status = 'failed', error = ?, completed_at = ?
    WHERE id = ?
  `, [error, now, taskId]);

  console.log(`[BackgroundTasks] Task ${taskId.slice(0, 12)}... failed: ${error}`);
}

export async function markTaskDelivered(taskId: string): Promise<void> {
  const database = await initBackgroundTasks();
  database.run(`
    UPDATE background_tasks SET status = 'delivered', delivered_at = ?
    WHERE id = ?
  `, [Date.now(), taskId]);
}

export async function getTask(taskId: string): Promise<BackgroundTask | null> {
  const database = await initBackgroundTasks();
  const row = database.query("SELECT * FROM background_tasks WHERE id = ?").get(taskId) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export async function getPendingResultsForSession(parentSessionId: string): Promise<BackgroundTask[]> {
  const database = await initBackgroundTasks();

  const rows = database.query(`
    SELECT * FROM background_tasks
    WHERE parent_session_id = ? AND status IN ('completed', 'failed')
    AND delivered_at IS NULL
    ORDER BY created_at ASC
  `).all(parentSessionId) as unknown as TaskRow[];

  return rows.map(rowToTask);
}

export async function listTasks(status?: BackgroundStatus): Promise<BackgroundTask[]> {
  const database = await initBackgroundTasks();

  const query = status
    ? "SELECT * FROM background_tasks WHERE status = ? ORDER BY created_at DESC"
    : "SELECT * FROM background_tasks ORDER BY created_at DESC";

  const rows = status
    ? database.query(query).all(status) as unknown as TaskRow[]
    : database.query(query).all() as unknown as TaskRow[];

  return rows.map(rowToTask);
}

export async function cancelTask(taskId: string): Promise<boolean> {
  const proc = runningProcesses.get(taskId);
  if (proc) {
    proc.kill("SIGTERM");
    runningProcesses.delete(taskId);

    const database = await initBackgroundTasks();
    database.run(`
      UPDATE background_tasks SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `, ["Cancelled by user", Date.now(), taskId]);

    return true;
  }
  return false;
}

export async function cleanupOldTasks(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const database = await initBackgroundTasks();
  const cutoff = Date.now() - maxAgeMs;
  const result = database.run("DELETE FROM background_tasks WHERE created_at < ?", [cutoff]);
  return result.changes;
}

function rowToTask(row: TaskRow): BackgroundTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    command: row.command,
    status: row.status as BackgroundStatus,
    progress: row.progress,
    progressMessage: row.progress_message ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
  };
}