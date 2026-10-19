// Merchant entry points as MCP prompts (Claude Code shows them as slash
// commands). Each body stays under 1 KB and drives the scalius_* tools; it
// carries no operation ids of its own, so it cannot drift from the contract.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const AGENT_PROMPT_MAX_BYTES = 1024;

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  args?: Record<string, { description: string; optional?: boolean }>;
  body: (args: Record<string, string | undefined>) => string;
}

const SAFE_WRITE = "For every change run scalius_write with dryRun:true first, show me the summary, and send the confirmToken only after I approve. Verify each change with scalius_read.";

export const AGENT_PROMPTS: readonly PromptDefinition[] = [
  {
    name: "daily_brief",
    title: "Daily brief",
    description: "Sales today against the same weekday last week, unfulfilled orders, low stock, failed payments, pending returns.",
    body: () => [
      "Give me today's store brief.",
      "1. scalius_answer \"daily operations snapshot\" for booked sales, orders, payment recovery, stock alerts and checkout readiness.",
      "2. scalius_search for any part it does not cover (sales for the same weekday last week, unfulfilled orders, pending returns), then scalius_read with select so each read stays small.",
      "Answer in at most 8 lines: numbers first in the shop currency, then the three things I should do today. Say which numbers you could not read; never estimate them.",
    ].join("\n"),
  },
  {
    name: "launch_product",
    title: "Launch a product",
    description: "Create, stock and publish one product, with options when given.",
    args: {
      name: { description: "Product name" },
      price: { description: "Price in the shop currency, e.g. 1500" },
      options: { description: "Option axes, e.g. Size: S,M,L; Color: Red,Blue", optional: true },
    },
    body: ({ name, price, options }) => [
      `Create the product "${name ?? ""}" at ${price ?? ""} in the shop currency${options ? ` with options ${options}` : " as a simple product (one default SKU)"}.`,
      "scalius_search \"create a product\" and follow the plan it returns; scalius_describe the create operation before building its input.",
      "Ask me for stock per SKU and images if I did not give them. Keep it a draft until I approve, then publish it.",
      SAFE_WRITE,
      "Finish with the product link and each SKU's price and stock.",
    ].join("\n"),
  },
  {
    name: "run_sale",
    title: "Run a sale",
    description: "Discount a scope of products for a date range, previewed first.",
    args: {
      percent: { description: "Discount percent, e.g. 10" },
      scope: { description: "What it applies to: all, a collection, a category or products" },
      dates: { description: "Start and end, e.g. Fri 00:00 to Sun 23:59", optional: true },
    },
    body: ({ percent, scope, dates }) => [
      `Run a ${percent ?? ""}% sale on ${scope ?? ""}${dates ? ` from ${dates}` : ""} in the store time zone.`,
      "scalius_search \"create a discount\" and resolve the scope to exact ids with scalius_read first. Use the discount preview when the plan offers one.",
      SAFE_WRITE,
      "Finish with the discount code or rule, its dates and a sample of affected prices.",
    ].join("\n"),
  },
  {
    name: "fulfil_backlog",
    title: "Fulfil the backlog",
    description: "Work through unfulfilled orders, oldest first.",
    body: () => [
      "List unfulfilled, paid or COD-confirmed orders oldest first (scalius_search \"unfulfilled orders\", then scalius_read with select for id, number, age, items, city).",
      "Group them by what blocks them: stock, address, courier. Propose a batch to fulfil and book with the courier; do nothing until I approve.",
      SAFE_WRITE,
    ].join("\n"),
  },
  {
    name: "checkout_health",
    title: "Checkout health",
    description: "Whether checkout can take orders now, and what blocks it.",
    body: () => [
      "Check whether checkout can take orders: scalius_search \"checkout readiness\", then read payment methods, delivery zones and rates, and tax regions.",
      "Report ready or blocked, each blocker with the exact fix, and any market whose buyers cannot check out. Change nothing.",
    ].join("\n"),
  },
  {
    name: "tracking_health",
    title: "Tracking health",
    description: "Pixels and server events: what is connected, what is failing.",
    body: () => [
      "Check marketing tracking: scalius_search \"analytics settings\" and \"meta conversions\", then read each provider's settings and health.",
      "Report per provider (Meta, Google, TikTok, Cloudflare): connected or not, test code set, recent failures, and the one fix that matters most. Change nothing.",
    ].join("\n"),
  },
];

export function registerAgentPrompts(server: McpServer): void {
  for (const prompt of AGENT_PROMPTS) {
    const shape = Object.fromEntries(Object.entries(prompt.args ?? {}).map(([key, arg]) => {
      const field = z.string().max(400).describe(arg.description);
      return [key, arg.optional ? field.optional() : field];
    }));
    const callback = (args: Record<string, string | undefined>) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: prompt.body(args) },
      }],
    });
    if (prompt.args) {
      server.registerPrompt(prompt.name, {
        title: prompt.title,
        description: prompt.description,
        argsSchema: z.object(shape),
      }, (args) => callback(args as Record<string, string | undefined>));
    } else {
      server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, () => callback({}));
    }
  }
}
