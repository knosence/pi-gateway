/**
 * pi-gateway Programmatic API
 *
 * Allows starting/stopping the gateway from outside a pi session.
 * Used by src/index.ts to auto-start the gateway at boot.
 *
 * When pi-gateway is also loaded as a pi extension (via pi-kobold),
 * the extension factory attaches to the already-running instance.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";

import {
  initSessionStore,
  getOrCreateSession,
  getSession,
  listSessions,
  touchSession,
  type SessionConfig,
} from "./sessions/store.js";
import {
  initSecurityStore,
  isUserAllowed,
  approvePairingCode,
  generatePairingCode,
  listPendingPairingCodes,
  addToAllowlist,
  listAllowlistedUsers,
  type Platform,
} from "./security/auth.js";
import {
  initBackgroundTasks,
  startBackgroundTask,
  getPendingResultsForSession,
  markTaskDelivered,
  listTasks,
  type BackgroundTask,
} from "./background/manager.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { TwitchAdapter } from "./adapters/twitch.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { SlackAdapter } from "./adapters/slack.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
import { BaseAdapter, type AdapterCallbacks, type PlatformMessage } from "./adapters/base.js";
import { TelegramSendQueue } from "./telegram/send-queue.js";
import { isErr } from "./telegram/block-state.js";
import { TelegramStreamAdapter } from "./telegram/tg-adapter.js";
import { TelegramStreamDispatcher } from "./telegram/stream-dispatcher.js";

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const CONFIG_DIR = join(KOBOLD_DIR, "gateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const PI_STDERR_LOG = join(CONFIG_DIR, "pi-stderr.log");
const LIVE_BRIDGE_CONFIG_FILE = join(homedir(), ".pi", "agent", "live-session-bridge.json");

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

type TelegramMode = "clean" | "balanced" | "full" | "persistent";

export interface GatewayConfig {
  port: number;
  host: string;
  tokens: string[];
  corsOrigins: string[];
  enableWebSocket: boolean;
  enableHttp: boolean;
  security: {
    allowAll: boolean;
    requirePairing: boolean;
  };
  sessions: {
    resetPolicy: "daily" | "idle" | "both";
    dailyHour: number;
    idleMinutes: number;
    bindings?: Record<string, string>;
  };
  liveBridge?: {
    enabled: boolean;
    url: string;
    token: string;
    timeoutMs?: number;
    telegramMode?: TelegramMode;
    telegramModesByChat?: Record<string, TelegramMode>;
    autoDiscover?: boolean;
  };
  platforms: {
    discord?: { enabled: boolean; botToken: string; guildId?: string };
    twitch?: { enabled: boolean; clientId: string; clientSecret: string; channels?: string[] };
    telegram?: { enabled: boolean; token: string; mode?: "polling" | "webhook"; webhookUrl?: string };
    slack?: { enabled: boolean; webhookUrl?: string; botToken?: string };
    whatsapp?: { enabled: boolean; sessionPath?: string; printQr?: boolean };
  };
}

export interface GatewayStatus {
  running: boolean;
  port: number;
  host: string;
  adapters: string[];
  clientCount: number;
  sessionCount: number;
  agentConnected: boolean;
}

export interface StartGatewayOptions {
  port?: number;
  host?: string;
  /** Don't spawn a pi RPC process (use when pi is already running) */
  noAgent?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Module-level state (shared with extension factory)
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3847,
  host: "localhost",
  tokens: [],
  corsOrigins: ["*"],
  enableWebSocket: true,
  enableHttp: true,
  security: { allowAll: true, requirePairing: false },
  sessions: { resetPolicy: "idle", dailyHour: 4, idleMinutes: 1440, bindings: {} },
  liveBridge: { enabled: false, url: "http://127.0.0.1:8766", token: "", timeoutMs: 600000, telegramMode: "balanced", telegramModesByChat: {}, autoDiscover: true },
  platforms: {},
};

let config: GatewayConfig = { ...DEFAULT_CONFIG };
let running = false;
let adapters = new Map<string, BaseAdapter>();
let clients = new Map<string, WebSocket>();
let sessions = new Map<string, SessionConfig>();
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let rpcProcess: any = null;
let cronInterval: ReturnType<typeof setInterval> | null = null;
let storesInitialized = false;
let attachedGateway: Record<string, unknown> | null = null;
const pendingPromptSessions: SessionConfig[] = [];
const typingCounts = new Map<string, number>();

interface PendingRequest {
  id: string;
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
}
const pendingRequests: PendingRequest[] = [];

type ClientSessionMode = "canonical" | "isolated";

type ClientEventKind = "assistant" | "thinking" | "tool" | "error" | "status" | "final";

