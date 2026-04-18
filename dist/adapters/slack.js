/**
 * Slack Adapter - Hermes-style Slack platform adapter
 *
 * Features:
 * - Incoming webhooks (outbound only)
 * - Web API (with bot token)
 * - Slash command support
 * - Block Kit support
 */
import { BaseAdapter } from "./base.js";
export class SlackAdapter extends BaseAdapter {
    platform = "slack";
    config;
    connected = false;
    constructor(config) {
        super();
        this.config = {
            enabled: true,
            platform: "slack",
            ...config,
        };
    }
    async initialize() {
        if (this.config.botToken) {
            // Test bot token
            const response = await this.apiRequest("auth.test", { method: "POST" });
            const data = await response.json();
            if (!data.ok) {
                throw new Error(`Slack auth failed: ${data}`);
            }
            console.log(`[Slack] Bot initialized for team: ${data.team_id}`);
        }
        else if (this.config.webhookUrl) {
            console.log("[Slack] Using webhook mode (outbound only)");
        }
        else {
            throw new Error("Slack requires either botToken or webhookUrl");
        }
    }
    async apiRequest(endpoint, options = {}) {
        const url = `https://slack.com/api/${endpoint}`;
        return fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.config.botToken}`,
                ...options.headers,
            },
        });
    }
    async start(callbacks) {
        await super.start(callbacks);
        this.connected = true;
        if (!this.config.botToken && !this.config.webhookUrl) {
            console.warn("[Slack] No credentials configured - adapter is outbound-only");
        }
    }
    async stop() {
        this.connected = false;
        await super.stop();
    }
    async sendMessage(channelId, content) {
        // Try webhook first if available
        if (this.config.webhookUrl) {
            const payload = {
                text: content,
                ...(channelId && channelId.startsWith("#") ? { channel: channelId } : {}),
            };
            const response = await fetch(this.config.webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Slack webhook failed: ${response.status}`);
            }
            return `webhook-${Date.now()}`;
        }
        // Use Web API if we have a bot token
        if (this.config.botToken) {
            const response = await this.apiRequest("chat.postMessage", {
                method: "POST",
                body: JSON.stringify({
                    channel: channelId,
                    text: content,
                }),
            });
            const data = await response.json();
            if (!data.ok) {
                throw new Error(`Slack API error: ${data.error}`);
            }
            return data.ts || String(Date.now());
        }
        throw new Error("No Slack credentials configured");
    }
    async postMessage(channelId, content, blocks) {
        if (!this.config.botToken) {
            throw new Error("Bot token required for rich messages");
        }
        const body = {
            channel: channelId,
            text: content,
        };
        if (blocks) {
            body.blocks = blocks;
        }
        const response = await this.apiRequest("chat.postMessage", {
            method: "POST",
            body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
        }
        return data.ts || String(Date.now());
    }
    async replyToThread(channelId, threadTs, content) {
        if (!this.config.botToken) {
            throw new Error("Bot token required for threaded replies");
        }
        const response = await this.apiRequest("chat.postMessage", {
            method: "POST",
            body: JSON.stringify({
                channel: channelId,
                text: content,
                thread_ts: threadTs,
            }),
        });
        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
        }
        return data.ts || String(Date.now());
    }
    async editMessage(channelId, messageTs, content) {
        if (!this.config.botToken) {
            throw new Error("Bot token required for editing");
        }
        await this.apiRequest("chat.update", {
            method: "POST",
            body: JSON.stringify({
                channel: channelId,
                ts: messageTs,
                text: content,
            }),
        });
    }
    async deleteMessage(channelId, messageTs) {
        if (!this.config.botToken) {
            throw new Error("Bot token required for deletion");
        }
        await this.apiRequest("chat.delete", {
            method: "POST",
            body: JSON.stringify({
                channel: channelId,
                ts: messageTs,
            }),
        });
    }
    async setTyping(channelId, isTyping) {
        if (!this.config.botToken)
            return;
        await this.apiRequest("chat.postEphemeral", {
            method: "POST",
            body: JSON.stringify({
                channel: channelId,
                text: isTyping ? "_typing_" : "",
            }),
        });
    }
    async getChannelInfo(channelId) {
        if (!this.config.botToken) {
            throw new Error("Bot token required");
        }
        const response = await this.apiRequest("conversations.info", {
            method: "POST",
            body: JSON.stringify({ channel: channelId }),
        });
        const data = await response.json();
        if (!data.ok || !data.channel) {
            return null;
        }
        return {
            id: data.channel.id,
            name: data.channel.name,
            numMembers: data.channel.num_members,
            topic: data.channel.topic?.value || "",
        };
    }
    async listChannels() {
        if (!this.config.botToken) {
            throw new Error("Bot token required");
        }
        const response = await this.apiRequest("conversations.list", {
            method: "POST",
            body: JSON.stringify({ types: "public_channel,private_channel" }),
        });
        const data = await response.json();
        if (!data.ok) {
            return [];
        }
        return (data.channels || []).map(c => ({ id: c.id, name: c.name }));
    }
    async getStatus() {
        return {
            connected: this.connected,
            ...(this.config.botToken ? { mode: "api" } : { mode: "webhook" })
        };
    }
    // Handle incoming events (for WebSocket or Socket Mode)
    async handleIncomingEvent(event) {
        if (event.type === "message" && !event.subtype) {
            const message = {
                id: this.generateMessageId(),
                platform: "slack",
                channelId: event.channel,
                userId: event.user,
                content: event.text,
                timestamp: parseFloat(event.ts) * 1000,
                metadata: {
                    team: event.team,
                    threadTs: event.thread_ts,
                    username: event.username,
                },
            };
            this.emitMessage(message);
        }
    }
}
