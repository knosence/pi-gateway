/**
 * Twitch Adapter - Hermes-style Twitch platform adapter
 *
 * Features:
 * - Helix API integration
 * - EventSub WebSocket for real-time events
 * - Stream notifications (live/offline)
 * - Chat settings and moderation
 */
import { BaseAdapter } from "./base.js";
export class TwitchAdapter extends BaseAdapter {
    platform = "twitch";
    config;
    token = null;
    tokenExpiry = 0;
    eventsubWs = null;
    eventsubSessionId = null;
    subscribedChannels = new Set();
    streamStatus = new Map();
    constructor(config) {
        super();
        this.config = {
            enabled: true,
            platform: "twitch",
            channels: [],
            events: ["stream.online", "stream.offline"],
            ...config,
        };
        // Initialize monitored channels
        if (this.config.channels) {
            this.config.channels.forEach(c => this.subscribedChannels.add(c.toLowerCase()));
        }
    }
    async initialize() {
        await this.authenticate();
        console.log(`[Twitch] Adapter initialized for ${this.subscribedChannels.size} channels`);
    }
    async authenticate() {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            grant_type: "client_credentials",
        });
        const response = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
        });
        if (!response.ok) {
            throw new Error(`Twitch auth failed: ${response.status}`);
        }
        this.token = await response.json();
        this.tokenExpiry = Date.now() + (this.token.expires_in * 1000);
    }
    async getAccessToken() {
        if (this.token && Date.now() < this.tokenExpiry - 60000) {
            return this.token.access_token;
        }
        await this.authenticate();
        return this.token.access_token;
    }
    getHeaders() {
        if (!this.token)
            throw new Error("Not authenticated");
        return {
            "Client-ID": this.config.clientId,
            "Authorization": `Bearer ${this.token.access_token}`,
        };
    }
    async start(callbacks) {
        await super.start(callbacks);
        // Connect to EventSub WebSocket
        await this.connectEventSub();
    }
    async connectEventSub() {
        this.eventsubWs = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
        this.eventsubWs.onopen = () => {
            console.log("[Twitch] EventSub WebSocket connected");
        };
        this.eventsubWs.onmessage = async (event) => {
            await this.handleEventSubMessage(event.data);
        };
        this.eventsubWs.onclose = () => {
            console.log("[Twitch] EventSub WebSocket closed");
            this.callbacks?.onDisconnect?.();
            // Reconnect after 5 seconds
            setTimeout(() => this.connectEventSub(), 5000);
        };
        this.eventsubWs.onerror = (error) => {
            console.error("[Twitch] EventSub error:", error);
        };
    }
    async handleEventSubMessage(data) {
        try {
            const msg = JSON.parse(data);
            const type = msg.metadata?.message_type;
            switch (type) {
                case "session_welcome": {
                    this.eventsubSessionId = msg.payload.session.id;
                    console.log(`[Twitch] EventSub session: ${this.eventsubSessionId}`);
                    // Subscribe to events for each channel
                    for (const channel of this.subscribedChannels) {
                        await this.subscribeToChannel(channel);
                    }
                    break;
                }
                case "notification": {
                    const eventType = msg.payload?.subscription?.type;
                    const eventData = msg.payload?.event || {};
                    if (eventType === "stream.online" || eventType === "stream.offline") {
                        const broadcaster = eventData.broadcaster_user_login;
                        const wasLive = this.streamStatus.get(broadcaster) || false;
                        const isLive = eventType === "stream.online";
                        this.streamStatus.set(broadcaster, isLive);
                        // Emit message to gateway
                        const message = {
                            id: this.generateMessageId(),
                            platform: "twitch",
                            channelId: broadcaster,
                            userId: broadcaster, // Twitch events don't have a "from" user
                            content: isLive
                                ? `🎮 ${broadcaster} is now LIVE!`
                                : `📴 ${broadcaster} went offline`,
                            timestamp: Date.now(),
                            metadata: { eventType, wasLive, isLive, stream: eventData },
                        };
                        this.emitMessage(message);
                    }
                    break;
                }
                case "session_keepalive":
                    // Heartbeat - no action needed
                    break;
            }
        }
        catch (err) {
            console.error("[Twitch] EventSub parse error:", err);
        }
    }
    async subscribeToChannel(channel) {
        // Get broadcaster ID first
        const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channel}`, { headers: this.getHeaders() });
        const userData = await userResponse.json();
        const broadcaster = userData.data[0];
        if (!broadcaster) {
            console.warn(`[Twitch] Channel not found: ${channel}`);
            return;
        }
        // Note: Subscription creation requires webhook transport
        // For WebSocket, events are received if the user has a subscription
        console.log(`[Twitch] Monitoring channel: ${channel} (${broadcaster.id})`);
    }
    async stop() {
        if (this.eventsubWs) {
            this.eventsubWs.close();
            this.eventsubWs = null;
        }
        this.eventsubSessionId = null;
        await super.stop();
    }
    async sendMessage(channelId, content) {
        // Twitch doesn't support chat via API (requires IRC or EventSub Chat)
        // For now, this is a no-op - chat messages must come through EventSub Chat
        console.warn("[Twitch] sendMessage not supported - use IRC for chat");
        return this.generateMessageId();
    }
    async editMessage(channelId, messageId, content) {
        // Not supported via Helix API
    }
    async deleteMessage(channelId, messageId) {
        // Not supported via Helix API
    }
    async setTyping(channelId, isTyping) {
        // Not supported via Helix API
    }
    async getStatus() {
        return {
            connected: this.eventsubWs?.readyState === WebSocket.OPEN && this.eventsubSessionId !== null,
        };
    }
    // ============ API Methods (for tools) ============
    async getStream(broadcaster) {
        const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${broadcaster}`, { headers: this.getHeaders() });
        const data = await response.json();
        return data.data[0] || null;
    }
    async getUser(login) {
        const response = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: this.getHeaders() });
        const data = await response.json();
        return data.data[0] || null;
    }
    async createClip(broadcaster) {
        // Get broadcaster ID first
        const user = await this.getUser(broadcaster);
        if (!user)
            throw new Error(`Channel not found: ${broadcaster}`);
        const response = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}`, {
            method: "POST",
            headers: this.getHeaders()
        });
        const data = await response.json();
        return { url: data.data[0]?.edit_url || "", title: data.data[0]?.title || "" };
    }
    async getChatSettings(broadcasterId) {
        const response = await fetch(`https://api.twitch.tv/helix/chat/settings?broadcaster_id=${broadcasterId}`, { headers: this.getHeaders() });
        const data = await response.json();
        return data.data[0] || { slow: 0, follower_delay: -1, subscriber: false, emote_mode: false };
    }
    async getModerators(broadcasterId) {
        const response = await fetch(`https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${broadcasterId}`, { headers: this.getHeaders() });
        const data = await response.json();
        return data.data.map(m => m.login);
    }
    getMonitoredChannels() {
        return Array.from(this.subscribedChannels);
    }
    isChannelLive(channel) {
        return this.streamStatus.get(channel.toLowerCase()) || false;
    }
}
//# sourceMappingURL=twitch.js.map