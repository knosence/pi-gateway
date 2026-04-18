/**
 * pi-gateway - Hermes-style Messaging Gateway
 *
 * Architecture:
 * - Single background process
 * - Platform adapters (Discord, Telegram, etc.)
 * - Per-chat session management
 * - Background task support
 * - Security (allowlists, pairing)
 *
 * Usage in pi session:
 *   /gateway start [port]    - Start the gateway
 *   /gateway stop            - Stop the gateway
 *   /gateway status          - Show status
 *   /gateway pair <code>     - Approve pairing code
 *
 * Programmatic API:
 *   import { startGateway, stopGateway, isGatewayRunning } from '@0xkobold/pi-gateway/api';
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  startGateway,
  stopGateway,
  getStatus,
  isRunning,
  getConfig,
  getAdapters,
  sendMessage,
  attachToExistingGateway,
  broadcast,
  type GatewayStatus,
  type StartGatewayOptions,
} from "./api.js";

import {
  getOrCreateSession,
  listSessions,
  type SessionConfig,
} from "./sessions/store.js";

import {
  isUserAllowed,
  approvePairingCode,
  generatePairingCode,
  listPendingPairingCodes,
  addToAllowlist,
  listAllowlistedUsers,
  type Platform,
} from "./security/auth.js";

import {
  startBackgroundTask,
  listTasks,
} from "./background/manager.js";

let globalCtx: ExtensionContext | null = null;

function updateStatus(): void {
  if (!globalCtx) return;

  const status = getStatus();
  const adapterCount = status.adapters.length;

  const statusText = status.running
    ? adapterCount > 0
      ? `🟢 Gateway (${adapterCount} platform${adapterCount !== 1 ? "s" : ""})`
      : `🟡 Gateway (waiting)`
    : "🔴 Gateway";

  globalCtx.ui.setStatus("gateway", statusText);
}

function getGatewayStartErrorMessage(err: unknown): string {
  const error = err as NodeJS.ErrnoException & { gatewayQuestion?: { port?: number } };
  const port = error?.gatewayQuestion?.port ?? getConfig().port;

  if (error?.code === "EADDRINUSE") {
    return `⚠️ Could not start gateway: port ${port} is already in use.\n\nStop the other process or restart on a different port with /gateway start <port>.`;
  }

  return `⚠️ Gateway start failed: ${error?.message ?? String(err)}`;
}

interface PortConflictInfo {
  port: number;
  suggestedPort: number;
  pid?: number;
  command?: string;
  isGateway: boolean;
  gatewayStatus?: Record<string, unknown>;
}

async function inspectPortConflict(port: number): Promise<PortConflictInfo> {
  const info: PortConflictInfo = {
    port,
    suggestedPort: port + 1,
    pid: undefined,
    command: undefined,
    isGateway: false,
    gatewayStatus: undefined,
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      if (data?.running === true) {
        info.isGateway = true;
        info.gatewayStatus = data;
      }
    }
  } catch {
    // ignore
  }

  try {
    const pid = execFileSync("bash", ["-lc", `lsof -tiTCP:${port} -sTCP:LISTEN -n -P | head -n1`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (pid) {
      info.pid = Number(pid);
      try {
        info.command = execFileSync("ps", ["-p", pid, "-o", "command="], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return info;
}

async function waitForPortToBeFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const conflict = await inspectPortConflict(port);
    if (!conflict.pid && !conflict.isGateway) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function notifyGatewayStatus(status: GatewayStatus, ctx: ExtensionContext, prefix = "✅ Gateway started"): void {
  updateStatus();
  ctx.ui.notify(
    `${prefix} on http://${status.host}:${status.port}\n\n` +
    `Platforms: ${status.adapters.length > 0 ? status.adapters.join(", ") : "none"}\n` +
    `Sessions: Idle reset every ${getConfig().sessions.idleMinutes} min`,
    "info"
  );
}

async function startGatewayWithRecovery(port: number | undefined, ctx: ExtensionContext): Promise<void> {
  const status = await startGateway({ port, noAgent: false });
  notifyGatewayStatus(status, ctx);
}

async function promptForCustomPort(ctx: ExtensionContext, initialPort: number): Promise<number | null> {
  const value = await ctx.ui.input("Start gateway on which port?", String(initialPort));
  if (!value) return null;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.ui.notify(`Invalid port: ${value}`, "error");
    return null;
  }
  return port;
}

async function tryTerminateConflict(conflict: PortConflictInfo, ctx: ExtensionContext, signal: NodeJS.Signals): Promise<void> {
  if (!conflict.pid) {
    throw new Error("No PID found for conflicting listener");
  }
  process.kill(conflict.pid, signal);
  const freed = await waitForPortToBeFree(conflict.port);
  if (freed) {
    return;
  }
  if (signal === "SIGTERM") {
    const force = await ctx.ui.confirm(
      "Process did not exit cleanly",
      `PID ${conflict.pid} is still listening on port ${conflict.port}.\n\nForce kill with SIGKILL?`
    );
    if (!force) {
      throw new Error(`Port ${conflict.port} is still busy after SIGTERM`);
    }
    process.kill(conflict.pid, "SIGKILL");
    const forceFreed = await waitForPortToBeFree(conflict.port);
    if (!forceFreed) {
      throw new Error(`Port ${conflict.port} is still busy after SIGKILL`);
    }
    return;
  }
  throw new Error(`Port ${conflict.port} is still busy after ${signal}`);
}

async function handleGatewayStartError(err: unknown, ctx: ExtensionContext): Promise<void> {
  const error = err as NodeJS.ErrnoException & { gatewayQuestion?: { port?: number; suggestedPort?: number } };
  if (!ctx.hasUI || error?.code !== "EADDRINUSE" || !error?.gatewayQuestion) {
    ctx.ui.notify(getGatewayStartErrorMessage(err), "error");
    return;
  }

  const { port = getConfig().port, suggestedPort = getConfig().port + 1 } = error.gatewayQuestion;
  const conflict = await inspectPortConflict(port);
  const options: string[] = [];
  const useExistingLabel = conflict.isGateway
    ? `Attach to the existing gateway on port ${port}`
    : `Do nothing and keep the current listener on port ${port}`;
  options.push(useExistingLabel);

  let replaceLabel: string | null = null;
  if (conflict.pid) {
    replaceLabel = conflict.isGateway
      ? `Stop PID ${conflict.pid} and restart gateway on port ${port}`
      : `Kill PID ${conflict.pid} and start gateway on port ${port}`;
    options.push(replaceLabel);
  }

  const retryLabel = `Retry on port ${suggestedPort}`;
  const customPortLabel = "Choose a custom port...";
  options.push(retryLabel);
  options.push(customPortLabel);
  options.push("Cancel");

  const details = [
    `Port ${port} is already in use. What would you like to do?`,
    conflict.pid ? `PID: ${conflict.pid}` : null,
    conflict.command ? `Process: ${conflict.command}` : null,
    conflict.isGateway ? `Detected: existing pi gateway` : null,
  ].filter(Boolean).join("\n");

  const choice = await ctx.ui.select(details, options);

  if (choice === useExistingLabel) {
    if (conflict.isGateway) {
      try {
        const status = await attachToExistingGateway(port, "127.0.0.1");
        notifyGatewayStatus(status, ctx, "✅ Attached to existing gateway");
        return;
      } catch (attachErr) {
        ctx.ui.notify(`⚠️ Could not attach to the existing gateway: ${(attachErr as Error)?.message ?? String(attachErr)}`, "error");
        return;
      }
    }
    ctx.ui.notify(`Leaving the current listener on port ${port} unchanged.`, "info");
    return;
  }

  if (replaceLabel && choice === replaceLabel) {
    try {
      await tryTerminateConflict(conflict, ctx, "SIGTERM");
      await startGatewayWithRecovery(port, ctx);
      return;
    } catch (replaceErr) {
      updateStatus();
      ctx.ui.notify(`⚠️ Could not replace the existing process: ${(replaceErr as Error)?.message ?? String(replaceErr)}`, "error");
      return;
    }
  }

  if (choice === retryLabel) {
    try {
      await startGatewayWithRecovery(suggestedPort, ctx);
      return;
    } catch (retryErr) {
      updateStatus();
      await handleGatewayStartError(retryErr, ctx);
      return;
    }
  }

  if (choice === customPortLabel) {
    const customPort = await promptForCustomPort(ctx, suggestedPort);
    if (!customPort) {
      ctx.ui.notify("Custom port entry cancelled", "info");
      return;
    }
    try {
      await startGatewayWithRecovery(customPort, ctx);
      return;
    } catch (customErr) {
      updateStatus();
      await handleGatewayStartError(customErr, ctx);
      return;
    }
  }

  ctx.ui.notify("Gateway start cancelled", "info");
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("gateway", {
    description: "Manage Hermes-style messaging gateway",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["start", "stop", "status", "restart", "pair", "allow", "sessions", "tasks", "config"];
      return cmds.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const subcmd = parts[0]?.toLowerCase();

      switch (subcmd) {
        case "start": {
          if (isRunning()) {
            ctx.ui.notify("Gateway already running", "info");
            return;
          }

          try {
            const port = parseInt(parts[1]) || undefined;
            await startGatewayWithRecovery(port, ctx);
          } catch (err) {
            updateStatus();
            await handleGatewayStartError(err, ctx);
          }
          return;
        }

        case "stop": {
          if (!isRunning()) {
            ctx.ui.notify("Gateway not running", "info");
            return;
          }
          await stopGateway();
          updateStatus();
          ctx.ui.notify("Gateway stopped", "info");
          return;
        }

        case "restart": {
          try {
            await stopGateway();
            const status = await startGateway({ noAgent: false });
            updateStatus();
            ctx.ui.notify(`✅ Gateway restarted on port ${status.port}`, "info");
          } catch (err) {
            updateStatus();
            await handleGatewayStartError(err, ctx);
          }
          return;
        }

        case "status": {
          const status = getStatus();
          const cfg = getConfig();
          const lines: string[] = [
            `Status: ${status.running ? "🟢 Running" : "🔴 Stopped"}`,
            `Port: ${status.port}`,
            `Adapters: ${status.adapters.length}`,
            `Clients: ${status.clientCount}`,
            `Sessions: ${status.sessionCount}`,
            `Agent: ${status.agentConnected ? "✅ Connected" : "❌ Disconnected"}`,
            "",
            `Session Reset: ${cfg.sessions.resetPolicy}`,
            `  - Daily at ${cfg.sessions.dailyHour}:00`,
            `  - Idle after ${cfg.sessions.idleMinutes} min`,
            "",
            `Security: ${cfg.security.allowAll ? "Allow all" : "Allowlist only"}`,
          ];

          ctx.ui.setWidget("gateway-status", lines, { placement: "belowEditor" });
          setTimeout(() => ctx.ui.setWidget("gateway-status", undefined), 15000);
          return;
        }

        case "pair": {
          const code = parts[1]?.toUpperCase();
          if (!code) {
            const pending = await listPendingPairingCodes();
            ctx.ui.notify(
              "Pending pairing codes:\n" +
              (pending.length > 0
                ? pending.map(p => `${p.code} - ${p.platform} (${Math.round(p.expiresIn / 60000)}min)`).join("\n")
                : "None"),
              "info"
            );
            return;
          }

          if (await approvePairingCode(code)) {
            ctx.ui.notify("Pairing code approved", "info");
          } else {
            ctx.ui.notify("❌ Invalid or expired pairing code", "error");
          }
          return;
        }

        case "allow": {
          const platform = parts[1] as Platform;
          const userId = parts[2];
          if (!platform || !userId) {
            const list = await listAllowlistedUsers();
            ctx.ui.notify(
              "Allowlisted users:\n" +
              (list.length > 0
                ? list.map(u => `${u.platform}:${u.userId}`).join("\n")
                : "None"),
              "info"
            );
            return;
          }

          await addToAllowlist(platform, userId);
          ctx.ui.notify(`Added ${userId} to allowlist`, "info");
          return;
        }

        case "sessions": {
          const sessions = await listSessions();
          ctx.ui.notify(
            "Active sessions:\n" +
            sessions.slice(0, 10).map(s =>
              `${s.platform}:${s.channelId} (${s.id.slice(0, 8)}...)`
            ).join("\n"),
            "info"
          );
          return;
        }

        case "tasks": {
          const tasks = await listTasks();
          ctx.ui.notify(
            "Background tasks:\n" +
            tasks.slice(0, 10).map(t =>
              `${t.id.slice(0, 12)}... - ${t.status} (${t.progress}%)`
            ).join("\n"),
            "info"
          );
          return;
        }

        case "config": {
          const cfg = getConfig();
          ctx.ui.notify(
            `Gateway Config:\n\n` +
            `Port: ${cfg.port}\n` +
            `Sessions: ${cfg.sessions.resetPolicy}\n` +
            `Security: ${cfg.security.allowAll ? "Allow all" : "Allowlist"}\n` +
            `Discord: ${cfg.platforms.discord?.enabled ? "Enabled" : "Disabled"}`,
            "info"
          );
          return;
        }

        default: {
          ctx.ui.notify(
            "pi Gateway Commands:\n\n" +
            "  /gateway start [port]  - Start gateway\n" +
            "  /gateway stop         - Stop gateway\n" +
            "  /gateway restart      - Restart gateway\n" +
            "  /gateway status       - Show status\n" +
            "  /gateway pair <code>  - Approve pairing\n" +
            "  /gateway allow <p> <u>- Add user to allowlist\n" +
            "  /gateway sessions     - List sessions\n" +
            "  /gateway tasks        - List background tasks\n" +
            "  /gateway config       - Show config\n\n" +
            "Hermes-style features:\n" +
            "  - Per-chat sessions with reset policies\n" +
            "  - Platform adapters (Discord, etc.)\n" +
            "  - Background task support\n" +
            "  - Allowlist security",
            "info"
          );
        }
      }
    },
  });

  // Register tools
  pi.registerTool({
    name: "gateway_status",
    label: "Gateway Status",
    description: "Check Hermes-style gateway status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const status = getStatus();
      return {
        content: [{
          type: "text",
          text: `Gateway: ${status.running ? "Running" : "Stopped"}\n` +
                `Adapters: ${status.adapters.length}\n` +
                `Clients: ${status.clientCount}\n` +
                `Sessions: ${status.sessionCount}\n` +
                `Agent: ${status.agentConnected ? "Connected" : "Disconnected"}`,
        }],
        details: {
          running: status.running,
          adapters: status.adapters.length,
          clients: status.clientCount,
          sessions: status.sessionCount,
        },
      };
    },
  });

  pi.registerTool({
    name: "gateway_sessions",
    label: "Gateway Sessions",
    description: "List active gateway sessions",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const sessions = await listSessions();
      return {
        content: [{
          type: "text",
          text: `Active sessions: ${sessions.length}\n` +
                JSON.stringify(sessions.map(s => ({
                  id: s.id.slice(0, 12),
                  platform: s.platform,
                  channel: s.channelId,
                  lastActivity: new Date(s.lastActivity).toISOString(),
                })), null, 2),
        }],
        details: { count: sessions.length },
      };
    },
  });

  pi.registerTool({
    name: "gateway_background_tasks",
    label: "Background Tasks",
    description: "List and manage background tasks",
    parameters: Type.Object({
      status: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const tasks = await listTasks(params.status as any);
      return {
        content: [{
          type: "text",
          text: `Background tasks: ${tasks.length}\n` +
                JSON.stringify(tasks.map(t => ({
                  id: t.id.slice(0, 12),
                  status: t.status,
                  progress: t.progress,
                  command: t.command.slice(0, 50),
                })), null, 2),
        }],
        details: { count: tasks.length },
      };
    },
  });

  pi.registerTool({
    name: "gateway_pairing",
    label: "Gateway Pairing",
    description: "Generate or approve pairing codes",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("generate"), Type.Literal("list"), Type.Literal("approve")]),
      platform: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      code: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action, platform, userId, code } = params;
      switch (action) {
        case "generate": {
          if (!platform || !userId) {
            return { content: [{ type: "text", text: "platform and userId required" }], details: { error: true } };
          }
          const pairingCode = await generatePairingCode(platform as Platform, userId);
          return {
            content: [{
              type: "text",
              text: `Pairing code: ${pairingCode}\n\nShare this code with the user to approve access.`,
            }],
            details: { code: pairingCode },
          };
        }
        case "approve": {
          if (!code) {
            return { content: [{ type: "text", text: "code required" }], details: { error: true } };
          }
          const success = await approvePairingCode(code);
          return {
            content: [{ type: "text", text: success ? "✅ Code approved" : "❌ Invalid/expired" }],
            details: { success },
          };
        }
        case "list": {
          const pending = await listPendingPairingCodes();
          return {
            content: [{
              type: "text",
              text: `Pending codes: ${pending.length}\n` + JSON.stringify(pending, null, 2),
            }],
            details: { count: pending.length },
          };
        }
      }
    },
  });

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    globalCtx = ctx;
    updateStatus();
  });

  // Re-export programmatic API so extension consumers can import from here too
  console.log("[pi-gateway] Hermes-style gateway extension loaded");
}

// Re-export programmatic API for direct import
export { startGateway, stopGateway, isGatewayRunning, getStatus, getConfig, isRunning, getAdapter, getAdapters, sendMessage, attachToExistingGateway, broadcast } from "./api.js";
export type { GatewayConfig, GatewayStatus, StartGatewayOptions } from "./api.js";