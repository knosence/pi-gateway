import { err, isErr } from "./block-state.js";
export class TelegramSendQueue {
    chats = new Map();
    enqueue(chatId, operation) {
        const state = this.ensureChat(chatId);
        return new Promise((resolve) => {
            state.tail = state.tail
                .then(async () => {
                resolve(await this.runOperation(chatId, state, operation));
            })
                .catch(async (queueError) => {
                resolve(err(queueError instanceof Error ? queueError.message : String(queueError)));
            });
        });
    }
    ensureChat(chatId) {
        const existing = this.chats.get(chatId);
        if (existing)
            return existing;
        const created = {
            tail: Promise.resolve(),
            lastSendAt: 0,
            lastEditAtByMessage: new Map(),
        };
        this.chats.set(chatId, created);
        return created;
    }
    async runOperation(chatId, state, operation) {
        while (true) {
            await this.applyThrottle(state, operation);
            const result = await operation.run();
            if (!isErr(result)) {
                this.recordSuccess(state, operation);
                return result;
            }
            const errorText = result.error;
            const retryAfterMs = parseRetryAfterMs(errorText);
            if (retryAfterMs == null)
                return err(errorText);
            await sleep(retryAfterMs);
            if (operation.kind === "send") {
                state.lastSendAt = 0;
            }
            else if (operation.messageId) {
                state.lastEditAtByMessage.delete(operation.messageId);
            }
        }
    }
    async applyThrottle(state, operation) {
        if (operation.bypassThrottle)
            return;
        const now = Date.now();
        if (operation.kind === "send") {
            const waitMs = Math.max(0, 1000 - (now - state.lastSendAt));
            if (waitMs > 0)
                await sleep(waitMs);
            return;
        }
        if (operation.messageId) {
            const lastEditAt = state.lastEditAtByMessage.get(operation.messageId) || 0;
            const waitMs = Math.max(0, 1000 - (now - lastEditAt));
            if (waitMs > 0)
                await sleep(waitMs);
        }
    }
    recordSuccess(state, operation) {
        const now = Date.now();
        if (operation.kind === "send") {
            state.lastSendAt = now;
            return;
        }
        if (operation.messageId) {
            state.lastEditAtByMessage.set(operation.messageId, now);
        }
    }
}
function parseRetryAfterMs(errorText) {
    const match = errorText.match(/retry after\s+(\d+)/i);
    if (!match)
        return null;
    return Number(match[1]) * 1000;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=send-queue.js.map