type ClientStreamEvent = {
  eventId: string;
  turnId: string;
  sessionId: string;
  kind: ClientEventKind;
  timestamp: string;
  payload: Record<string, unknown>;
};

type ClientTurnState = {
  id: string;
  sessionId: string;
  events: ClientStreamEvent[];
  subscribers: Set<ServerResponse>;
  completed: boolean;
};

const clientTurns = new Map<string, ClientTurnState>();
const telegramSendQueue = new TelegramSendQueue();

// ═════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═════════════════════════════════════════════════════════════════════════════

function syncLiveBridgeConfigFromFile(nextConfig: GatewayConfig): GatewayConfig {
  const bridge = nextConfig.liveBridge;
  if (!bridge?.enabled || bridge.autoDiscover === false) return nextConfig;
  try {
    if (!existsSync(LIVE_BRIDGE_CONFIG_FILE)) return nextConfig;
    const parsed = JSON.parse(readFileSync(LIVE_BRIDGE_CONFIG_FILE, "utf-8")) as Partial<{
      host: string;
      port: number;
      token: string;
      timeoutMs: number;
      autoStart: boolean;
    }>;
    if (!parsed.host || !parsed.port || !parsed.token) return nextConfig;
    return {
      ...nextConfig,
      liveBridge: {
        ...bridge,
        url: `http://${parsed.host}:${parsed.port}`,
        token: parsed.token,
        timeoutMs: parsed.timeoutMs ?? bridge.timeoutMs ?? 600000,
      },
    };
  } catch {
    return nextConfig;
  }
}

function loadConfig(): GatewayConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return syncLiveBridgeConfigFromFile({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) });
    }
  } catch { /* ignore */ }
  return syncLiveBridgeConfigFromFile({ ...DEFAULT_CONFIG });
}

function saveConfig(): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch { /* ignore */ }
}

function verifyToken(token: string): boolean {
  if (config.tokens.length === 0) return true;
  return config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return verifyToken("");
  if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
  return false;
}

