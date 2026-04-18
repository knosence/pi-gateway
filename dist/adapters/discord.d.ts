/**
 * Discord Adapter - Hermes-style Discord platform adapter
 *
 * Features:
 * - DM and guild channel support
 * - Slash command registration
 * - Typing indicators
 * - Message editing/deletion
 * - Rate limit handling
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
export interface DiscordConfig extends PlatformConfig {
    platform: "discord";
    botToken: string;
    guildId?: string;
    allowedChannels?: string[];
    allowedRoles?: string[];
    requireMention?: boolean;
}
export declare class DiscordAdapter extends BaseAdapter {
    readonly platform: "discord";
    config: DiscordConfig;
    private httpClient;
    private wsConnection;
    private heartbeatInterval;
    private sequence;
    private sessionId;
    private intents;
    constructor(config: DiscordConfig);
    initialize(): Promise<void>;
    private apiRequest;
    start(callbacks: any): Promise<void>;
    private handleGatewayMessage;
    private startHeartbeat;
    private identify;
    private handleDispatch;
    private handleMessage;
    private getBotId;
    sendMessage(channelId: string, content: string): Promise<string>;
    editMessage(channelId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    stop(): Promise<void>;
    registerSlashCommands(commands: Array<{
        name: string;
        description: string;
        options?: any[];
    }>): Promise<void>;
}
