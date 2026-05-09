/**
 * Telegram Adapter - Hermes-style Telegram platform adapter
 *
 * Features:
 * - Polling and webhook modes
 * - DM and group chat support
 * - Inline queries
 * - Callback buttons
 */
import { setDefaultResultOrder } from "node:dns";
import { Agent } from "undici";
import { BaseAdapter } from "./base.js";
setDefaultResultOrder("ipv4first");
const TELEGRAM_IPV4_AGENT = new Agent({ connect: { family: 4 } });
export class TelegramAdapter extends BaseAdapter {
    platform = "telegram";
    config;
    bot = null;
    offset = 0;
    pollingInterval = null;
    connected = false;
    typingIntervals = new Map();
    constructor(config) {
        super();
        this.config = {
            enabled: true,
            platform: "telegram",
            mode: "polling",
            ...config,
        };
    }
    async initialize() {
        // Test bot token
        const response = await this.apiRequest("/getMe");
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(`Telegram auth failed: ${response.status}`);
        }
        console.log(`[Telegram] Bot initialized: @${data.result?.username}`);
        // Set webhook if configured
        if (this.config.mode === "webhook" && this.config.webhookUrl) {
            await this.apiRequest("/setWebhook", {
                method: "POST",
                body: JSON.stringify({ url: this.config.webhookUrl }),
            });
            console.log(`[Telegram] Webhook set: ${this.config.webhookUrl}`);
        }
        // Clear webhook when using polling to avoid getUpdates conflicts
        if (this.config.mode === "polling") {
            try {
                await this.apiRequest("/deleteWebhook", {
                    method: "POST",
                    body: JSON.stringify({ drop_pending_updates: false }),
                });
            }
            catch (err) {
                console.warn("[Telegram] Failed to clear webhook before polling:", err);
            }
        }
    }
    async apiRequest(endpoint, options = {}) {
        const url = `https://api.telegram.org/bot${this.config.token}${endpoint}`;
        const controller = new AbortController();
        const timeoutMs = endpoint === "/getUpdates" ? 45000 : 20000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                ...options,
                // Force IPv4 to avoid broken IPv6 routes timing out to api.telegram.org
                dispatcher: TELEGRAM_IPV4_AGENT,
                signal: options.signal ?? controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    ...options.headers,
                },
            });
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async start(callbacks) {
        await super.start(callbacks);
        if (this.config.mode === "polling") {
            await this.startPolling();
        }
        // Webhook mode is handled externally via HTTP server
    }
    async startPolling() {
        this.connected = true;
        this.poll();
    }
    async poll() {
        while (this.connected && this.config.mode === "polling") {
            try {
                const response = await this.apiRequest("/getUpdates", {
                    method: "POST",
                    body: JSON.stringify({
                        offset: this.offset,
                        timeout: 30,
                    }),
                });
                if (!response.ok) {
                    console.error(`[Telegram] Poll error: ${response.status}`);
                    await this.sleep(5000);
                    continue;
                }
                const data = await response.json();
                if (!data.ok) {
                    console.error(`[Telegram] Poll API error: ${data.description || "unknown error"}`);
                    await this.sleep(5000);
                    continue;
                }
                if (data.result && data.result.length > 0) {
                    for (const update of data.result) {
                        await this.handleUpdate(update);
                        this.offset = update.update_id + 1;
                    }
                }
            }
            catch (err) {
                console.error("[Telegram] Poll exception:", err);
                await this.sleep(5000);
            }
        }
    }
    async handleUpdate(update) {
        // Handle messages
        if (update.message || update.edited_message) {
            const msg = update.message || update.edited_message;
            // Check if chat is allowed
            if (this.config.allowedChats && !this.config.allowedChats.includes(String(msg.chat.id))) {
                return;
            }
            // Check if username is required
            if (this.config.requireUsername && !msg.from?.username) {
                // Could send "Please set a username" message here
                return;
            }
            const content = msg.text || msg.caption || "";
            // Skip empty messages
            if (!content)
                return;
            const message = {
                id: this.generateMessageId(),
                platform: "telegram",
                channelId: String(msg.chat.id),
                userId: String(msg.from?.id || 0),
                content,
                timestamp: msg.date * 1000,
                metadata: {
                    username: msg.from?.username,
                    firstName: msg.from?.first_name,
                    chatType: msg.chat.type,
                    chatTitle: msg.chat.title,
                    isEdited: !!update.edited_message,
                },
            };
            this.emitMessage(message);
        }
        // Handle callback queries (button presses)
        if (update.callback_query) {
            const query = update.callback_query;
            const message = {
                id: this.generateMessageId(),
                platform: "telegram",
                channelId: String(query.message?.chat.id || query.from.id),
                userId: String(query.from.id),
                content: `Callback: ${query.data}`,
                timestamp: query.message?.date ? query.message.date * 1000 : Date.now(),
                metadata: {
                    callbackId: query.id,
                    callbackData: query.data,
                    username: query.from.username,
                },
            };
            this.emitMessage(message);
            // Answer callback to remove loading state
            await this.apiRequest("/answerCallbackQuery", {
                method: "POST",
                body: JSON.stringify({ callback_query_id: query.id }),
            });
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async stop() {
        this.connected = false;
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        for (const interval of this.typingIntervals.values()) {
            clearInterval(interval);
        }
        this.typingIntervals.clear();
        await super.stop();
    }
    splitMessage(content, maxLength = 3500) {
        const text = content.trim();
        if (!text)
            return [""];
        if (text.length <= maxLength)
            return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > maxLength) {
            let splitAt = remaining.lastIndexOf("\n\n", maxLength);
            if (splitAt < maxLength * 0.5)
                splitAt = remaining.lastIndexOf("\n", maxLength);
            if (splitAt < maxLength * 0.5)
                splitAt = remaining.lastIndexOf(" ", maxLength);
            if (splitAt < maxLength * 0.5)
                splitAt = maxLength;
            chunks.push(remaining.slice(0, splitAt).trim());
            remaining = remaining.slice(splitAt).trim();
        }
        if (remaining)
            chunks.push(remaining);
        return chunks.filter(Boolean);
    }
    async sendSingleMessage(channelId, content) {
        let response = await this.apiRequest("/sendMessage", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                text: content,
                parse_mode: "HTML",
            }),
        });
        let data = await response.json();
        if (!data.ok) {
            console.warn(`[Telegram] HTML send failed, retrying as plain text: ${data.description || "unknown error"}`);
            response = await this.apiRequest("/sendMessage", {
                method: "POST",
                body: JSON.stringify({
                    chat_id: channelId,
                    text: content,
                }),
            });
            data = await response.json();
        }
        if (!data.ok) {
            throw new Error(`Failed to send message (${response.status}): ${data.description || "unknown error"}`);
        }
        return String(data.result?.message_id || 0);
    }
    async sendMessage(channelId, content) {
        const chunks = this.splitMessage(content);
        let lastMessageId = "0";
        for (const chunk of chunks) {
            lastMessageId = await this.sendSingleMessage(channelId, chunk);
        }
        return lastMessageId;
    }
    async sendPhoto(channelId, photoUrl, caption) {
        const response = await this.apiRequest("/sendPhoto", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                photo: photoUrl,
                caption,
                parse_mode: "HTML",
            }),
        });
        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Failed to send photo: ${data}`);
        }
        return String(data.result?.message_id || 0);
    }
    async sendButtons(channelId, text, buttons) {
        const replyMarkup = {
            inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))),
        };
        const response = await this.apiRequest("/sendMessage", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                text,
                parse_mode: "HTML",
                reply_markup: replyMarkup,
            }),
        });
        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Failed to send buttons: ${data}`);
        }
        return String(data.result?.message_id || 0);
    }
    async editMessage(channelId, messageId, content) {
        let response = await this.apiRequest("/editMessageText", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                message_id: parseInt(messageId),
                text: content,
                parse_mode: "HTML",
            }),
        });
        let data = await response.json();
        if (!data.ok) {
            console.warn(`[Telegram] HTML edit failed, retrying as plain text: ${data.description || "unknown error"}`);
            response = await this.apiRequest("/editMessageText", {
                method: "POST",
                body: JSON.stringify({
                    chat_id: channelId,
                    message_id: parseInt(messageId),
                    text: content,
                }),
            });
            data = await response.json();
        }
        if (!data.ok) {
            throw new Error(`Failed to edit message (${response.status}): ${data.description || "unknown error"}`);
        }
    }
    async deleteMessage(channelId, messageId) {
        await this.apiRequest("/deleteMessage", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                message_id: parseInt(messageId),
            }),
        });
    }
    async sendTypingAction(channelId) {
        const response = await this.apiRequest("/sendChatAction", {
            method: "POST",
            body: JSON.stringify({
                chat_id: channelId,
                action: "typing",
            }),
        });
        const data = await response.json();
        if (!response.ok || !data?.ok) {
            throw new Error(`Failed to send typing action: ${data?.description || response.statusText || response.status}`);
        }
    }
    async setTyping(channelId, isTyping) {
        const existing = this.typingIntervals.get(channelId);
        if (!isTyping) {
            if (existing) {
                clearInterval(existing);
                this.typingIntervals.delete(channelId);
            }
            return;
        }
        if (existing)
            return;
        await this.sendTypingAction(channelId);
        const interval = setInterval(() => {
            void this.sendTypingAction(channelId).catch(err => {
                console.error(`[Telegram] Failed to refresh typing for ${channelId}:`, err);
            });
        }, 4000);
        this.typingIntervals.set(channelId, interval);
    }
    async getStatus() {
        return { connected: this.connected };
    }
    async getMe() {
        const response = await this.apiRequest("/getMe");
        const data = await response.json();
        return data.result;
    }
    // Handle webhook update (called from HTTP handler)
    async handleWebhookUpdate(update) {
        if (this.config.webhookSecret) {
            // Verify secret here
        }
        await this.handleUpdate(update);
    }
}
//# sourceMappingURL=telegram.js.map