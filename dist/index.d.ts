/**
 * pi-gateway - Hermes-style Messaging Gateway
 *
 * Architecture:
 * - Single background process
 * - Platform adapters (Discord, Telegram, etc.)
 * - Per-chat session management
 * - Background task support
 * - Security (allowlists, pairing)
 *
 * Usage in pi session:
 *   /gateway start [port]    - Start the gateway
 *   /gateway stop            - Stop the gateway
 *   /gateway status          - Show status
 *   /gateway pair <code>     - Approve pairing code
 *
 * Programmatic API:
 *   import { startGateway, stopGateway, isGatewayRunning } from '@0xkobold/pi-gateway/api';
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI): Promise<void>;
export { startGateway, stopGateway, isGatewayRunning, getStatus, getConfig, isRunning, getAdapter, getAdapters, sendMessage, attachToExistingGateway, broadcast } from "./api.js";
export type { GatewayConfig, GatewayStatus, StartGatewayOptions } from "./api.js";
