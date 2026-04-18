import { Database } from "../db.js";
export type BackgroundStatus = "running" | "completed" | "failed" | "timeout" | "delivered";
export interface BackgroundTask {
    id: string;
    sessionId: string;
    parentSessionId: string;
    command: string;
    status: BackgroundStatus;
    progress: number;
    progressMessage?: string;
    result?: unknown;
    error?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    deliveredAt?: number;
}
export declare function initBackgroundTasks(): Promise<Database>;
export declare function startBackgroundTask(parentSessionId: string, command: string, onProgress?: (task: BackgroundTask) => void): Promise<BackgroundTask>;
export declare function updateTaskProgress(taskId: string, progress: number, message?: string): Promise<void>;
export declare function completeTask(taskId: string, result: unknown): Promise<void>;
export declare function failTask(taskId: string, error: string): Promise<void>;
export declare function markTaskDelivered(taskId: string): Promise<void>;
export declare function getTask(taskId: string): Promise<BackgroundTask | null>;
export declare function getPendingResultsForSession(parentSessionId: string): Promise<BackgroundTask[]>;
export declare function listTasks(status?: BackgroundStatus): Promise<BackgroundTask[]>;
export declare function cancelTask(taskId: string): Promise<boolean>;
export declare function cleanupOldTasks(maxAgeMs?: number): Promise<number>;