function sendWs(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastClients(event: string, data: unknown): void {
  for (const ws of clients.values()) {
    sendWs(ws, { type: event, data });
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

function extractAssistantTextFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function extractAssistantText(msg: any): string {
  return extractAssistantTextFromMessage(msg?.message);
}

function extractLastAssistantTextFromMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantTextFromMessage(messages[i]);
    if (text) return text;
  }

  return "";
}

function isFinalAssistantMessage(msg: any): boolean {
  const message = msg?.message;
  return message?.role === "assistant" && message?.stopReason === "stop" && !!extractAssistantTextFromMessage(message);
}

function getTypingKey(session: SessionConfig): string {
  return `${session.platform}:${session.channelId}`;
}

function getBindingKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

async function resolveInboundSession(message: PlatformMessage): Promise<SessionConfig> {
  const bindingKey = getBindingKey(message.platform, message.channelId);
  const boundSessionId = config.sessions.bindings?.[bindingKey];

  if (boundSessionId) {
    const boundSession = await getSession(boundSessionId);
    if (boundSession) {
      await touchSession(boundSession.id);
      return boundSession;
    }

    return {
      id: boundSessionId,
      platform: message.platform,
      channelId: message.channelId,
      userId: message.userId,
      resetPolicy: config.sessions.resetPolicy,
      dailyHour: config.sessions.dailyHour,
      idleMinutes: config.sessions.idleMinutes,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      isBackground: false,
    };
  }

  return getOrCreateSession(message.platform, message.channelId, message.userId, {
    resetPolicy: config.sessions.resetPolicy,
    dailyHour: config.sessions.dailyHour,
    idleMinutes: config.sessions.idleMinutes,
  });
}

async function updateTyping(session: SessionConfig | undefined, delta: 1 | -1): Promise<void> {
  if (!session) return;

  const key = getTypingKey(session);
  const current = typingCounts.get(key) || 0;
  const next = Math.max(0, current + delta);
  const adapter = adapters.get(session.platform);

  if (!adapter) {
    if (next === 0) typingCounts.delete(key);
    else typingCounts.set(key, next);
    return;
  }

  try {
    if (delta > 0 && current === 0) {
      await adapter.setTyping(session.channelId, true);
    } else if (delta < 0 && next === 0 && current > 0) {
      await adapter.setTyping(session.channelId, false);
    }
  } catch (err) {
    console.error(`[gateway] Failed to update typing for ${key}:`, err);
  }

  if (next === 0) typingCounts.delete(key);
  else typingCounts.set(key, next);
}

async function promptViaLiveBridge(message: string): Promise<string> {
  config = syncLiveBridgeConfigFromFile(config);
  const bridge = config.liveBridge;
  if (!bridge?.enabled) throw new Error("Live bridge not enabled");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), bridge.timeoutMs ?? 600000);

  try {
    const response = await fetch(`${bridge.url.replace(/\/$/, "")}/prompt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    const data = await response.json() as { ok?: boolean; text?: string; error?: string };
    if (!response.ok || !data?.ok || typeof data.text !== "string") {
      throw new Error(data?.error || `Live bridge request failed with ${response.status}`);
    }

    return data.text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function promptViaLiveBridgeStream(
  message: string,
  onEvent: (event: BridgeStreamEvent) => Promise<void> | void,
): Promise<string> {
  config = syncLiveBridgeConfigFromFile(config);
  const bridge = config.liveBridge;
  if (!bridge?.enabled) throw new Error("Live bridge not enabled");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), bridge.timeoutMs ?? 600000);

  try {
    const response = await fetch(`${bridge.url.replace(/\/$/, "")}/stream-prompt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Live bridge stream failed with ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";

    for await (const chunk of response.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const event = JSON.parse(line) as BridgeStreamEvent;
        await onEvent(event);
        if (event.type === "final") {
          finalText = event.text?.trim() || "";
          controller.abort();
          return finalText;
        }
        if (event.type === "error") {
          throw new Error(event.error || "Live bridge stream error");
        }
      }
    }

    return finalText;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverPromptResult(session: SessionConfig | undefined, msg: any): Promise<void> {
  if (!session) return;

  try {
    let text = extractAssistantText(msg);

    if (!text) {
      text = extractLastAssistantTextFromMessages(msg?.messages);
    }

    if (!text && rpcProcess) {
      try {
        const last = await sendRpc("get_last_assistant_text") as { success?: boolean; data?: { text?: string } };
        text = last?.data?.text?.trim() || "";
      } catch (err) {
        console.error("[gateway] Failed to fetch last assistant text:", err);
      }
    }

    if (!text) {
      console.warn(`[gateway] No assistant text to deliver for ${session.platform}:${session.channelId}`);
      return;
    }

    const adapter = adapters.get(session.platform);
    if (!adapter) return;

    try {
      console.log(`[gateway] Delivering response to ${session.platform}:${session.channelId}`);
      await adapter.sendMessage(session.channelId, text);
    } catch (err) {
      console.error(`[gateway] Failed to deliver response to ${session.platform}:${session.channelId}:`, err);
    }
  } finally {
    await updateTyping(session, -1);
  }
}

function createRpcProcess(): any {
  const proc = spawn("pi", ["--mode", "rpc", "--no-extensions", "--offline"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434" },
  });

  let stdoutBuffer = "";

  proc.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id) {
          const idx = pendingRequests.findIndex(r => r.id === msg.id);
          if (idx !== -1) {
            pendingRequests.splice(idx, 1)[0].resolve(msg);
          }
        }
        if (msg.type === "response") broadcastClients("response", msg);
        else broadcastClients("event", msg);

        if (msg.type === "message_end" && isFinalAssistantMessage(msg) && pendingPromptSessions.length > 0) {
          const session = pendingPromptSessions.shift();
          console.log(`[gateway] Received final assistant message; pending sessions left: ${pendingPromptSessions.length}`);
          void deliverPromptResult(session, msg);
          continue;
        }

        if (msg.type === "agent_end" && pendingPromptSessions.length > 0) {
          const session = pendingPromptSessions.shift();
          console.log(`[gateway] Received agent_end; pending sessions left: ${pendingPromptSessions.length}`);
          void deliverPromptResult(session, msg);
        }
      } catch (err) {
        console.error("[gateway] Failed to parse pi stdout JSONL record:", err);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();

    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      appendFileSync(PI_STDERR_LOG, text);
    } catch {
      // ignore log write failures
    }

    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const looksImportant = /(^|\b)(error|failed|exception|unhandled)\b/i.test(line);
      if (looksImportant) {
        console.error("[gateway] pi stderr:", line);
      }
    }
  });

  proc.on("exit", (code: number) => {
    console.log("[gateway] pi process exited");
    rpcProcess = null;
    broadcastClients("agent_disconnected", { code });
  });

  return proc;
}

