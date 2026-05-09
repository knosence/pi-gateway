import { err, isErr, ok } from "./block-state.js";
export class TelegramStreamDispatcher {
    chatId;
    transport;
    blocks = new Map();
    nextIndex = 1;
    activeTextBlockIndex = null;
    lastClosedText = "";
    latestAssistantText = "";
    constructor(chatId, transport) {
        this.chatId = chatId;
        this.transport = transport;
    }
    async onBridgeEvent(event) {
        if (event.type === "assistant_partial" && event.text) {
            this.rememberAssistantText(event.text);
            return this.appendTextDelta(event.text);
        }
        if (event.type === "assistant" && event.text) {
            this.rememberAssistantText(event.text);
            const trimmed = event.text.trim();
            if (!trimmed)
                return ok(undefined);
            if (this.activeTextBlockIndex == null && trimmed === this.lastClosedText.trim()) {
                return ok(undefined);
            }
            return this.absorbTerminalAssistant(event.text);
        }
        if (event.type === "final" && event.text) {
            this.rememberAssistantText(event.text);
            const trimmed = event.text.trim();
            if (!trimmed)
                return ok(undefined);
            if (this.activeTextBlockIndex == null && trimmed === this.lastClosedText.trim()) {
                return ok(undefined);
            }
            return this.finalizeText(event.text);
        }
        if (event.type === "thinking" && event.text?.trim()) {
            return this.emitImmediateBlock("reasoning", event.text.trim(), {});
        }
        if (event.type === "status" && event.toolName && event.text?.trim()) {
            const kind = event.phase === "end" ? "tool_result" : "tool_call";
            return this.emitImmediateBlock(kind, event.text.trim(), {
                toolName: event.toolName,
                isError: !!event.isError,
            });
        }
        if (event.type === "error") {
            return this.emitImmediateBlock("tool_result", event.error?.trim() || "Live bridge stream error", {
                toolName: "bridge",
                isError: true,
            });
        }
        return ok(undefined);
    }
    async streamEnd() {
        if (this.activeTextBlockIndex != null) {
            const finalizeResult = await this.syncActiveBlockToLatestAssistant();
            if (isErr(finalizeResult))
                return err(finalizeResult.error);
            const closeResult = await this.closeBlock(this.activeTextBlockIndex);
            if (isErr(closeResult))
                return err(closeResult.error);
            const block = this.blocks.get(this.activeTextBlockIndex);
            if (block)
                this.lastClosedText = block.buffer;
            this.activeTextBlockIndex = null;
        }
        return ok(undefined);
    }
    async appendTextDelta(chunk) {
        const upsertResult = await this.upsertTextBuffer(chunk, true);
        if (isErr(upsertResult))
            return err(upsertResult.error);
        const block = this.blocks.get(upsertResult.value);
        if (!block)
            return err(`Missing text block ${upsertResult.value}`);
        const now = Date.now();
        if (now - block.lastEditAt < 800)
            return ok(undefined);
        const flushResult = await this.transport.flushBlock(this.chatId, block, false);
        if (isErr(flushResult))
            return err(flushResult.error);
        this.blocks.set(block.index, flushResult.value);
        return ok(undefined);
    }
    async absorbTerminalAssistant(text) {
        const upsertResult = await this.upsertTextBuffer(text, false);
        if (isErr(upsertResult))
            return err(upsertResult.error);
        const block = this.blocks.get(upsertResult.value);
        if (!block)
            return err(`Missing assistant text block ${upsertResult.value}`);
        const flushResult = await this.transport.flushBlock(this.chatId, block, false);
        if (isErr(flushResult))
            return err(flushResult.error);
        this.blocks.set(block.index, flushResult.value);
        return ok(undefined);
    }
    async finalizeText(finalText) {
        const upsertResult = await this.upsertTextBuffer(finalText, false);
        if (isErr(upsertResult))
            return err(upsertResult.error);
        const index = upsertResult.value;
        const block = this.blocks.get(index);
        if (!block)
            return err(`Missing final text block ${index}`);
        const closeResult = await this.closeBlock(index);
        if (isErr(closeResult))
            return err(closeResult.error);
        this.lastClosedText = block.buffer;
        this.activeTextBlockIndex = null;
        return ok(undefined);
    }
    async upsertTextBuffer(text, allowRawAppend) {
        let index = this.activeTextBlockIndex;
        if (index == null) {
            const openResult = await this.openBlock("text", {});
            if (isErr(openResult))
                return err(openResult.error);
            index = openResult.value.index;
            this.activeTextBlockIndex = index;
        }
        const block = this.blocks.get(index);
        if (!block)
            return err(`Missing text block ${index}`);
        if (!block.buffer) {
            block.buffer = text;
        }
        else if (text.startsWith(block.buffer)) {
            block.buffer += text.slice(block.buffer.length);
        }
        else if (block.buffer.startsWith(text)) {
            return ok(index);
        }
        else if (allowRawAppend) {
            block.buffer += text;
        }
        else {
            block.buffer = text;
        }
        return ok(index);
    }
    async emitImmediateBlock(kind, content, meta) {
        const closeActive = await this.closeActiveTextBlock();
        if (isErr(closeActive))
            return err(closeActive.error);
        const openResult = await this.openBlock(kind, meta);
        if (isErr(openResult))
            return err(openResult.error);
        const block = this.blocks.get(openResult.value.index);
        if (!block)
            return err(`Missing immediate block ${openResult.value.index}`);
        block.buffer = content;
        const closeResult = await this.closeBlock(block.index);
        if (isErr(closeResult))
            return err(closeResult.error);
        return ok(undefined);
    }
    async closeActiveTextBlock() {
        if (this.activeTextBlockIndex == null)
            return ok(undefined);
        const closeResult = await this.closeBlock(this.activeTextBlockIndex);
        if (isErr(closeResult))
            return err(closeResult.error);
        const block = this.blocks.get(this.activeTextBlockIndex);
        if (block)
            this.lastClosedText = block.buffer;
        this.activeTextBlockIndex = null;
        return ok(undefined);
    }
    async openBlock(kind, meta) {
        const index = this.nextIndex++;
        const openResult = await this.transport.openBlock(this.chatId, {
            index,
            kind,
            buffer: "",
            status: "streaming",
            meta,
        });
        if (isErr(openResult))
            return err(openResult.error);
        this.blocks.set(index, openResult.value);
        return ok(openResult.value);
    }
    async syncActiveBlockToLatestAssistant() {
        if (this.activeTextBlockIndex == null)
            return ok(undefined);
        if (!this.latestAssistantText.trim())
            return ok(undefined);
        const block = this.blocks.get(this.activeTextBlockIndex);
        if (!block)
            return err(`Missing text block ${this.activeTextBlockIndex}`);
        if (this.latestAssistantText.startsWith(block.buffer)) {
            block.buffer += this.latestAssistantText.slice(block.buffer.length);
        }
        else if (block.buffer !== this.latestAssistantText) {
            block.buffer = this.latestAssistantText;
        }
        return ok(undefined);
    }
    rememberAssistantText(text) {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        if (!this.latestAssistantText) {
            this.latestAssistantText = text;
            return;
        }
        if (text.startsWith(this.latestAssistantText)) {
            this.latestAssistantText = text;
            return;
        }
        if (this.latestAssistantText.startsWith(text)) {
            return;
        }
        this.latestAssistantText = text;
    }
    async closeBlock(index) {
        const block = this.blocks.get(index);
        if (!block)
            return err(`Missing block ${index}`);
        if (block.status === "closed")
            return ok(undefined);
        const closeResult = await this.transport.flushBlock(this.chatId, block, true);
        if (isErr(closeResult))
            return err(closeResult.error);
        this.blocks.set(index, closeResult.value);
        return ok(undefined);
    }
}
//# sourceMappingURL=stream-dispatcher.js.map