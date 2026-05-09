import { type Result, type TelegramBlockKind, type TelegramBlockMeta } from "./block-state.js";
export declare function escapeTelegramHtml(text: string): string;
export declare function placeholderForKind(kind: TelegramBlockKind, meta?: TelegramBlockMeta): string;
export declare function formatBlock(kind: TelegramBlockKind, meta: TelegramBlockMeta, buffer: string, streaming: boolean): Result<string, string>;
