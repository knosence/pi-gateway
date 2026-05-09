import { TelegramStreamAdapter } from "./tg-adapter.js";
import { type Result } from "./block-state.js";
export type BridgeStreamEvent = {
    type?: string;
    text?: string;
    error?: string;
    toolName?: string;
    isError?: boolean;
    phase?: "start" | "end";
};
export declare class TelegramStreamDispatcher {
    private readonly chatId;
    private readonly transport;
    private readonly blocks;
    private nextIndex;
    private activeTextBlockIndex;
    private lastClosedText;
    private latestAssistantText;
    constructor(chatId: string, transport: TelegramStreamAdapter);
    onBridgeEvent(event: BridgeStreamEvent): Promise<Result<void, string>>;
    streamEnd(): Promise<Result<void, string>>;
    private appendTextDelta;
    private absorbTerminalAssistant;
    private finalizeText;
    private upsertTextBuffer;
    private emitImmediateBlock;
    private closeActiveTextBlock;
    private openBlock;
    private syncActiveBlockToLatestAssistant;
    private rememberAssistantText;
    private closeBlock;
}
