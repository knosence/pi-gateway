/**
 * Slack Adapter - Hermes-style Slack platform adapter
 *
 * Features:
 * - Incoming webhooks (outbound only)
 * - Web API (with bot token)
 * - Slash command support
 * - Block Kit support
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
export interface SlackConfig extends PlatformConfig {
    platform: "slack";
    webhookUrl?: string;
    botToken?: string;
    signingSecret?: string;
    teamId?: string;
    defaultChannel?: string;
}
export declare class SlackAdapter extends BaseAdapter {
    readonly platform: "slack";
    config: SlackConfig;
    private connected;
    constructor(config: SlackConfig);
    initialize(): Promise<void>;
    private apiRequest;
    start(callbacks: any): Promise<void>;
    stop(): Promise<void>;
    sendMessage(channelId: string, content: string): Promise<string>;
    postMessage(channelId: string, content: string, blocks?: any[]): Promise<string>;
    replyToThread(channelId: string, threadTs: string, content: string): Promise<string>;
    editMessage(channelId: string, messageTs: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageTs: string): Promise<void>;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getChannelInfo(channelId: string): Promise<{
        id: string;
        name: string;
        numMembers: number;
        topic: string;
    } | null>;
    listChannels(): Promise<Array<{
        id: string;
        name: string;
    }>>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    handleIncomingEvent(event: any): Promise<void>;
}
