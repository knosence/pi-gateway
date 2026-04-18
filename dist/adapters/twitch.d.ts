/**
 * Twitch Adapter - Hermes-style Twitch platform adapter
 *
 * Features:
 * - Helix API integration
 * - EventSub WebSocket for real-time events
 * - Stream notifications (live/offline)
 * - Chat settings and moderation
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
export interface TwitchConfig extends PlatformConfig {
    platform: "twitch";
    clientId: string;
    clientSecret: string;
    channels?: string[];
    events?: string[];
}
interface TwitchStream {
    id: string;
    user_id: string;
    user_login: string;
    user_name: string;
    game_name: string;
    title: string;
    viewer_count: number;
    started_at: string;
}
export declare class TwitchAdapter extends BaseAdapter {
    readonly platform: "twitch";
    config: TwitchConfig;
    private token;
    private tokenExpiry;
    private eventsubWs;
    private eventsubSessionId;
    private subscribedChannels;
    private streamStatus;
    constructor(config: TwitchConfig);
    initialize(): Promise<void>;
    private authenticate;
    private getAccessToken;
    private getHeaders;
    start(callbacks: any): Promise<void>;
    private connectEventSub;
    private handleEventSubMessage;
    private subscribeToChannel;
    stop(): Promise<void>;
    sendMessage(channelId: string, content: string): Promise<string>;
    editMessage(channelId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    getStream(broadcaster: string): Promise<TwitchStream | null>;
    getUser(login: string): Promise<{
        id: string;
        login: string;
        display_name: string;
    } | null>;
    createClip(broadcaster: string): Promise<{
        url: string;
        title: string;
    }>;
    getChatSettings(broadcasterId: string): Promise<{
        slow: number;
        follower_delay: number;
        subscriber: boolean;
        emote_mode: boolean;
    }>;
    getModerators(broadcasterId: string): Promise<string[]>;
    getMonitoredChannels(): string[];
    isChannelLive(channel: string): boolean;
}
export {};
