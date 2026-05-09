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
import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";

setDefaultResultOrder("ipv4first");
const TELEGRAM_IPV4_AGENT = new Agent({ connect: { family: 4 } });

interface TelegramConfig extends PlatformConfig {
  platform: "telegram";
  token: string;
  mode?: "polling" | "webhook";
  webhookUrl?: string;
  webhookSecret?: string;
  allowedChats?: string[];  // Whitelist chat IDs
  requireUsername?: boolean; // Require user to have a username
}

export type { TelegramConfig };

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  date: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string };
    message?: { date?: number; chat?: { id: number } };
  };
}

export class TelegramAdapter extends BaseAdapter {
  readonly platform = "telegram" as const;
  config: TelegramConfig;
  
  private bot: any = null;
  private offset = 0;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: TelegramConfig) {
    super();
    this.config = {
      enabled: true,
      platform: "telegram",
      mode: "polling",
      ...config,
    };
  }

  async initialize(): Promise<void> {
    // Test bot token
    const response = await this.apiRequest("/getMe");
    const data = await response.json() as { ok: boolean; result?: { id: number; username: string; first_name: string } };
    
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
      } catch (err) {
        console.warn("[Telegram] Failed to clear webhook before polling:", err);
      }
    }
  }

  private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
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
    } finally {
      clearTimeout(timeout);
    }
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);

    if (this.config.mode === "polling") {
      await this.startPolling();
    }
    // Webhook mode is handled externally via HTTP server
  }

  private async startPolling(): Promise<void> {
    this.connected = true;
    this.poll();
  }

  private async poll(): Promise<void> {
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

        const data = await response.json() as { ok: boolean; result?: TelegramUpdate[]; description?: string };

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
      } catch (err) {
        console.error("[Telegram] Poll exception:", err);
        await this.sleep(5000);
      }
    }
  }

  private async handleUpdate(update: any): Promise<void> {
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
      if (!content) return;

      const message: PlatformMessage = {
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
      
      const message: PlatformMessage = {
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
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

  private splitMessage(content: string, maxLength = 3500): string[] {
    const text = content.trim();
    if (!text) return [""];
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      let splitAt = remaining.lastIndexOf("\n\n", maxLength);
      if (splitAt < maxLength * 0.5) splitAt = remaining.lastIndexOf("\n", maxLength);
      if (splitAt < maxLength * 0.5) splitAt = remaining.lastIndexOf(" ", maxLength);
      if (splitAt < maxLength * 0.5) splitAt = maxLength;

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks.filter(Boolean);
  }

  private async sendSingleMessage(channelId: string, content: string): Promise<string> {
    let response = await this.apiRequest("/sendMessage", {
      method: "POST",
      body: JSON.stringify({
        chat_id: channelId,
        text: content,
        parse_mode: "HTML",
      }),
    });

    let data = await response.json() as { ok: boolean; description?: string; result?: { message_id: number } };

    if (!data.ok) {
      console.warn(`[Telegram] HTML send failed, retrying as plain text: ${data.description || "unknown error"}`);
      response = await this.apiRequest("/sendMessage", {
        method: "POST",
        body: JSON.stringify({
          chat_id: channelId,
          text: content,
        }),
      });
      data = await response.json() as { ok: boolean; description?: string; result?: { message_id: number } };
    }

    if (!data.ok) {
      throw new Error(`Failed to send message (${response.status}): ${data.description || "unknown error"}`);
    }

    return String(data.result?.message_id || 0);
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    const chunks = this.splitMessage(content);
    let lastMessageId = "0";

    for (const chunk of chunks) {
      lastMessageId = await this.sendSingleMessage(channelId, chunk);
    }

    return lastMessageId;
  }

  async sendPhoto(channelId: string, photoUrl: string, caption?: string): Promise<string> {
    const response = await this.apiRequest("/sendPhoto", {
      method: "POST",
      body: JSON.stringify({
        chat_id: channelId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });

    const data = await response.json() as { ok: boolean; result?: { message_id: number } };

    if (!data.ok) {
      throw new Error(`Failed to send photo: ${data}`);
    }

    return String(data.result?.message_id || 0);
  }

  async sendButtons(channelId: string, text: string, buttons: Array<Array<{ text: string; data: string }>>): Promise<string> {
    const replyMarkup = {
      inline_keyboard: buttons.map(row =>
        row.map(btn => ({ text: btn.text, callback_data: btn.data }))
      ),
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

    const data = await response.json() as { ok: boolean; result?: { message_id: number } };

    if (!data.ok) {
      throw new Error(`Failed to send buttons: ${data}`);
    }

    return String(data.result?.message_id || 0);
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    let response = await this.apiRequest("/editMessageText", {
      method: "POST",
      body: JSON.stringify({
        chat_id: channelId,
        message_id: parseInt(messageId),
        text: content,
        parse_mode: "HTML",
      }),
    });

    let data = await response.json() as { ok?: boolean; description?: string };

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
      data = await response.json() as { ok?: boolean; description?: string };
    }

    if (!data.ok) {
      throw new Error(`Failed to edit message (${response.status}): ${data.description || "unknown error"}`);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.apiRequest("/deleteMessage", {
      method: "POST",
      body: JSON.stringify({
        chat_id: channelId,
        message_id: parseInt(messageId),
      }),
    });
  }

  private async sendTypingAction(channelId: string): Promise<void> {
    const response = await this.apiRequest("/sendChatAction", {
      method: "POST",
      body: JSON.stringify({
        chat_id: channelId,
        action: "typing",
      }),
    });

    const data = await response.json() as { ok?: boolean; description?: string };
    if (!response.ok || !data?.ok) {
      throw new Error(`Failed to send typing action: ${data?.description || response.statusText || response.status}`);
    }
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    const existing = this.typingIntervals.get(channelId);

    if (!isTyping) {
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(channelId);
      }
      return;
    }

    if (existing) return;

    await this.sendTypingAction(channelId);

    const interval = setInterval(() => {
      void this.sendTypingAction(channelId).catch(err => {
        console.error(`[Telegram] Failed to refresh typing for ${channelId}:`, err);
      });
    }, 4000);

    this.typingIntervals.set(channelId, interval);
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return { connected: this.connected };
  }

  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    const response = await this.apiRequest("/getMe");
    const data = await response.json() as { ok: boolean; result: { id: number; username: string; first_name: string } };
    return data.result;
  }

  // Handle webhook update (called from HTTP handler)
  async handleWebhookUpdate(update: any): Promise<void> {
    if (this.config.webhookSecret) {
      // Verify secret here
    }
    await this.handleUpdate(update);
  }
}
