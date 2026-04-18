/**
 * pi-gateway Programmatic API
 *
 * Allows starting/stopping the gateway from outside a pi session.
 * Used by src/index.ts to auto-start the gateway at boot.
 *
 * When pi-gateway is also loaded as a pi extension (via pi-kobold),
 * the extension factory attaches to the already-running instance.
 */
import { BaseAdapter } from "./adapters/base.js";
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
    };
    platforms: {
        discord?: {
            enabled: boolean;
            botToken: string;
            guildId?: string;
        };
        twitch?: {
            enabled: boolean;
            clientId: string;
            clientSecret: string;
            channels?: string[];
        };
        telegram?: {
            enabled: boolean;
            token: string;
            mode?: "polling" | "webhook";
            webhookUrl?: string;
        };
        slack?: {
            enabled: boolean;
            webhookUrl?: string;
            botToken?: string;
        };
        whatsapp?: {
            enabled: boolean;
            sessionPath?: string;
            printQr?: boolean;
        };
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
/**
 * Start the gateway server programmatically.
 *
 * Call this from src/index.ts or any boot code.
 * When pi-gateway also loads as a pi extension, it will detect
 * the already-running instance and attach to it.
 */
export declare function startGateway(opts?: StartGatewayOptions): Promise<GatewayStatus>;
/**
 * Stop the gateway server.
 */
export declare function stopGateway(): Promise<void>;
/**
 * Check if the gateway is already running on a given port.
 * Useful for detecting an existing instance at boot.
 */
export declare function isGatewayRunning(port?: number): Promise<boolean>;
/**
 * Get the current gateway status.
 */
export declare function getStatus(): GatewayStatus;
/**
 * Get the current gateway config.
 */
export declare function getConfig(): GatewayConfig;
/**
 * Check if the gateway is running.
 */
export declare function isRunning(): boolean;
/**
 * Get the adapter for a platform, if running.
 */
export declare function getAdapter(platform: string): BaseAdapter | undefined;
/**
 * Get all active adapters.
 */
export declare function getAdapters(): Map<string, BaseAdapter>;
/**
 * Send a message through a platform adapter.
 */
export declare function sendMessage(platform: string, channelId: string, content: string): Promise<boolean>;
/**
 * Attach to an already-running gateway without owning its process.
 */
export declare function attachToExistingGateway(port?: number, host?: string): Promise<GatewayStatus>;
/**
 * Broadcast a message to all connected WebSocket clients.
 */
export declare function broadcast(event: string, data: unknown): void;
