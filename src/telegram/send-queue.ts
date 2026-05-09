import { err, isErr, ok, type Result } from "./block-state.js";

type QueueOperation<T> = {
  kind: "send" | "edit";
  messageId?: string;
  bypassThrottle?: boolean;
  run: () => Promise<Result<T, string>>;
};

type ChatQueueState = {
  tail: Promise<void>;
  lastSendAt: number;
  lastEditAtByMessage: Map<string, number>;
};

export class TelegramSendQueue {
  private readonly chats = new Map<string, ChatQueueState>();

  enqueue<T>(chatId: string, operation: QueueOperation<T>): Promise<Result<T, string>> {
    const state = this.ensureChat(chatId);

    return new Promise<Result<T, string>>((resolve) => {
      state.tail = state.tail
        .then(async () => {
          resolve(await this.runOperation(chatId, state, operation));
        })
        .catch(async (queueError) => {
          resolve(err(queueError instanceof Error ? queueError.message : String(queueError)));
        });
    });
  }

  private ensureChat(chatId: string): ChatQueueState {
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    const created: ChatQueueState = {
      tail: Promise.resolve(),
      lastSendAt: 0,
      lastEditAtByMessage: new Map<string, number>(),
    };
    this.chats.set(chatId, created);
    return created;
  }

  private async runOperation<T>(
    chatId: string,
    state: ChatQueueState,
    operation: QueueOperation<T>,
  ): Promise<Result<T, string>> {
    while (true) {
      await this.applyThrottle(state, operation);
      const result = await operation.run();
      if (!isErr(result)) {
        this.recordSuccess(state, operation);
        return result;
      }

      const errorText = result.error;
      const retryAfterMs = parseRetryAfterMs(errorText);
      if (retryAfterMs == null) return err(errorText);
      await sleep(retryAfterMs);
      if (operation.kind === "send") {
        state.lastSendAt = 0;
      } else if (operation.messageId) {
        state.lastEditAtByMessage.delete(operation.messageId);
      }
    }
  }

  private async applyThrottle(state: ChatQueueState, operation: QueueOperation<unknown>): Promise<void> {
    if (operation.bypassThrottle) return;

    const now = Date.now();
    if (operation.kind === "send") {
      const waitMs = Math.max(0, 1000 - (now - state.lastSendAt));
      if (waitMs > 0) await sleep(waitMs);
      return;
    }

    if (operation.messageId) {
      const lastEditAt = state.lastEditAtByMessage.get(operation.messageId) || 0;
      const waitMs = Math.max(0, 1000 - (now - lastEditAt));
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  private recordSuccess(state: ChatQueueState, operation: QueueOperation<unknown>): void {
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

function parseRetryAfterMs(errorText: string): number | null {
  const match = errorText.match(/retry after\s+(\d+)/i);
  if (!match) return null;
  return Number(match[1]) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
