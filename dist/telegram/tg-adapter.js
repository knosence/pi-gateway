import { formatBlock, placeholderForKind } from "./block-formatter.js";
import { err, isErr, ok } from "./block-state.js";
export class TelegramStreamAdapter {
    adapter;
    queue;
    constructor(adapter, queue) {
        this.adapter = adapter;
        this.queue = queue;
    }
    async openBlock(chatId, block) {
        const placeholder = placeholderForKind(block.kind, block.meta);
        const sendResult = await this.queue.enqueue(chatId, {
            kind: "send",
            run: async () => {
                try {
                    const messageId = await this.adapter.sendMessage(chatId, placeholder);
                    return ok(messageId);
                }
                catch (error) {
                    return err(error instanceof Error ? error.message : String(error));
                }
            },
        });
        if (isErr(sendResult))
            return err(sendResult.error);
        return ok({
            ...block,
            messageId: sendResult.value,
            lastEditAt: 0,
        });
    }
    async flushBlock(chatId, block, force) {
        const formatted = formatBlock(block.kind, block.meta, block.buffer, !force);
        if (isErr(formatted))
            return err(formatted.error);
        const editResult = await this.queue.enqueue(chatId, {
            kind: "edit",
            messageId: block.messageId,
            bypassThrottle: force,
            run: async () => {
                try {
                    await this.adapter.editMessage(chatId, block.messageId, formatted.value);
                    return ok(undefined);
                }
                catch (error) {
                    return err(error instanceof Error ? error.message : String(error));
                }
            },
        });
        if (isErr(editResult))
            return err(editResult.error);
        return ok({
            ...block,
            lastEditAt: Date.now(),
            status: force ? "closed" : block.status,
        });
    }
}
//# sourceMappingURL=tg-adapter.js.map