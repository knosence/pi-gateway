/**
 * WebSocket Adapter - For web clients and other WebSocket-based platforms
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
export interface WebSocketConfig extends PlatformConfig {
    platform: "websocket";
    clientId: string;
}
export declare class WebSocketAdapter extends BaseAdapter {
    readonly platform: "websocket";
    config: WebSocketConfig;
    private client;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectDelay;
    constructor(config: WebSocketConfig);
    initialize(): Promise<void>;
    start(callbacks: any): Promise<void>;
    connect(url: string, token?: string): Promise<void>;
    private attemptReconnect;
    sendMessage(channelId: string, content: string): Promise<string>;
    editMessage(channelId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    stop(): Promise<void>;
}
