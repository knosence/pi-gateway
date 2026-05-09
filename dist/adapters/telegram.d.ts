/**
 * Telegram Adapter - Hermes-style Telegram platform adapter
 *
 * Features:
 * - Polling and webhook modes
 * - DM and group chat support
 * - Inline queries
 * - Callback buttons
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
interface TelegramConfig extends PlatformConfig {
    platform: "telegram";
    token: string;
    mode?: "polling" | "webhook";
    webhookUrl?: string;
    webhookSecret?: string;
    allowedChats?: string[];
    requireUsername?: boolean;
}
export type { TelegramConfig };
export declare class TelegramAdapter extends BaseAdapter {
    readonly platform: "telegram";
    config: TelegramConfig;
    private bot;
    private offset;
    private pollingInterval;
    private connected;
    private typingIntervals;
    constructor(config: TelegramConfig);
    initialize(): Promise<void>;
    private apiRequest;
    start(callbacks: any): Promise<void>;
    private startPolling;
    private poll;
    private handleUpdate;
    private sleep;
    stop(): Promise<void>;
    private splitMessage;
    private sendSingleMessage;
    sendMessage(channelId: string, content: string): Promise<string>;
    sendPhoto(channelId: string, photoUrl: string, caption?: string): Promise<string>;
    sendButtons(channelId: string, text: string, buttons: Array<Array<{
        text: string;
        data: string;
    }>>): Promise<string>;
    editMessage(channelId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    private sendTypingAction;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    getMe(): Promise<{
        id: number;
        username: string;
        first_name: string;
    }>;
    handleWebhookUpdate(update: any): Promise<void>;
}
