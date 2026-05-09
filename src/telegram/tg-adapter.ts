import { formatBlock, placeholderForKind } from "./block-formatter.js";
import { TelegramSendQueue } from "./send-queue.js";
import { err, isErr, ok, type Result, type TelegramBlockState } from "./block-state.js";
import { TelegramAdapter } from "../adapters/telegram.js";

export class TelegramStreamAdapter {
  constructor(
    private readonly adapter: TelegramAdapter,
    private readonly queue: TelegramSendQueue,
  ) {}

  async openBlock(chatId: string, block: Omit<TelegramBlockState, "messageId" | "lastEditAt">): Promise<Result<TelegramBlockState, string>> {
    const placeholder = placeholderForKind(block.kind, block.meta);
    const sendResult = await this.queue.enqueue(chatId, {
      kind: "send",
      run: async () => {
        try {
          const messageId = await this.adapter.sendMessage(chatId, placeholder);
          return ok(messageId);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    if (isErr(sendResult)) return err(sendResult.error);

    return ok({
      ...block,
      messageId: sendResult.value,
      lastEditAt: 0,
    });
  }

  async flushBlock(chatId: string, block: TelegramBlockState, force: boolean): Promise<Result<TelegramBlockState, string>> {
    const formatted = formatBlock(block.kind, block.meta, block.buffer, !force);
    if (isErr(formatted)) return err(formatted.error);

    const editResult = await this.queue.enqueue(chatId, {
      kind: "edit",
      messageId: block.messageId,
      bypassThrottle: force,
      run: async () => {
        try {
          await this.adapter.editMessage(chatId, block.messageId, formatted.value);
          return ok(undefined);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    if (isErr(editResult)) return err(editResult.error);

    return ok({
      ...block,
      lastEditAt: Date.now(),
      status: force ? "closed" : block.status,
    });
  }
}