async function sendRpc(command: string, data: Record<string, unknown> = {}): Promise<unknown> {
  if (!rpcProcess) throw new Error("pi agent not running");

  const id = randomBytes(8).toString("hex");
  const payload = { id, type: command, ...data };

  return new Promise((resolve, reject) => {
    pendingRequests.push({ id, resolve, reject });

    try {
      rpcProcess.stdin.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      const idx = pendingRequests.findIndex(r => r.id === id);
      if (idx !== -1) pendingRequests.splice(idx, 1);
      reject(err);
    }

    setTimeout(() => {
      const idx = pendingRequests.findIndex(r => r.id === id);
      if (idx !== -1) {
        pendingRequests.splice(idx, 1);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeTelegramMode(mode?: TelegramMode): "clean" | "balanced" | "full" {
  if (mode === "persistent") return "full";
  if (mode === "clean" || mode === "full") return mode;
  return "balanced";
}

function getTelegramModeForSession(session: SessionConfig): "clean" | "balanced" | "full" {
  const bridge = config.liveBridge;
  const key = `${session.platform}:${session.channelId}`;
  const scopedMode = bridge?.telegramModesByChat?.[key];
  return normalizeTelegramMode(scopedMode ?? bridge?.telegramMode);
}

type BridgeStreamEvent = { type?: string; text?: string; error?: string; toolName?: string; isError?: boolean; phase?: "start" | "end" };

type ChatSurfaceEvent = {
  kind: "assistant_message" | "thinking" | "tool_call" | "failure" | "completion";
  tier: 1 | 2 | 3;
  phase?: "partial" | "final" | "start" | "end";
  summary: string;
  toolName?: string;
  isError?: boolean;
};

function normalizeBridgeStreamEvent(event: BridgeStreamEvent): ChatSurfaceEvent | null {
  if (event.type === "assistant_partial" && event.text?.trim()) {
    return { kind: "assistant_message", tier: 1, phase: "partial", summary: event.text.trim() };
  }
  if ((event.type === "assistant" || event.type === "final") && event.text?.trim()) {
    return { kind: "assistant_message", tier: 1, phase: "final", summary: event.text.trim() };
  }
  if (event.type === "thinking" && event.text?.trim()) {
    return { kind: "thinking", tier: 2, summary: event.text.trim() };
  }
  if (event.type === "error") {
    return { kind: "failure", tier: 1, summary: event.error?.trim() || "Live bridge stream error" };
  }
  if (event.type === "status" && event.text) {
    const statusText = event.text.trim();
    if (event.toolName) {
      return {
        kind: "tool_call",
        tier: event.isError ? 1 : 2,
        phase: event.phase === "end" ? "end" : "start",
        summary: statusText,
        toolName: event.toolName,
        isError: event.isError,
      };
    }
    return null;
  }
  return null;
}

function publishClientTurnEvent(turn: ClientTurnState, event: ClientStreamEvent): void {
  turn.events.push(event);
  const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of turn.subscribers) {
    try {
      res.write(payload);
    } catch {
      turn.subscribers.delete(res);
    }
  }
}

function completeClientTurn(turn: ClientTurnState): void {
  turn.completed = true;
  for (const res of turn.subscribers) {
    try {
      res.end();
    } catch {
      // ignore subscriber close failures
    }
  }
  turn.subscribers.clear();
  setTimeout(() => {
    clientTurns.delete(turn.id);
  }, 10 * 60 * 1000).unref?.();
}

function createClientEvent(
  turn: ClientTurnState,
  kind: ClientEventKind,
  payload: Record<string, unknown>,
): ClientStreamEvent {
  return {
    eventId: `evt_${randomBytes(6).toString("hex")}`,
    turnId: turn.id,
    sessionId: turn.sessionId,
    kind,
    timestamp: new Date().toISOString(),
    payload,
  };
}

async function resolveClientSession(body: any): Promise<SessionConfig> {
  const requestedSessionId = typeof body?.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  if (requestedSessionId) {
    const existing = await getSession(requestedSessionId);
    if (existing) {
      await touchSession(existing.id);
      return existing;
    }
  }

  const sessionMode: ClientSessionMode = body?.sessionMode === "isolated" ? "isolated" : "canonical";
  const clientKind = typeof body?.clientKind === "string" && body.clientKind.trim() ? body.clientKind.trim() : "mobile";
  const surfaceId = typeof body?.surfaceId === "string" && body.surfaceId.trim() ? body.surfaceId.trim() : `${clientKind}-client`;
  const userId = typeof body?.userId === "string" && body.userId.trim() ? body.userId.trim() : surfaceId;
  const channelId = sessionMode === "canonical"
    ? "canonical"
    : `isolated:${surfaceId}:${randomBytes(6).toString("hex")}`;

  return getOrCreateSession("client", channelId, userId, {
    resetPolicy: config.sessions.resetPolicy,
    dailyHour: config.sessions.dailyHour,
    idleMinutes: config.sessions.idleMinutes,
  });
}

function startClientTurn(turn: ClientTurnState, message: string): void {
  const assistantMessageId = `assistant_${turn.id}`;
  void (async () => {
    try {
      let latestAssistantText = "";
      const streamedFinalText = await promptViaLiveBridgeStream(message, async (bridgeEvent) => {
        if (bridgeEvent.type === "assistant_partial" && bridgeEvent.text?.trim()) {
          latestAssistantText += bridgeEvent.text;
          return;
        }

        if (bridgeEvent.type === "thinking" && bridgeEvent.text?.trim()) {
          publishClientTurnEvent(turn, createClientEvent(turn, "thinking", {
            messageId: `thinking_${randomBytes(4).toString("hex")}`,
            text: bridgeEvent.text.trim(),
            final: true,
          }));
          return;
        }

        if (bridgeEvent.type === "status" && bridgeEvent.toolName && bridgeEvent.text?.trim()) {
          publishClientTurnEvent(turn, createClientEvent(turn, "tool", {
            messageId: `tool_${randomBytes(4).toString("hex")}`,
            toolName: bridgeEvent.toolName,
            phase: bridgeEvent.phase === "end" ? "end" : "start",
            summary: bridgeEvent.text.trim(),
            important: !!bridgeEvent.isError,
            error: bridgeEvent.isError ? bridgeEvent.text.trim() : null,
          }));
          return;
        }

        if (bridgeEvent.type === "error") {
          publishClientTurnEvent(turn, createClientEvent(turn, "error", {
            messageId: `error_${randomBytes(4).toString("hex")}`,
            text: bridgeEvent.error?.trim() || "Live bridge stream error",
            scope: "bridge",
            retrying: false,
            fatal: false,
          }));
        }
      });

      const finalText = streamedFinalText || latestAssistantText;

      publishClientTurnEvent(turn, createClientEvent(turn, "final", {
        messageId: assistantMessageId,
        text: finalText,
        markdown: true,
        finishReason: "completed",
      }));
    } catch (err) {
      publishClientTurnEvent(turn, createClientEvent(turn, "error", {
        messageId: `error_${randomBytes(4).toString("hex")}`,
        text: err instanceof Error ? err.message : String(err),
        scope: "turn",
        retrying: false,
        fatal: false,
      }));
    } finally {
      completeClientTurn(turn);
    }
  })();
}

const adapterCallbacks: AdapterCallbacks = {
  onMessage: async (message: PlatformMessage) => {
    const session = await resolveInboundSession(message);

    if (!(await isUserAllowed(message.platform as Platform, message.userId))) {
      console.log(`[gateway] User ${message.userId} not in allowlist`);
      return;
    }

    sessions.set(`${message.platform}:${message.channelId}`, session);

    if (config.liveBridge?.enabled) {
      await updateTyping(session, 1);
      try {
        console.log(`[gateway] Forwarding ${message.platform} message from ${message.userId} in ${message.channelId} to live bridge`);
        const adapter = adapters.get(session.platform);

        if (session.platform === "telegram" && adapter instanceof TelegramAdapter) {
          const telegramMode = getTelegramModeForSession(session);

          if (telegramMode === "full") {
            const dispatcher = new TelegramStreamDispatcher(
              session.channelId,
              new TelegramStreamAdapter(adapter, telegramSendQueue),
            );

            await promptViaLiveBridgeStream(message.content, async (event) => {
              const result = await dispatcher.onBridgeEvent(event);
              if (isErr(result)) {
                console.warn(`[gateway] Telegram stream dispatch failed for ${session.id}: ${result.error}`);
              }
            });

            const flushResult = await dispatcher.streamEnd();
            if (isErr(flushResult)) {
              console.warn(`[gateway] Telegram stream flush failed for ${session.id}: ${flushResult.error}`);
            }
          } else {
            const text = await promptViaLiveBridgeStream(message.content, async () => {});
            if (text) {
              await adapter.sendMessage(session.channelId, text);
            }
          }
        } else {
          const text = await promptViaLiveBridgeStream(message.content, async () => {});
          if (adapter && text) {
            await adapter.sendMessage(session.channelId, text);
          }
        }
      } catch (err) {
        console.error(`[gateway] Live bridge prompt failed for ${session.id}:`, err);
      } finally {
        await updateTyping(session, -1);
      }
      return;
    }

    if (rpcProcess) {
      console.log(`[gateway] Forwarding ${message.platform} message from ${message.userId} in ${message.channelId} to pi session ${session.id}`);
      const result = await sendRpc("prompt", { message: message.content, sessionId: session.id }) as { success?: boolean; error?: string };
      if (result?.success) {
        pendingPromptSessions.push(session);
        await updateTyping(session, 1);
        console.log(`[gateway] Prompt accepted for ${session.id}; pending sessions: ${pendingPromptSessions.length}`);
      } else {
        console.error(`[gateway] Prompt rejected for ${session.id}: ${result?.error || "unknown error"}`);
      }
    }
  },
  onDisconnect: () => {
    console.log("[gateway] Platform adapter disconnected");
  },
};

async function initializeAdapters(): Promise<void> {
  if (config.platforms.discord?.enabled && config.platforms.discord.botToken) {
    try {
      const adapter = new DiscordAdapter({
        enabled: true,
        platform: "discord",
        botToken: config.platforms.discord.botToken,
        guildId: config.platforms.discord.guildId,
      });
      await adapter.initialize();
      await adapter.start(adapterCallbacks);
      adapters.set("discord", adapter);
      console.log("[gateway] Discord adapter started");
    } catch (err) {
      console.error("[gateway] Failed to start Discord adapter:", err);
    }
  }

  if (config.platforms.twitch?.enabled && config.platforms.twitch.clientId && config.platforms.twitch.clientSecret) {
    try {
      const adapter = new TwitchAdapter({
        enabled: true,
        platform: "twitch",
        clientId: config.platforms.twitch.clientId,
        clientSecret: config.platforms.twitch.clientSecret,
        channels: config.platforms.twitch.channels,
      });
      await adapter.initialize();
      await adapter.start(adapterCallbacks);
      adapters.set("twitch", adapter);
      console.log("[gateway] Twitch adapter started");
    } catch (err) {
      console.error("[gateway] Failed to start Twitch adapter:", err);
    }
  }

  if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
    try {
      const adapter = new TelegramAdapter({
        enabled: true,
        platform: "telegram",
        token: config.platforms.telegram.token,
        mode: config.platforms.telegram.mode,
        webhookUrl: config.platforms.telegram.webhookUrl,
      });
      await adapter.initialize();
      await adapter.start(adapterCallbacks);
      adapters.set("telegram", adapter);
      console.log("[gateway] Telegram adapter started");
    } catch (err) {
      console.error("[gateway] Failed to start Telegram adapter:", err);
    }
  }

  if (config.platforms.slack?.enabled && (config.platforms.slack.webhookUrl || config.platforms.slack.botToken)) {
    try {
      const adapter = new SlackAdapter({
        enabled: true,
        platform: "slack",
        webhookUrl: config.platforms.slack.webhookUrl,
        botToken: config.platforms.slack.botToken,
      });
      await adapter.initialize();
      await adapter.start(adapterCallbacks);
      adapters.set("slack", adapter);
      console.log("[gateway] Slack adapter started");
    } catch (err) {
      console.error("[gateway] Failed to start Slack adapter:", err);
    }
  }

  if (config.platforms.whatsapp?.enabled) {
    try {
      const adapter = new WhatsAppAdapter({
        enabled: true,
        platform: "whatsapp",
        sessionPath: config.platforms.whatsapp.sessionPath,
        printQr: config.platforms.whatsapp.printQr,
      });
      await adapter.initialize();
      await adapter.start(adapterCallbacks);
      adapters.set("whatsapp", adapter);
      console.log("[gateway] WhatsApp adapter started");
    } catch (err) {
      console.error("[gateway] Failed to start WhatsApp adapter:", err);
    }
  }
}

function startCron(): void {
  cronInterval = setInterval(async () => {
    for (const session of sessions.values()) {
      const pending = await getPendingResultsForSession(session.id);
      for (const task of pending) {
        const adapter = adapters.get(session.platform);
        if (adapter) {
          const resultText = task.status === "completed"
            ? `✅ Background task completed:\n\`\`\`\n${JSON.stringify(task.result, null, 2)}\n\`\`\``
            : `❌ Background task failed:\n\`\`\`\n${task.error}\n\`\`\``;
          await adapter.sendMessage(session.channelId, resultText);
          await markTaskDelivered(task.id);
        }
      }
    }
    for (const session of sessions.values()) {
      await touchSession(session.id);
    }
  }, 60000);
}

function stopCron(): void {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.join(",") || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!authenticate(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/status" && req.method === "GET") {
    writeJson(res, 200, {
      running,
      adapters: Array.from(adapters.keys()),
      clients: clients.size,
      sessions: sessions.size,
      agent: rpcProcess !== null,
    });
    return;
  }

  if (url.pathname === "/api/client/sessions/resolve" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const session = await resolveClientSession(body);
      writeJson(res, 200, {
        ok: true,
        session: {
          id: session.id,
          mode: session.channelId === "canonical" ? "canonical" : "isolated",
          title: "Vela",
          created: !body?.sessionId,
        },
      });
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/client/turns" && req.method === "POST") {
    try {
      if (!config.liveBridge?.enabled) {
        writeJson(res, 503, { ok: false, error: "Live bridge is not enabled" });
        return;
      }
      const body = await readJsonBody(req);
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const inputText = typeof body?.input?.text === "string" ? body.input.text.trim() : "";
      if (!sessionId || !inputText) {
        writeJson(res, 400, { ok: false, error: "sessionId and input.text are required" });
        return;
      }
      const session = await getSession(sessionId);
      if (!session) {
        writeJson(res, 404, { ok: false, error: `Unknown session: ${sessionId}` });
        return;
      }
      await touchSession(session.id);
      const turnId = `turn_${randomBytes(6).toString("hex")}`;
      const turn: ClientTurnState = {
        id: turnId,
        sessionId: session.id,
        events: [],
        subscribers: new Set(),
        completed: false,
      };
      clientTurns.set(turn.id, turn);
      startClientTurn(turn, inputText);
      writeJson(res, 200, {
        ok: true,
        turn: {
          id: turn.id,
          sessionId: turn.sessionId,
          streamUrl: `/api/client/turns/${turn.id}/stream`,
        },
      });
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const clientTurnMatch = url.pathname.match(/^\/api\/client\/turns\/([^/]+)\/stream$/);
  if (clientTurnMatch && req.method === "GET") {
    const turn = clientTurns.get(clientTurnMatch[1]);
    if (!turn) {
      writeJson(res, 404, { ok: false, error: "Turn not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    for (const event of turn.events) {
      res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    if (turn.completed) {
      res.end();
      return;
    }

    turn.subscribers.add(res);
    req.on("close", () => {
      turn.subscribers.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    writeJson(res, 200, await listSessions());
    return;
  }

  if (url.pathname === "/api/background" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await listTasks()));
    return;
  }

  if (url.pathname === "/api/allowlist" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await listAllowlistedUsers()));
    return;
  }

  if (url.pathname === "/api/pairing" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await listPendingPairingCodes()));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
  if (!authenticate(req)) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const clientId = randomBytes(8).toString("hex");
  clients.set(clientId, ws);
  console.log(`[gateway] WebSocket client connected: ${clientId}`);
  sendWs(ws, { type: "connected", data: { clientId } });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "prompt": {
          const message = msg.data?.message || "";
          const sessionId = typeof msg.data?.sessionId === "string" && msg.data.sessionId.trim()
            ? msg.data.sessionId.trim()
            : undefined;
          const result = await sendRpc("prompt", {
            message,
            ...(sessionId ? { sessionId } : {}),
          });
          sendWs(ws, {
            type: "response",
            id: msg.id,
            data: {
              ...(typeof result === "object" && result !== null ? result as Record<string, unknown> : { result }),
              ...(sessionId ? { sessionId } : {}),
            },
          });
          break;
        }
        case "background": {
          const task = await startBackgroundTask(msg.data?.sessionId || "default", msg.data?.command || "");
          sendWs(ws, { type: "background_started", data: task });
          break;
        }
        case "ping": {
          sendWs(ws, { type: "pong", data: { time: Date.now() } });
          break;
        }
      }
    } catch (err) {
      sendWs(ws, { type: "error", data: { error: String(err) } });
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[gateway] WebSocket client disconnected: ${clientId}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Start the gateway server programmatically.
 *
 * Call this from src/index.ts or any boot code.
 * When pi-gateway also loads as a pi extension, it will detect
 * the already-running instance and attach to it.
 */
export async function startGateway(opts: StartGatewayOptions = {}): Promise<GatewayStatus> {
  if (running || attachedGateway) {
    return getStatus();
  }

  config = loadConfig();
  if (opts.port) config.port = opts.port;
  if (opts.host) config.host = opts.host;

  // Initialize stores (idempotent)
  if (!storesInitialized) {
    await Promise.all([initSessionStore(), initSecurityStore(), initBackgroundTasks()]);
    storesInitialized = true;
  }

  // Start HTTP server
  server = createServer(handleHttpRequest);

  if (config.enableWebSocket) {
    wss = new WebSocketServer({ server });
    wss.on("connection", handleWebSocket);
  }

  await new Promise<void>((resolve, reject) => {
    server!.listen(config.port, config.host, () => resolve());
    server!.on("error", (err: any) => {
      if (err && typeof err === "object" && err.code === "EADDRINUSE") {
        err.gatewayQuestion = {
          question: `Port ${config.port} is already in use. What would you like to do?`,
          options: [
            { label: `Keep using the existing gateway on port ${config.port}` },
            { label: `Retry on port ${config.port + 1}` },
            { label: "Cancel" },
          ],
          port: config.port,
          suggestedPort: config.port + 1,
        };
      }
      reject(err);
    });
  });

  console.log(`[gateway] HTTP server started on ${config.host}:${config.port}`);

  // Start pi agent (unless disabled — e.g. when pi is already running)
  if (!opts.noAgent) {
    rpcProcess = createRpcProcess();
  }

  // Initialize platform adapters
  await initializeAdapters();

  // Start cron
  startCron();

  running = true;

  console.log(
    `[gateway] Started — platforms: ${adapters.size > 0 ? Array.from(adapters.keys()).join(", ") : "none"}, ` +
    `sessions: idle reset every ${config.sessions.idleMinutes} min`
  );

  return getStatus();
}

/**
 * Stop the gateway server.
 */
export async function stopGateway(): Promise<void> {
  if (attachedGateway && !running) {
    attachedGateway = null;
    console.log("[gateway] Detached from external gateway");
    return;
  }
  if (!running) return;

  // Stop adapters
  for (const adapter of adapters.values()) {
    await adapter.stop();
  }
  adapters.clear();

  // Stop cron
  stopCron();

  // Close WebSocket clients
  for (const ws of clients.values()) {
    ws.close(1000, "Server shutting down");
  }
  clients.clear();
  sessions.clear();

  // Stop HTTP server and wait for the port to be released before returning.
  const serverToClose = server;
  server = null;
  wss = null;

  if (serverToClose) {
    await new Promise<void>((resolve, reject) => {
      serverToClose.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Kill pi process
  if (rpcProcess) {
    rpcProcess.kill();
    rpcProcess = null;
  }

  running = false;

  console.log("[gateway] Stopped");
}

/**
 * Check if the gateway is already running on a given port.
 * Useful for detecting an existing instance at boot.
 */
export async function isGatewayRunning(port: number = 3847): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/api/status`);
    const data = (await response.json()) as Record<string, unknown>;
    return data.running === true;
  } catch {
    return false;
  }
}

/**
 * Get the current gateway status.
 */
export function getStatus(): GatewayStatus {
  if (attachedGateway && !running) {
    return {
      running: true,
      port: attachedGateway.port as number,
      host: attachedGateway.host as string,
      adapters: (attachedGateway.adapters as string[] | undefined) ?? [],
      clientCount: (attachedGateway.clients as number | undefined) ?? (attachedGateway.clientCount as number | undefined) ?? 0,
      sessionCount: (attachedGateway.sessions as number | undefined) ?? (attachedGateway.sessionCount as number | undefined) ?? 0,
      agentConnected: (attachedGateway.agent as boolean | undefined) ?? (attachedGateway.agentConnected as boolean | undefined) ?? false,
    };
  }
  return {
    running,
    port: config.port,
    host: config.host,
    adapters: Array.from(adapters.keys()),
    clientCount: clients.size,
    sessionCount: sessions.size,
    agentConnected: rpcProcess !== null,
  };
}

/**
 * Get the current gateway config.
 */
export function getConfig(): GatewayConfig {
  return config;
}

/**
 * Update gateway config and persist it.
 */
export function setConfig(nextConfig: GatewayConfig): GatewayConfig {
  config = nextConfig;
  saveConfig();
  return config;
}

/**
 * Check if the gateway is running.
 */
export function isRunning(): boolean {
  return running || attachedGateway !== null;
}

/**
 * Get the adapter for a platform, if running.
 */
export function getAdapter(platform: string): BaseAdapter | undefined {
  return adapters.get(platform);
}

/**
 * Get all active adapters.
 */
export function getAdapters(): Map<string, BaseAdapter> {
  return adapters;
}

/**
 * Send a message through a platform adapter.
 */
export async function sendMessage(platform: string, channelId: string, content: string): Promise<boolean> {
  const adapter = adapters.get(platform);
  if (!adapter) return false;
  await adapter.sendMessage(channelId, content);
  return true;
}

/**
 * Attach to an already-running gateway without owning its process.
 */
export async function attachToExistingGateway(port: number = 3847, host: string = "localhost"): Promise<GatewayStatus> {
  const response = await fetch(`http://${host}:${port}/api/status`);
  if (!response.ok) {
    throw new Error(`Could not attach to gateway on ${host}:${port}`);
  }
  const status = await response.json() as Record<string, unknown>;
  if (status?.running !== true) {
    throw new Error(`Gateway on ${host}:${port} is not running`);
  }
  config = loadConfig();
  config.port = port;
  config.host = host;
  attachedGateway = {
    host,
    port,
    ...status,
  };
  running = false;
  return getStatus();
}

/**
 * Broadcast a message to all connected WebSocket clients.
 */
export function broadcast(event: string, data: unknown): void {
  broadcastClients(event, data);
}
