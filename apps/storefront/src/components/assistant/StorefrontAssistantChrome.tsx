import { History } from "lucide-react";

import type { StorefrontAssistantPageContextSnapshot } from "@/lib/assistant-page-context";
import type { StorefrontRecentThread } from "./useStorefrontFlueAgent";

export function storefrontAssistantSuggestedPrompts(
  context: StorefrontAssistantPageContextSnapshot | null,
): string[] {
  switch (context?.page.kind) {
    case "product":
      return [
        "What am I looking at?",
        "What are its key details?",
        "Is this available?",
      ];
    case "category":
    case "collection":
    case "search":
      return [
        "Help me choose",
        "Compare the best options",
        "What is in stock?",
      ];
    case "cart":
      return [
        "Review my cart",
        "Check item availability",
        "Explain any cart issues",
      ];
    default:
      return [
        "How can you help me shop?",
        "How do I search the catalog?",
        "What can I ask about a product?",
      ];
  }
}

export function storefrontAssistantContextSummary(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  if (!context) return "Waiting for this page";
  const privatePage =
    context.page.kind === "account" || context.page.kind === "checkout";
  const page = privatePage
    ? `${context.page.kind} · private context protected`
    : context.page.title || context.page.kind;
  const count = context.cart.totalItems;
  return `${page} · ${count} ${count === 1 ? "cart item" : "cart items"}`;
}

export function StorefrontConversationHistorySelect({
  recentThreads,
  disabled,
  onSelect,
}: {
  recentThreads: readonly StorefrontRecentThread[];
  disabled: boolean;
  onSelect: (threadId: string) => void;
}) {
  if (recentThreads.length === 0) return null;
  return (
    <label
      title="Conversation history"
      className="relative inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground focus-within:ring-2 focus-within:ring-ring"
    >
      <span className="sr-only">Assistant conversation history</span>
      <History className="size-4" aria-hidden="true" />
      <select
        aria-label="Assistant conversation history"
        defaultValue=""
        disabled={disabled}
        onChange={(event) => {
          const selectedThreadId = event.currentTarget.value;
          event.currentTarget.value = "";
          if (selectedThreadId) onSelect(selectedThreadId);
        }}
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      >
        <option value="" disabled>
          Recent threads
        </option>
        {recentThreads.map((recentThread) => (
          <option key={recentThread.threadId} value={recentThread.threadId}>
            {recentThread.label}
          </option>
        ))}
      </select>
    </label>
  );
}
