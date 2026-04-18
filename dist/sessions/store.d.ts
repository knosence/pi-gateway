import { Database } from "../db.js";
export type ResetPolicy = "daily" | "idle" | "both";
export interface SessionConfig {
    id: string;
    platform: string;
    channelId: string;
    userId: string;
    resetPolicy: ResetPolicy;
    dailyHour: number;
    idleMinutes: number;
    lastActivity: number;
    createdAt: number;
    isBackground: boolean;
    parentSessionId?: string;
}
export declare function initSessionStore(): Promise<Database>;
export declare function generateSessionId(): string;
export declare function getOrCreateSession(platform: string, channelId: string, userId: string, config?: Partial<SessionConfig>): Promise<SessionConfig>;
export declare function createBackgroundSession(platform: string, channelId: string, userId: string, parentSessionId?: string): Promise<SessionConfig>;
export declare function touchSession(sessionId: string): Promise<void>;
export declare function getSession(sessionId: string): Promise<SessionConfig | null>;
export declare function deleteSession(sessionId: string): Promise<void>;
export declare function listSessions(platform?: string): Promise<SessionConfig[]>;
export declare function cleanupStaleSessions(): Promise<number>;
export declare function getPendingBackgroundResults(): Promise<SessionConfig[]>;
