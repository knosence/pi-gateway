import { type Result } from "./block-state.js";
type QueueOperation<T> = {
    kind: "send" | "edit";
    messageId?: string;
    bypassThrottle?: boolean;
    run: () => Promise<Result<T, string>>;
};
export declare class TelegramSendQueue {
    private readonly chats;
    enqueue<T>(chatId: string, operation: QueueOperation<T>): Promise<Result<T, string>>;
    private ensureChat;
    private runOperation;
    private applyThrottle;
    private recordSuccess;
}
export {};
