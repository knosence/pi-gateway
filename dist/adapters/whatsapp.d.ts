/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 *
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */
import { BaseAdapter, type PlatformConfig } from "./base.js";
export interface WhatsAppConfig extends PlatformConfig {
    platform: "whatsapp";
    sessionPath?: string;
    printQr?: boolean;
    maxMessageLength?: number;
}
interface WhatsAppContact {
    id: string;
    name?: string;
    isGroup: boolean;
}
export declare class WhatsAppAdapter extends BaseAdapter {
    readonly platform: "whatsapp";
    config: WhatsAppConfig;
    private sock;
    private connected;
    private qrCode;
    constructor(config: WhatsAppConfig);
    initialize(): Promise<void>;
    private handleMessages;
    start(callbacks: any): Promise<void>;
    private sleep;
    stop(): Promise<void>;
    sendMessage(channelId: string, content: string): Promise<string>;
    sendImage(channelId: string, imageUrl: string, caption?: string): Promise<string>;
    sendReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
    reply(channelId: string, content: string, messageId: string): Promise<string>;
    editMessage(channelId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(channelId: string, messageId: string): Promise<void>;
    setTyping(channelId: string, isTyping: boolean): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        latency?: number;
    }>;
    getContacts(): Promise<WhatsAppContact[]>;
    getContact(jid: string): Promise<WhatsAppContact | null>;
    getQrCode(): string | null;
}
export {};
