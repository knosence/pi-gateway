import { Database } from "../db.js";
import { join } from "path";
import { homedir } from "os";

export type ResetPolicy = "daily" | "idle" | "both";

export interface SessionConfig {
  id: string;
  platform: string;
  channelId: string;
  userId: string;
  resetPolicy: ResetPolicy;
  dailyHour: number;
  idleMinutes: number;
  lastActivity: number;
  createdAt: number;
  isBackground: boolean;
  parentSessionId?: string;
}

interface SessionRow {
  id: string;
  platform: string;
  channel_id: string;
  user_id: string;
  reset_policy: string;
  daily_hour: number;
  idle_minutes: number;
  last_activity: number;
  created_at: number;
  is_background: number;
  parent_session_id: string | null;
}

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const SESSIONS_DB = join(KOBOLD_DIR, "gateway-sessions.db");

let db: Database | null = null;

export async function initSessionStore(): Promise<Database> {
  if (db) return db;

  db = await Database.open(SESSIONS_DB);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reset_policy TEXT NOT NULL DEFAULT 'idle',
      daily_hour INTEGER NOT NULL DEFAULT 4,
      idle_minutes INTEGER NOT NULL DEFAULT 1440,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      is_background INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_platform_channel ON sessions(platform, channel_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity)`);

  console.log("[SessionStore] Database initialized");
  return db;
}

export function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function getOrCreateSession(
  platform: string,
  channelId: string,
  userId: string,
  config?: Partial<SessionConfig>
): Promise<SessionConfig> {
  const database = await initSessionStore();

  const existing = database.query(`
    SELECT * FROM sessions
    WHERE platform = ? AND channel_id = ? AND is_background = 0
    ORDER BY last_activity DESC
    LIMIT 1
  `).get(platform, channelId) as unknown as SessionRow | undefined;

  if (existing) {
    if (shouldResetSession(existing)) {
      database.run("DELETE FROM sessions WHERE id = ?", [existing.id]);
    } else {
      database.run(
        "UPDATE sessions SET last_activity = ? WHERE id = ?",
        [Date.now(), existing.id]
      );
      return rowToSession(existing);
    }
  }

  const id = generateSessionId();
  const now = Date.now();

  const session: SessionConfig = {
    id,
    platform,
    channelId,
    userId,
    resetPolicy: config?.resetPolicy ?? "idle",
    dailyHour: config?.dailyHour ?? 4,
    idleMinutes: config?.idleMinutes ?? 1440,
    lastActivity: now,
    createdAt: now,
    isBackground: false,
    ...config,
  };

  database.run(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    session.id,
    session.platform,
    session.channelId,
    session.userId,
    session.resetPolicy,
    session.dailyHour,
    session.idleMinutes,
    session.lastActivity,
    session.createdAt,
    session.isBackground ? 1 : 0,
    session.parentSessionId ?? null,
  ]);

  console.log(`[SessionStore] Created session ${id.slice(0, 12)}... for ${platform}/${channelId}`);
  return session;
}

export async function createBackgroundSession(
  platform: string,
  channelId: string,
  userId: string,
  parentSessionId?: string
): Promise<SessionConfig> {
  const database = await initSessionStore();

  const id = generateSessionId();
  const now = Date.now();

  const session: SessionConfig = {
    id,
    platform,
    channelId,
    userId,
    resetPolicy: "idle",
    dailyHour: 4,
    idleMinutes: 1440,
    lastActivity: now,
    createdAt: now,
    isBackground: true,
    parentSessionId,
  };

  database.run(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    session.id,
    session.platform,
    session.channelId,
    session.userId,
    session.resetPolicy,
    session.dailyHour,
    session.idleMinutes,
    session.lastActivity,
    session.createdAt,
    1,
    session.parentSessionId ?? null,
  ]);

  console.log(`[SessionStore] Created background session ${id.slice(0, 12)}...`);
  return session;
}

function shouldResetSession(row: SessionRow): boolean {
  const now = Date.now();

  const idleMs = row.idle_minutes * 60 * 1000;
  if (now - row.last_activity > idleMs) {
    console.log(`[SessionStore] Session ${row.id.slice(0, 8)} reset: idle timeout`);
    return true;
  }

  if (row.reset_policy === "daily" || row.reset_policy === "both") {
    const lastActivity = new Date(row.last_activity);
    const nowDate = new Date(now);

    if (lastActivity.getHours() < row.daily_hour && nowDate.getHours() >= row.daily_hour) {
      console.log(`[SessionStore] Session ${row.id.slice(0, 8)} reset: daily at ${row.daily_hour}:00`);
      return true;
    }
  }

  return false;
}

export async function touchSession(sessionId: string): Promise<void> {
  const database = await initSessionStore();
  database.run("UPDATE sessions SET last_activity = ? WHERE id = ?", [Date.now(), sessionId]);
}

export async function getSession(sessionId: string): Promise<SessionConfig | null> {
  const database = await initSessionStore();
  const row = database.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as unknown as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const database = await initSessionStore();
  database.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export async function listSessions(platform?: string): Promise<SessionConfig[]> {
  const database = await initSessionStore();
  const query = platform
    ? "SELECT * FROM sessions WHERE platform = ? AND is_background = 0 ORDER BY last_activity DESC"
    : "SELECT * FROM sessions WHERE is_background = 0 ORDER BY last_activity DESC";

  const rows = platform
    ? database.query(query).all(platform) as unknown as SessionRow[]
    : database.query(query).all() as unknown as SessionRow[];

  return rows.map(rowToSession);
}

export async function cleanupStaleSessions(): Promise<number> {
  const database = await initSessionStore();
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const result = database.run("DELETE FROM sessions WHERE last_activity < ?", [cutoff]);
  return result.changes;
}

export async function getPendingBackgroundResults(): Promise<SessionConfig[]> {
  const database = await initSessionStore();
  const rows = database.query(`
    SELECT s.* FROM sessions s
    WHERE s.is_background = 1
    ORDER BY s.created_at ASC
  `).all() as unknown as SessionRow[];

  return rows.map(rowToSession);
}

function rowToSession(row: SessionRow): SessionConfig {
  return {
    id: row.id,
    platform: row.platform,
    channelId: row.channel_id,
    userId: row.user_id,
    resetPolicy: row.reset_policy as ResetPolicy,
    dailyHour: row.daily_hour,
    idleMinutes: row.idle_minutes,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    isBackground: row.is_background === 1,
    parentSessionId: row.parent_session_id ?? undefined,
  };
}