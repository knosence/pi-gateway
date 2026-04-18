import { Database } from "../db.js";
export type Platform = "discord" | "telegram" | "slack" | "whatsapp" | "signal" | "sms" | "email" | "matrix" | "web" | "websocket";
interface AllowlistEntry {
    platform: Platform;
    userId: string;
    addedAt: number;
    note?: string;
}
export declare function initSecurityStore(): Promise<Database>;
export declare function generatePairingCode(platform: Platform, userId: string): Promise<string>;
export declare function approvePairingCode(code: string): Promise<boolean>;
export declare function listPendingPairingCodes(): Promise<Array<{
    code: string;
    platform: Platform;
    userId: string;
    createdAt: number;
    expiresIn: number;
}>>;
export declare function revokeUserAccess(platform: Platform, userId: string): Promise<boolean>;
export declare function isUserAllowed(platform: Platform, userId: string): Promise<boolean>;
export declare function addToAllowlist(platform: Platform, userId: string, note?: string): Promise<void>;
export declare function listAllowlistedUsers(platform?: Platform): Promise<AllowlistEntry[]>;
export declare function checkRateLimit(identifier: string, maxRequests?: number, windowMs?: number): Promise<boolean>;
export declare function cleanupExpiredCodes(): Promise<number>;
interface SecurityConfig {
    allowAll: boolean;
    requirePairing: boolean;
    rateLimit: {
        maxRequests: number;
        windowMs: number;
    };
}
export declare function setSecurityConfig(config: Partial<SecurityConfig>): void;
export {};
