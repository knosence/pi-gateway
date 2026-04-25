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
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { initSessionStore, getOrCreateSession, getSession, listSessions, touchSession, } from "./sessions/store.js";
import { initSecurityStore, isUserAllowed, listPendingPairingCodes, listAllowlistedUsers, } from "./security/auth.js";
import { initBackgroundTasks, startBackgroundTask, getPendingResultsForSession, markTaskDelivered, listTasks, } from "./background/manager.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { TwitchAdapter } from "./adapters/twitch.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { SlackAdapter } from "./adapters/slack.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
const KOBOLD_DIR = join(homedir(), ".0xkobold");
const CONFIG_DIR = join(KOBOLD_DIR, "gateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const PI_STDERR_LOG = join(CONFIG_DIR, "pi-stderr.log");
const LIVE_BRIDGE_CONFIG_FILE = join(homedir(), ".pi", "agent", "live-session-bridge.json");
// ═════════════════════════════════════════════════════════════════════════════
// Module-level state (shared with extension factory)
// ═════════════════════════════════════════════════════════════════════════════
const DEFAULT_CONFIG = {
    port: 3847,
    host: "localhost",
    tokens: [],
    corsOrigins: ["*"],
    enableWebSocket: true,
    enableHttp: true,
    security: { allowAll: true, requirePairing: false },
    sessions: { resetPolicy: "idle", dailyHour: 4, idleMinutes: 1440, bindings: {} },
    liveBridge: { enabled: false, url: "http://127.0.0.1:8766", token: "", timeoutMs: 600000, telegramMode: "clean", autoDiscover: true },
    platforms: {},
};
let config = { ...DEFAULT_CONFIG };
let running = false;
let adapters = new Map();
let clients = new Map();
let sessions = new Map();
let server = null;
let wss = null;
let rpcProcess = null;
let cronInterval = null;
let storesInitialized = false;
let attachedGateway = null;
const pendingPromptSessions = [];
const typingCounts = new Map();
const pendingRequests = [];
// ═════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═════════════════════════════════════════════════════════════════════════════
function syncLiveBridgeConfigFromFile(nextConfig) {
    const bridge = nextConfig.liveBridge;
    if (!bridge?.enabled || bridge.autoDiscover === false)
        return nextConfig;
    try {
        if (!existsSync(LIVE_BRIDGE_CONFIG_FILE))
            return nextConfig;
        const parsed = JSON.parse(readFileSync(LIVE_BRIDGE_CONFIG_FILE, "utf-8"));
        if (!parsed.host || !parsed.port || !parsed.token)
            return nextConfig;
        return {
            ...nextConfig,
            liveBridge: {
                ...bridge,
                url: `http://${parsed.host}:${parsed.port}`,
                token: parsed.token,
                timeoutMs: parsed.timeoutMs ?? bridge.timeoutMs ?? 600000,
            },
        };
    }
    catch {
        return nextConfig;
    }
}
function loadConfig() {
    try {
        if (existsSync(CONFIG_FILE)) {
            return syncLiveBridgeConfigFromFile({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) });
        }
    }
    catch { /* ignore */ }
    return syncLiveBridgeConfigFromFile({ ...DEFAULT_CONFIG });
}
function saveConfig() {
    try {
        if (!existsSync(CONFIG_DIR))
            mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    catch { /* ignore */ }
}
function verifyToken(token) {
    if (config.tokens.length === 0)
        return true;
    return config.tokens.includes(token);
}
function authenticate(req) {
    const auth = req.headers.authorization;
    if (!auth)
        return verifyToken("");
    if (auth.startsWith("Bearer "))
        return verifyToken(auth.slice(7));
    return false;
}
function sendWs(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}
function broadcastClients(event, data) {
    for (const ws of clients.values()) {
        sendWs(ws, { type: event, data });
    }
}
function extractAssistantTextFromMessage(message) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
        return "";
    }
    return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
}
function extractAssistantText(msg) {
    return extractAssistantTextFromMessage(msg?.message);
}
function extractLastAssistantTextFromMessages(messages) {
    if (!Array.isArray(messages))
        return "";
    for (let i = messages.length - 1; i >= 0; i--) {
        const text = extractAssistantTextFromMessage(messages[i]);
        if (text)
            return text;
    }
    return "";
}
function isFinalAssistantMessage(msg) {
    const message = msg?.message;
    return message?.role === "assistant" && message?.stopReason === "stop" && !!extractAssistantTextFromMessage(message);
}
function getTypingKey(session) {
    return `${session.platform}:${session.channelId}`;
}
function getBindingKey(platform, channelId) {
    return `${platform}:${channelId}`;
}
async function resolveInboundSession(message) {
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
async function updateTyping(session, delta) {
    if (!session)
        return;
    const key = getTypingKey(session);
    const current = typingCounts.get(key) || 0;
    const next = Math.max(0, current + delta);
    const adapter = adapters.get(session.platform);
    if (!adapter) {
        if (next === 0)
            typingCounts.delete(key);
        else
            typingCounts.set(key, next);
        return;
    }
    try {
        if (delta > 0 && current === 0) {
            await adapter.setTyping(session.channelId, true);
        }
        else if (delta < 0 && next === 0 && current > 0) {
            await adapter.setTyping(session.channelId, false);
        }
    }
    catch (err) {
        console.error(`[gateway] Failed to update typing for ${key}:`, err);
    }
    if (next === 0)
        typingCounts.delete(key);
    else
        typingCounts.set(key, next);
}
async function promptViaLiveBridge(message) {
    config = syncLiveBridgeConfigFromFile(config);
    const bridge = config.liveBridge;
    if (!bridge?.enabled)
        throw new Error("Live bridge not enabled");
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
        const data = await response.json();
        if (!response.ok || !data?.ok || typeof data.text !== "string") {
            throw new Error(data?.error || `Live bridge request failed with ${response.status}`);
        }
        return data.text.trim();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function promptViaLiveBridgeStream(message, onEvent) {
    config = syncLiveBridgeConfigFromFile(config);
    const bridge = config.liveBridge;
    if (!bridge?.enabled)
        throw new Error("Live bridge not enabled");
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
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            while (true) {
                const newlineIndex = buffer.indexOf("\n");
                if (newlineIndex === -1)
                    break;
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (!line)
                    continue;
                const event = JSON.parse(line);
                await onEvent(event);
                if (event.type === "final") {
                    finalText = event.text?.trim() || "";
                }
                if (event.type === "error") {
                    throw new Error(event.error || "Live bridge stream error");
                }
            }
        }
        return finalText;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function deliverPromptResult(session, msg) {
    if (!session)
        return;
    try {
        let text = extractAssistantText(msg);
        if (!text) {
            text = extractLastAssistantTextFromMessages(msg?.messages);
        }
        if (!text && rpcProcess) {
            try {
                const last = await sendRpc("get_last_assistant_text");
                text = last?.data?.text?.trim() || "";
            }
            catch (err) {
                console.error("[gateway] Failed to fetch last assistant text:", err);
            }
        }
        if (!text) {
            console.warn(`[gateway] No assistant text to deliver for ${session.platform}:${session.channelId}`);
            return;
        }
        const adapter = adapters.get(session.platform);
        if (!adapter)
            return;
        try {
            console.log(`[gateway] Delivering response to ${session.platform}:${session.channelId}`);
            await adapter.sendMessage(session.channelId, text);
        }
        catch (err) {
            console.error(`[gateway] Failed to deliver response to ${session.platform}:${session.channelId}:`, err);
        }
    }
    finally {
        await updateTyping(session, -1);
    }
}
function createRpcProcess() {
    const proc = spawn("pi", ["--mode", "rpc", "--no-extensions", "--offline"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434" },
    });
    let stdoutBuffer = "";
    proc.stdout?.on("data", (data) => {
        stdoutBuffer += data.toString();
        while (true) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1)
                break;
            let line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (line.endsWith("\r"))
                line = line.slice(0, -1);
            if (!line.trim())
                continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id) {
                    const idx = pendingRequests.findIndex(r => r.id === msg.id);
                    if (idx !== -1) {
                        pendingRequests.splice(idx, 1)[0].resolve(msg);
                    }
                }
                if (msg.type === "response")
                    broadcastClients("response", msg);
                else
                    broadcastClients("event", msg);
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
            }
            catch (err) {
                console.error("[gateway] Failed to parse pi stdout JSONL record:", err);
            }
        }
    });
    proc.stderr?.on("data", (data) => {
        const text = data.toString();
        try {
            if (!existsSync(CONFIG_DIR))
                mkdirSync(CONFIG_DIR, { recursive: true });
            appendFileSync(PI_STDERR_LOG, text);
        }
        catch {
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
    proc.on("exit", (code) => {
        console.log("[gateway] pi process exited");
        rpcProcess = null;
        broadcastClients("agent_disconnected", { code });
    });
    return proc;
}
async function sendRpc(command, data = {}) {
    if (!rpcProcess)
        throw new Error("pi agent not running");
    const id = randomBytes(8).toString("hex");
    const payload = { id, type: command, ...data };
    return new Promise((resolve, reject) => {
        pendingRequests.push({ id, resolve, reject });
        try {
            rpcProcess.stdin.write(JSON.stringify(payload) + "\n");
        }
        catch (err) {
            const idx = pendingRequests.findIndex(r => r.id === id);
            if (idx !== -1)
                pendingRequests.splice(idx, 1);
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
function escapeTelegramHtml(text) {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
function renderTelegramTurnStatus(state) {
    const thinking = state.phase === "thinking" ? "🔄" : "✅";
    const tool = state.phase === "tool" ? "🔄" : (state.toolName ? (state.toolFinished ? "✅" : "🔄") : "⬜");
    const finalizing = state.phase === "finalizing" ? "🔄" : state.phase === "done" ? "✅" : "⬜";
    const lines = [
        "✨ <b>Turn status</b>",
        "",
        `✅ Received request`,
        `${thinking} Thinking`,
        `${tool} Tool call${state.toolName ? `: <b>${escapeTelegramHtml(state.toolName)}</b>` : ""}`,
        `${finalizing} Final response`,
    ];
    if (state.preview) {
        lines.push("", "💬 <b>Preview</b>", escapeTelegramHtml(state.preview));
    }
    return lines.join("\n");
}
const adapterCallbacks = {
    onMessage: async (message) => {
        const session = await resolveInboundSession(message);
        if (!(await isUserAllowed(message.platform, message.userId))) {
            console.log(`[gateway] User ${message.userId} not in allowlist`);
            return;
        }
        sessions.set(`${message.platform}:${message.channelId}`, session);
        if (config.liveBridge?.enabled) {
            await updateTyping(session, 1);
            try {
                console.log(`[gateway] Forwarding ${message.platform} message from ${message.userId} in ${message.channelId} to live bridge`);
                const adapter = adapters.get(session.platform);
                const telegramMode = config.liveBridge.telegramMode ?? "clean";
                let statusMessageId;
                let lastRenderedText = "";
                let lastRenderAt = 0;
                const turnState = { phase: "thinking" };
                const buildStatusText = () => renderTelegramTurnStatus(turnState);
                const ensureStatusMessage = async () => {
                    if (!adapter || session.platform !== "telegram" || statusMessageId)
                        return;
                    try {
                        const text = buildStatusText();
                        statusMessageId = await adapter.sendMessage(session.channelId, text);
                        lastRenderedText = text;
                        lastRenderAt = Date.now();
                    }
                    catch (err) {
                        console.warn(`[gateway] Failed to create Telegram status message for ${session.id}:`, err);
                    }
                };
                const maybeRenderStatus = async (force = false) => {
                    if (!adapter || session.platform !== "telegram")
                        return;
                    await ensureStatusMessage();
                    if (!statusMessageId)
                        return;
                    const text = buildStatusText();
                    const now = Date.now();
                    if (!force) {
                        if (text === lastRenderedText)
                            return;
                        if (now - lastRenderAt < 1200)
                            return;
                    }
                    try {
                        await adapter.editMessage(session.channelId, statusMessageId, text);
                        lastRenderedText = text;
                        lastRenderAt = now;
                    }
                    catch (err) {
                        console.warn(`[gateway] Failed to edit Telegram status message for ${session.id}:`, err);
                        statusMessageId = undefined;
                    }
                };
                await ensureStatusMessage();
                const text = await promptViaLiveBridgeStream(message.content, async (event) => {
                    if (!adapter || session.platform !== "telegram")
                        return;
                    if (event.type === "status" && event.text) {
                        const statusText = event.text.toLowerCase();
                        if (statusText.includes("running") && event.toolName) {
                            turnState.phase = "tool";
                            turnState.toolName = event.toolName;
                            turnState.toolFinished = false;
                        }
                        else if (statusText.includes("finished") && event.toolName) {
                            turnState.phase = "finalizing";
                            turnState.toolName = event.toolName;
                            turnState.toolFinished = true;
                        }
                        else if (statusText.includes("working") || statusText.includes("thinking")) {
                            turnState.phase = "thinking";
                        }
                        await maybeRenderStatus();
                        return;
                    }
                    if (event.type === "assistant_partial" && event.text) {
                        const partial = event.text.trim();
                        if (!partial)
                            return;
                        turnState.phase = "finalizing";
                        turnState.preview = partial.length > 900 ? `${partial.slice(0, 900).trimEnd()}…` : partial;
                        await maybeRenderStatus();
                        return;
                    }
                    if (event.type === "assistant" && event.text && telegramMode === "clean") {
                        const complete = event.text.trim();
                        if (!complete)
                            return;
                        turnState.phase = "done";
                        turnState.preview = complete.length > 900 ? `${complete.slice(0, 900).trimEnd()}…` : complete;
                        await maybeRenderStatus(true);
                    }
                });
                if (adapter && text) {
                    if (session.platform === "telegram") {
                        await ensureStatusMessage();
                        if (statusMessageId) {
                            if (telegramMode === "clean") {
                                try {
                                    await adapter.deleteMessage(session.channelId, statusMessageId);
                                }
                                catch {
                                }
                                await adapter.sendMessage(session.channelId, text);
                            }
                            else {
                                try {
                                    await maybeRenderStatus(true);
                                }
                                catch {
                                }
                                await adapter.sendMessage(session.channelId, text);
                            }
                        }
                        else {
                            await adapter.sendMessage(session.channelId, text);
                        }
                    }
                    else {
                        await adapter.sendMessage(session.channelId, text);
                    }
                }
            }
            catch (err) {
                console.error(`[gateway] Live bridge prompt failed for ${session.id}:`, err);
            }
            finally {
                await updateTyping(session, -1);
            }
            return;
        }
        if (rpcProcess) {
            console.log(`[gateway] Forwarding ${message.platform} message from ${message.userId} in ${message.channelId} to pi session ${session.id}`);
            const result = await sendRpc("prompt", { message: message.content, sessionId: session.id });
            if (result?.success) {
                pendingPromptSessions.push(session);
                await updateTyping(session, 1);
                console.log(`[gateway] Prompt accepted for ${session.id}; pending sessions: ${pendingPromptSessions.length}`);
            }
            else {
                console.error(`[gateway] Prompt rejected for ${session.id}: ${result?.error || "unknown error"}`);
            }
        }
    },
    onDisconnect: () => {
        console.log("[gateway] Platform adapter disconnected");
    },
};
async function initializeAdapters() {
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
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
            console.error("[gateway] Failed to start WhatsApp adapter:", err);
        }
    }
}
function startCron() {
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
function stopCron() {
    if (cronInterval) {
        clearInterval(cronInterval);
        cronInterval = null;
    }
}
async function handleHttpRequest(req, res) {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            running,
            adapters: Array.from(adapters.keys()),
            clients: clients.size,
            sessions: sessions.size,
            agent: rpcProcess !== null,
        }));
        return;
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await listSessions()));
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
function handleWebSocket(ws, req) {
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
                            ...(typeof result === "object" && result !== null ? result : { result }),
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
        }
        catch (err) {
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
export async function startGateway(opts = {}) {
    if (running || attachedGateway) {
        return getStatus();
    }
    config = loadConfig();
    if (opts.port)
        config.port = opts.port;
    if (opts.host)
        config.host = opts.host;
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
    await new Promise((resolve, reject) => {
        server.listen(config.port, config.host, () => resolve());
        server.on("error", (err) => {
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
    console.log(`[gateway] Started — platforms: ${adapters.size > 0 ? Array.from(adapters.keys()).join(", ") : "none"}, ` +
        `sessions: idle reset every ${config.sessions.idleMinutes} min`);
    return getStatus();
}
/**
 * Stop the gateway server.
 */
export async function stopGateway() {
    if (attachedGateway && !running) {
        attachedGateway = null;
        console.log("[gateway] Detached from external gateway");
        return;
    }
    if (!running)
        return;
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
        await new Promise((resolve, reject) => {
            serverToClose.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
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
export async function isGatewayRunning(port = 3847) {
    try {
        const response = await fetch(`http://localhost:${port}/api/status`);
        const data = (await response.json());
        return data.running === true;
    }
    catch {
        return false;
    }
}
/**
 * Get the current gateway status.
 */
export function getStatus() {
    if (attachedGateway && !running) {
        return {
            running: true,
            port: attachedGateway.port,
            host: attachedGateway.host,
            adapters: attachedGateway.adapters ?? [],
            clientCount: attachedGateway.clients ?? attachedGateway.clientCount ?? 0,
            sessionCount: attachedGateway.sessions ?? attachedGateway.sessionCount ?? 0,
            agentConnected: attachedGateway.agent ?? attachedGateway.agentConnected ?? false,
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
export function getConfig() {
    return config;
}
export function setConfig(nextConfig) {
    config = nextConfig;
    saveConfig();
    return config;
}
/**
 * Check if the gateway is running.
 */
export function isRunning() {
    return running || attachedGateway !== null;
}
/**
 * Get the adapter for a platform, if running.
 */
export function getAdapter(platform) {
    return adapters.get(platform);
}
/**
 * Get all active adapters.
 */
export function getAdapters() {
    return adapters;
}
/**
 * Send a message through a platform adapter.
 */
export async function sendMessage(platform, channelId, content) {
    const adapter = adapters.get(platform);
    if (!adapter)
        return false;
    await adapter.sendMessage(channelId, content);
    return true;
}
/**
 * Attach to an already-running gateway without owning its process.
 */
export async function attachToExistingGateway(port = 3847, host = "localhost") {
    const response = await fetch(`http://${host}:${port}/api/status`);
    if (!response.ok) {
        throw new Error(`Could not attach to gateway on ${host}:${port}`);
    }
    const status = await response.json();
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
export function broadcast(event, data) {
    broadcastClients(event, data);
}
