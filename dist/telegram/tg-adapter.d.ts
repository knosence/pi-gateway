import { TelegramSendQueue } from "./send-queue.js";
import { type Result, type TelegramBlockState } from "./block-state.js";
import { TelegramAdapter } from "../adapters/telegram.js";
export declare class TelegramStreamAdapter {
    private readonly adapter;
    private readonly queue;
    constructor(adapter: TelegramAdapter, queue: TelegramSendQueue);
    openBlock(chatId: string, block: Omit<TelegramBlockState, "messageId" | "lastEditAt">): Promise<Result<TelegramBlockState, string>>;
    flushBlock(chatId: string, block: TelegramBlockState, force: boolean): Promise<Result<TelegramBlockState, string>>;
}
