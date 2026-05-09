import { TelegramStreamAdapter } from "./tg-adapter.js";
import { err, ok, type Result, type TelegramBlockKind, type TelegramBlockMeta, type TelegramBlockState } from "./block-state.js";

export type BridgeStreamEvent = {
  type?: string;
  text?: string;
  error?: string;
  toolName?: string;
  isError?: boolean;
  phase?: "start" | "end";
};

export class TelegramStreamDispatcher {
  private readonly blocks = new Map<number, TelegramBlockState>();
  private nextIndex = 1;
  private activeTextBlockIndex: number | null = null;
  private lastClosedText = "";
  private latestAssistantText = "";

  constructor(
    private readonly chatId: string,
    private readonly transport: TelegramStreamAdapter,
  ) {}

  async onBridgeEvent(event: BridgeStreamEvent): Promise<Result<void, string>> {
    if (event.type === "assistant_partial" && event.text) {
      this.rememberAssistantText(event.text);
      return this.appendTextDelta(event.text);
    }

    if (event.type === "assistant" && event.text) {
      this.rememberAssistantText(event.text);
      const trimmed = event.text.trim();
      if (!trimmed) return ok(undefined);
      if (this.activeTextBlockIndex == null && trimmed === this.lastClosedText.trim()) {
        return ok(undefined);
      }
      return this.absorbTerminalAssistant(event.text);
    }

    if (event.type === "final" && event.text) {
      this.rememberAssistantText(event.text);
      const trimmed = event.text.trim();
      if (!trimmed) return ok(undefined);
      if (this.activeTextBlockIndex == null && trimmed === this.lastClosedText.trim()) {
        return ok(undefined);
      }
      return this.finalizeText(event.text);
    }

    if (event.type === "thinking" && event.text?.trim()) {
      return this.emitImmediateBlock("reasoning", event.text.trim(), {});
    }

    if (event.type === "status" && event.toolName && event.text?.trim()) {
      const kind: TelegramBlockKind = event.phase === "end" ? "tool_result" : "tool_call";
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

  async streamEnd(): Promise<Result<void, string>> {
    if (this.activeTextBlockIndex != null) {
      const finalizeResult = await this.syncActiveBlockToLatestAssistant();
      if (!finalizeResult.ok) return finalizeResult;
      const closeResult = await this.closeBlock(this.activeTextBlockIndex);
      if (!closeResult.ok) return closeResult;
      const block = this.blocks.get(this.activeTextBlockIndex);
      if (block) this.lastClosedText = block.buffer;
      this.activeTextBlockIndex = null;
    }
    return ok(undefined);
  }

  private async appendTextDelta(chunk: string): Promise<Result<void, string>> {
    const upsertResult = await this.upsertTextBuffer(chunk, true);
    if (!upsertResult.ok) return upsertResult;

    const block = this.blocks.get(upsertResult.value);
    if (!block) return err(`Missing text block ${upsertResult.value}`);

    const now = Date.now();
    if (now - block.lastEditAt < 800) return ok(undefined);

    const flushResult = await this.transport.flushBlock(this.chatId, block, false);
    if (!flushResult.ok) return flushResult;
    this.blocks.set(block.index, flushResult.value);
    return ok(undefined);
  }

  private async absorbTerminalAssistant(text: string): Promise<Result<void, string>> {
    const upsertResult = await this.upsertTextBuffer(text, false);
    if (!upsertResult.ok) return upsertResult;

    const block = this.blocks.get(upsertResult.value);
    if (!block) return err(`Missing assistant text block ${upsertResult.value}`);

    const flushResult = await this.transport.flushBlock(this.chatId, block, false);
    if (!flushResult.ok) return flushResult;
    this.blocks.set(block.index, flushResult.value);
    return ok(undefined);
  }

  private async finalizeText(finalText: string): Promise<Result<void, string>> {
    const upsertResult = await this.upsertTextBuffer(finalText, false);
    if (!upsertResult.ok) return upsertResult;
    const index = upsertResult.value;

    const block = this.blocks.get(index);
    if (!block) return err(`Missing final text block ${index}`);

    const closeResult = await this.closeBlock(index);
    if (!closeResult.ok) return closeResult;
    this.lastClosedText = block.buffer;
    this.activeTextBlockIndex = null;
    return ok(undefined);
  }

  private async upsertTextBuffer(text: string, allowRawAppend: boolean): Promise<Result<number, string>> {
    let index = this.activeTextBlockIndex;
    if (index == null) {
      const openResult = await this.openBlock("text", {});
      if (!openResult.ok) return openResult;
      index = openResult.value.index;
      this.activeTextBlockIndex = index;
    }

    const block = this.blocks.get(index);
    if (!block) return err(`Missing text block ${index}`);

    if (!block.buffer) {
      block.buffer = text;
    } else if (text.startsWith(block.buffer)) {
      block.buffer += text.slice(block.buffer.length);
    } else if (block.buffer.startsWith(text)) {
      return ok(index);
    } else if (allowRawAppend) {
      block.buffer += text;
    } else {
      block.buffer = text;
    }

    return ok(index);
  }

  private async emitImmediateBlock(kind: TelegramBlockKind, content: string, meta: TelegramBlockMeta): Promise<Result<void, string>> {
    const closeActive = await this.closeActiveTextBlock();
    if (!closeActive.ok) return closeActive;

    const openResult = await this.openBlock(kind, meta);
    if (!openResult.ok) return openResult;

    const block = this.blocks.get(openResult.value.index);
    if (!block) return err(`Missing immediate block ${openResult.value.index}`);
    block.buffer = content;

    const closeResult = await this.closeBlock(block.index);
    if (!closeResult.ok) return closeResult;
    return ok(undefined);
  }

  private async closeActiveTextBlock(): Promise<Result<void, string>> {
    if (this.activeTextBlockIndex == null) return ok(undefined);
    const closeResult = await this.closeBlock(this.activeTextBlockIndex);
    if (!closeResult.ok) return closeResult;
    const block = this.blocks.get(this.activeTextBlockIndex);
    if (block) this.lastClosedText = block.buffer;
    this.activeTextBlockIndex = null;
    return ok(undefined);
  }

  private async openBlock(kind: TelegramBlockKind, meta: TelegramBlockMeta): Promise<Result<TelegramBlockState, string>> {
    const index = this.nextIndex++;
    const openResult = await this.transport.openBlock(this.chatId, {
      index,
      kind,
      buffer: "",
      status: "streaming",
      meta,
    });
    if (!openResult.ok) return openResult;
    this.blocks.set(index, openResult.value);
    return openResult;
  }

  private async syncActiveBlockToLatestAssistant(): Promise<Result<void, string>> {
    if (this.activeTextBlockIndex == null) return ok(undefined);
    if (!this.latestAssistantText.trim()) return ok(undefined);

    const block = this.blocks.get(this.activeTextBlockIndex);
    if (!block) return err(`Missing text block ${this.activeTextBlockIndex}`);

    if (this.latestAssistantText.startsWith(block.buffer)) {
      block.buffer += this.latestAssistantText.slice(block.buffer.length);
    } else if (block.buffer !== this.latestAssistantText) {
      block.buffer = this.latestAssistantText;
    }

    return ok(undefined);
  }

  private rememberAssistantText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
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

  private async closeBlock(index: number): Promise<Result<void, string>> {
    const block = this.blocks.get(index);
    if (!block) return err(`Missing block ${index}`);
    if (block.status === "closed") return ok(undefined);

    const closeResult = await this.transport.flushBlock(this.chatId, block, true);
    if (!closeResult.ok) return closeResult;
    this.blocks.set(index, closeResult.value);
    return ok(undefined);
  }
}
