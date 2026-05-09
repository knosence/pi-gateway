/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 *
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */
import { BaseAdapter } from "./base.js";
export class WhatsAppAdapter extends BaseAdapter {
    platform = "whatsapp";
    config;
    sock = null;
    connected = false;
    qrCode = null;
    constructor(config) {
        super();
        this.config = {
            enabled: true,
            platform: "whatsapp",
            sessionPath: "./whatsapp-session",
            printQr: true,
            maxMessageLength: 4096,
            ...config,
        };
    }
    async initialize() {
        try {
            const baileysModule = "@whiskeysockets/baileys";
            const baileys = await import(baileysModule);
            const { state, saveCreds } = await baileys.useMultiFileAuthState(this.config.sessionPath || "./whatsapp-session");
            this.sock = baileys.makeWASocket({
                auth: state,
                printQRInTerminal: this.config.printQr,
                defaultQueryTimeoutMs: 60 * 1000,
            });
            // Handle QR code
            this.sock.ev.on("qr", (qr) => {
                this.qrCode = qr;
                console.log("[WhatsApp] QR Code received - scan with WhatsApp app");
                console.log(qr);
            });
            // Handle connection update
            this.sock.ev.on("connection.update", ({ qr, connection }) => {
                if (qr) {
                    this.qrCode = qr;
                }
                if (connection === "open") {
                    this.connected = true;
                    this.qrCode = null;
                    console.log("[WhatsApp] Connected!");
                }
                if (connection === "close") {
                    this.connected = false;
                    console.log("[WhatsApp] Disconnected");
                }
            });
            // Handle credentials update
            this.sock.ev.on("creds.update", saveCreds);
            // Handle messages
            this.sock.ev.on("messages.upsert", ({ messages }) => {
                this.handleMessages(messages);
            });
            console.log("[WhatsApp] Initializing...");
        }
        catch (err) {
            console.error("[WhatsApp] Failed to initialize:", err);
            throw err;
        }
    }
    handleMessages(messages) {
        for (const msg of messages) {
            // Skip messages sent by us
            if (msg.key.fromMe)
                continue;
            const jid = msg.key.remoteJid;
            const isGroup = jid?.endsWith("@g.us");
            // Get message content
            const content = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                "";
            if (!content)
                continue;
            const message = {
                id: msg.key.id || this.generateMessageId(),
                platform: "whatsapp",
                channelId: jid,
                userId: msg.key.participant || jid,
                content,
                timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
                metadata: {
                    isGroup,
                    messageType: msg.message ? Object.keys(msg.message)[0] : "unknown",
                    pushName: msg.pushName,
                },
            };
            this.emitMessage(message);
        }
    }
    async start(callbacks) {
        await super.start(callbacks);
        // Wait for connection
        let attempts = 0;
        while (!this.connected && attempts < 30) {
            await this.sleep(1000);
            attempts++;
        }
        if (!this.connected) {
            console.warn("[WhatsApp] Not yet connected - waiting for QR scan");
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async stop() {
        if (this.sock) {
            await this.sock.logout();
            this.sock = null;
        }
        this.connected = false;
        await super.stop();
    }
    async sendMessage(channelId, content) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        // Truncate if too long
        const text = content.length > (this.config.maxMessageLength || 4096)
            ? content.slice(0, this.config.maxMessageLength - 3) + "..."
            : content;
        try {
            const result = await this.sock.sendMessage(channelId, { text });
            return result?.key?.id || this.generateMessageId();
        }
        catch (err) {
            console.error("[WhatsApp] Send error:", err);
            throw err;
        }
    }
    async sendImage(channelId, imageUrl, caption) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        try {
            const result = await this.sock.sendMessage(channelId, {
                image: { url: imageUrl },
                caption,
            });
            return result?.key?.id || this.generateMessageId();
        }
        catch (err) {
            console.error("[WhatsApp] Send image error:", err);
            throw err;
        }
    }
    async sendReaction(channelId, messageId, emoji) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        try {
            await this.sock.sendMessage(channelId, {
                react: { text: emoji, key: { remoteJid: channelId, id: messageId } },
            });
        }
        catch (err) {
            console.error("[WhatsApp] Reaction error:", err);
        }
    }
    async reply(channelId, content, messageId) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        try {
            const result = await this.sock.sendMessage(channelId, {
                text: content,
                contextInfo: {
                    stanzaId: messageId,
                    remoteJid: channelId,
                },
            });
            return result?.key?.id || this.generateMessageId();
        }
        catch (err) {
            console.error("[WhatsApp] Reply error:", err);
            throw err;
        }
    }
    async editMessage(channelId, messageId, content) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        try {
            await this.sock.relayMessage(channelId, {
                protocolMessage: {
                    type: 6, // MESSAGE_EDIT
                    key: { remoteJid: channelId, id: messageId },
                    editedMessage: { conversation: [{ text: content }] },
                },
            }, {});
        }
        catch (err) {
            console.error("[WhatsApp] Edit error:", err);
        }
    }
    async deleteMessage(channelId, messageId) {
        if (!this.sock || !this.connected) {
            throw new Error("WhatsApp not connected");
        }
        try {
            await this.sock.sendMessage(channelId, {
                delete: { remoteJid: channelId, id: messageId },
            });
        }
        catch (err) {
            console.error("[WhatsApp] Delete error:", err);
        }
    }
    async setTyping(channelId, isTyping) {
        if (!this.sock || !this.connected)
            return;
        try {
            await this.sock.sendPresenceUpdate(isTyping ? "composing" : "available", channelId);
        }
        catch (err) {
            // Ignore presence errors
        }
    }
    async getStatus() {
        return { connected: this.connected };
    }
    async getContacts() {
        if (!this.sock?.store?.contacts) {
            return [];
        }
        return Object.entries(this.sock.store.contacts).map(([id, contact]) => ({
            id,
            name: contact?.name || contact?.notify || id.split("@")[0],
            isGroup: id.endsWith("@g.us"),
        }));
    }
    async getContact(jid) {
        const contacts = await this.getContacts();
        return contacts.find(c => c.id === jid) || null;
    }
    getQrCode() {
        return this.qrCode;
    }
}
//# sourceMappingURL=whatsapp.js.map