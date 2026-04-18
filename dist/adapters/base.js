/**
 * Platform Adapter Base - Interface for Hermes-style platform adapters
 */
/**
 * Abstract base class for adapters
 */
export class BaseAdapter {
    callbacks = null;
    running = false;
    async initialize() {
        // Override in subclass
    }
    async start(callbacks) {
        this.callbacks = callbacks;
        this.running = true;
    }
    async stop() {
        this.running = false;
        this.callbacks = null;
    }
    emitMessage(message) {
        if (this.callbacks?.onMessage) {
            this.callbacks.onMessage(message);
        }
    }
    generateMessageId() {
        return `${this.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
