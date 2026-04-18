/**
 * WebSocket Adapter - For web clients and other WebSocket-based platforms
 */
import { BaseAdapter } from "./base.js";
export class WebSocketAdapter extends BaseAdapter {
    platform = "websocket";
    config;
    client = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 5;
    reconnectDelay = 1000;
    constructor(config) {
        super();
        this.config = config;
    }
    async initialize() {
        console.log(`[WebSocket] Adapter initialized for client ${this.config.clientId}`);
    }
    async start(callbacks) {
        await super.start(callbacks);
        // For server-side: this would be handled by the main gateway
        // This adapter is more for client-side connections
    }
    async connect(url, token) {
        return new Promise((resolve, reject) => {
            const headers = {};
            if (token) {
                headers["Authorization"] = `Bearer ${token}`;
            }
            this.client = new WebSocket(url, { headers });
            this.client.onopen = () => {
                console.log(`[WebSocket] Connected to ${url}`);
                this.reconnectAttempts = 0;
                resolve();
            };
            this.client.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "message") {
                        const message = {
                            id: this.generateMessageId(),
                            platform: this.platform,
                            channelId: this.config.clientId,
                            userId: this.config.clientId,
                            content: data.content,
                            timestamp: Date.now(),
                            metadata: data.metadata,
                        };
                        this.emitMessage(message);
                    }
                }
                catch (err) {
                    console.error("[WebSocket] Failed to parse message:", err);
                }
            };
            this.client.onclose = () => {
                console.log("[WebSocket] Connection closed");
                this.callbacks?.onDisconnect?.();
                this.attemptReconnect(url, token);
            };
            this.client.onerror = (err) => {
                console.error("[WebSocket] Error:", err);
                reject(err);
            };
        });
    }
    attemptReconnect(url, token) {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(url, token), delay);
        }
    }
    async sendMessage(channelId, content) {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }
        const id = this.generateMessageId();
        this.client.send(JSON.stringify({
            type: "message",
            id,
            content,
            channelId,
        }));
        return id;
    }
    async editMessage(channelId, messageId, content) {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }
        this.client.send(JSON.stringify({
            type: "edit",
            id: messageId,
            content,
            channelId,
        }));
    }
    async deleteMessage(channelId, messageId) {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }
        this.client.send(JSON.stringify({
            type: "delete",
            id: messageId,
            channelId,
        }));
    }
    async setTyping(channelId, isTyping) {
        if (!this.client || this.client.readyState !== WebSocket.OPEN)
            return;
        this.client.send(JSON.stringify({
            type: "typing",
            channelId,
            isTyping,
        }));
    }
    async getStatus() {
        return {
            connected: this.client?.readyState === WebSocket.OPEN,
        };
    }
    async stop() {
        if (this.client) {
            this.client.close();
            this.client = null;
        }
        await super.stop();
    }
}
