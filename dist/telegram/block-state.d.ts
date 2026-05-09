export type Result<T, E> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: E;
};
export type TelegramBlockKind = "reasoning" | "text" | "tool_call" | "tool_result";
export type TelegramBlockStatus = "streaming" | "closed";
export type TelegramBlockMeta = {
    toolName?: string;
    isError?: boolean;
};
export type TelegramBlockState = {
    index: number;
    kind: TelegramBlockKind;
    messageId: string;
    buffer: string;
    status: TelegramBlockStatus;
    lastEditAt: number;
    meta: TelegramBlockMeta;
};
export type BlockOpenEvent = {
    type: "block_open";
    index: number;
    kind: TelegramBlockKind;
    meta: TelegramBlockMeta;
};
export type BlockDeltaEvent = {
    type: "block_delta";
    index: number;
    chunk: string;
};
export type BlockCloseEvent = {
    type: "block_close";
    index: number;
};
export type StreamEndEvent = {
    type: "stream_end";
};
export type TelegramStreamEvent = BlockOpenEvent | BlockDeltaEvent | BlockCloseEvent | StreamEndEvent;
export declare function ok<T>(value: T): Result<T, never>;
export declare function err<E>(error: E): Result<never, E>;
export declare function isErr<T, E>(result: Result<T, E>): result is {
    ok: false;
    error: E;
};
