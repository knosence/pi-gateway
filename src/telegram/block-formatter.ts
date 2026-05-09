import { err, ok, type Result, type TelegramBlockKind, type TelegramBlockMeta } from "./block-state.js";

const TOOL_RESULT_LIMIT = 1500;

export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function placeholderForKind(kind: TelegramBlockKind, meta: TelegramBlockMeta = {}): string {
  if (kind === "reasoning") return "🧠 <blockquote expandable>…</blockquote>";
  if (kind === "tool_call") return `🔧 <b>${escapeTelegramHtml(meta.toolName || "tool")}</b>\n<pre><code class=\"language-json\">…</code></pre>`;
  if (kind === "tool_result") return "📤 <pre>…</pre>";
  return "…";
}

export function formatBlock(kind: TelegramBlockKind, meta: TelegramBlockMeta, buffer: string, streaming: boolean): Result<string, string> {
  const cursor = streaming ? "▌" : "";

  if (kind === "reasoning") {
    const content = escapeTelegramHtml(`${buffer}${cursor}`.trim() || "…");
    return ok(`🧠 <blockquote expandable>${content}</blockquote>`);
  }

  if (kind === "text") {
    const content = escapeTelegramHtml(`${buffer}${cursor}`);
    return ok(content || escapeTelegramHtml(cursor || "…"));
  }

  if (kind === "tool_call") {
    const toolName = escapeTelegramHtml(meta.toolName || "tool");
    const body = escapeTelegramHtml(`${buffer}${cursor}`.trim() || "…");
    return ok(`🔧 <b>${toolName}</b>\n<pre><code class=\"language-json\">${body}</code></pre>`);
  }

  if (kind === "tool_result") {
    const raw = `${buffer}${cursor}`;
    const truncated = truncateToolResult(raw, TOOL_RESULT_LIMIT);
    const body = escapeTelegramHtml(truncated || "…");
    return ok(`📤 <pre>${body}</pre>`);
  }

  return err(`Unsupported block kind: ${kind}`);
}

function truncateToolResult(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const remainder = value.length - limit;
  return `${value.slice(0, limit)}… (+${remainder} chars)`;
}
