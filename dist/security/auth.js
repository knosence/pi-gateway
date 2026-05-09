import { Database } from "../db.js";
import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "node:crypto";
const KOBOLD_DIR = join(homedir(), ".0xkobold");
const SECURITY_DB = join(KOBOLD_DIR, "gateway-security.db");
let db = null;
export async function initSecurityStore() {
    if (db)
        return db;
    db = await Database.open(SECURITY_DB);
    db.run(`
    CREATE TABLE IF NOT EXISTS allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      note TEXT
    )
  `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_allowlist ON allowlist(platform, user_id)`);
    db.run(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at)`);
    db.run(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      identifier TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start INTEGER NOT NULL
    )
  `);
    console.log("[Security] Database initialized");
    return db;
}
export async function generatePairingCode(platform, userId) {
    const database = await initSecurityStore();
    const code = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase();
    const now = Date.now();
    const expiresAt = now + (60 * 60 * 1000);
    database.run(`
    INSERT INTO pairing_codes (code, platform, user_id, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, 0)
  `, [code, platform, userId, now, expiresAt]);
    console.log(`[Security] Generated pairing code ${code} for ${platform}/${userId}`);
    return code;
}
export async function approvePairingCode(code) {
    const database = await initSecurityStore();
    const entry = database.query(`
    SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?
  `).get(code, Date.now());
    if (!entry) {
        console.log(`[Security] Pairing code ${code} not found or expired`);
        return false;
    }
    database.run(`
    INSERT OR IGNORE INTO allowlist (platform, user_id, added_at)
    VALUES (?, ?, ?)
  `, [entry.platform, entry.userId, Date.now()]);
    database.run("UPDATE pairing_codes SET used = 1 WHERE code = ?", [code]);
    console.log(`[Security] Approved pairing: ${entry.platform}/${entry.userId}`);
    return true;
}
export async function listPendingPairingCodes() {
    const database = await initSecurityStore();
    const now = Date.now();
    const rows = database.query(`
    SELECT * FROM pairing_codes WHERE used = 0 AND expires_at > ?
    ORDER BY created_at ASC
  `).all(now);
    return rows.map(row => ({
        code: row.code,
        platform: row.platform,
        userId: row.userId,
        createdAt: row.createdAt,
        expiresIn: Math.max(0, row.expiresAt - now),
    }));
}
export async function revokeUserAccess(platform, userId) {
    const database = await initSecurityStore();
    const result = database.run("DELETE FROM allowlist WHERE platform = ? AND user_id = ?", [platform, userId]);
    return result.changes > 0;
}
export async function isUserAllowed(platform, userId) {
    const database = await initSecurityStore();
    const config = getSecurityConfig();
    if (config.allowAll)
        return true;
    const entry = database.query(`
    SELECT 1 FROM allowlist WHERE platform = ? AND user_id = ?
  `).get(platform, userId);
    return !!entry;
}
export async function addToAllowlist(platform, userId, note) {
    const database = await initSecurityStore();
    database.run(`
    INSERT OR REPLACE INTO allowlist (platform, user_id, added_at, note)
    VALUES (?, ?, ?, ?)
  `, [platform, userId, Date.now(), note ?? null]);
}
export async function listAllowlistedUsers(platform) {
    const database = await initSecurityStore();
    const query = platform
        ? "SELECT * FROM allowlist WHERE platform = ? ORDER BY added_at DESC"
        : "SELECT * FROM allowlist ORDER BY platform, added_at DESC";
    const rows = platform
        ? database.query(query).all(platform)
        : database.query(query).all();
    return rows;
}
export async function checkRateLimit(identifier, maxRequests = 60, windowMs = 60000) {
    const database = await initSecurityStore();
    const now = Date.now();
    const entry = database.query(`
    SELECT * FROM rate_limits WHERE identifier = ?
  `).get(identifier);
    if (!entry || now - entry.windowStart > windowMs) {
        database.run(`
      INSERT OR REPLACE INTO rate_limits (identifier, count, window_start)
      VALUES (?, 1, ?)
    `, [identifier, now]);
        return true;
    }
    if (entry.count >= maxRequests) {
        console.log(`[Security] Rate limit exceeded for ${identifier}`);
        return false;
    }
    database.run(`
    UPDATE rate_limits SET count = count + 1 WHERE identifier = ?
  `, [identifier]);
    return true;
}
export async function cleanupExpiredCodes() {
    const database = await initSecurityStore();
    const result = database.run("DELETE FROM pairing_codes WHERE expires_at < ?", [Date.now()]);
    return result.changes;
}
const CONFIG_FILE = join(KOBOLD_DIR, "gateway-security.json");
function getSecurityConfig() {
    try {
        if (existsSync(CONFIG_FILE)) {
            const content = readFileSync(CONFIG_FILE, "utf-8");
            return JSON.parse(content);
        }
    }
    catch {
        // Ignore
    }
    return {
        allowAll: false,
        requirePairing: false,
        rateLimit: { maxRequests: 60, windowMs: 60000 },
    };
}
export function setSecurityConfig(config) {
    const current = getSecurityConfig();
    const updated = { ...current, ...config };
    writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
}
//# sourceMappingURL=auth.js.map