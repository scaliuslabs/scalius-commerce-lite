// The 30 merchant tasks of the agent release bar (audit AGENT-TOOLING-SPEC
// §4.6), in the merchant's own words. `scalius_search` must rank a hit whose
// operations cover the task's operation set first for at least 28 of them and
// within the top 3 for all 30.
import { describe, expect, it } from "vitest";

import app from "../../app";
import { finalizeOpenApiContract } from "../../openapi-contract";
import { buildAgentOperationManifest } from "../../openapi/agent-operation-manifest";
import { buildAgentWorkflowCatalog } from "./catalog";
import { createWorkflowSearch, type WorkflowSearchHit } from "./resolver-core";

type CorpusTask = {
  prompt: string;
  /** Any one of these operation sets, wholly inside one hit, completes the task's routing. */
  accept: string[][];
};

export const MERCHANT_TASK_CORPUS: readonly CorpusTask[] = [
  { prompt: "How much did we sell today and how many orders are still unfulfilled?", accept: [["dashboard.home.activity", "dashboard.orders.list"]] },
  { prompt: "Which 5 products have the lowest stock?", accept: [["dashboard.inventory.list"]] },
  { prompt: "Is checkout ready to take orders, and what is blocking it?", accept: [["dashboard.checkout.readiness_get"]] },
  { prompt: "What is left to set up before launch?", accept: [["dashboard.setup.checklist"]] },
  { prompt: "Create a simple product \"Cotton Panjabi\", ৳1,500, 20 in stock, publish", accept: [["dashboard.products.create"]] },
  { prompt: "Create a t-shirt in S/M/L × red/blue, ৳800 each, 10 of each", accept: [["dashboard.products.create"]] },
  { prompt: "Upload these 3 local photos as the product gallery", accept: [["dashboard.media.upload_initiate", "dashboard.media.upload_complete"]] },
  { prompt: "Raise every Shoes price by 5% (show me first)", accept: [["dashboard.resources.variants.bulk_set_prices"]] },
  { prompt: "Change the SEO title and description of Cotton Panjabi", accept: [["dashboard.products.update_section"]] },
  { prompt: "Move 10 units of TS-RED-M from Dhaka to Chittagong", accept: [["dashboard.inventory_transfers.create"]] },
  { prompt: "Create collection \"Eid Picks\" with 6 products and add it to the main menu", accept: [["dashboard.collections.create", "dashboard.navigation.items_create"]] },
  { prompt: "Create code EID10, 10% off Fri–Sun, ৳2,000 minimum", accept: [["dashboard.discounts.create"]] },
  { prompt: "Approve pending reviews and reply to the 1-star one", accept: [["dashboard.reviews.moderate", "dashboard.reviews.reply"]] },
  { prompt: "Fulfil order #1042 and book it with Pathao", accept: [["dashboard.orders.create_shipment"]] },
  { prompt: "Refund ৳500 on order #1042", accept: [["dashboard.orders.refund"]] },
  { prompt: "Cancel order #1043 and put the stock back", accept: [["dashboard.orders.update_status"]] },
  { prompt: "Accept a return of one item on order #1040", accept: [["dashboard.orders.return_create", "dashboard.orders.return_receive"]] },
  { prompt: "Create a COD order for customer Rahim with two panjabis", accept: [["dashboard.resources.orders.create"]] },
  { prompt: "Export last month's orders as CSV", accept: [["dashboard.orders.export"]] },
  { prompt: "Tag every customer with more than 3 orders as VIP", accept: [["dashboard.resources.customers.bulk_tag"]] },
  { prompt: "Enable cash on delivery for Bangladesh only", accept: [["dashboard.payments.methods_get", "dashboard.payments.methods_update"]] },
  { prompt: "Delivery ৳60 inside Dhaka, ৳120 outside", accept: [["dashboard.shipping_zones.apply_template"]] },
  { prompt: "Charge 5% VAT on Bangladesh orders", accept: [["dashboard.taxes.regions_create", "dashboard.taxes.rates_create"]] },
  { prompt: "Connect Meta Pixel + CAPI with a test code and confirm events arrive", accept: [["dashboard.meta_conversions.update"]] },
  { prompt: "Add GA4 with consent mode for EU visitors", accept: [["dashboard.analytics.create"]] },
  { prompt: "Invite a staff member who can only manage orders", accept: [["dashboard.team.users.invite"]] },
  { prompt: "Change the homepage hero headline and publish the theme", accept: [["dashboard.theme.publish"]] },
  { prompt: "Write and publish an About Us page and link it in the footer", accept: [["dashboard.content.create", "dashboard.navigation.items_create"]] },
  { prompt: "Reply to the newest customer message in the inbox", accept: [["dashboard.conversations.list", "dashboard.conversations.post"]] },
  { prompt: "Issue a ৳1,000 gift card to customer Rahim", accept: [["dashboard.gift_cards.create"]] },
];

function covers(hit: WorkflowSearchHit, task: CorpusTask): boolean {
  return task.accept.some((set) => set.every((operationId) => hit.operationIds.includes(operationId)));
}

describe("merchant task routing corpus", () => {
  const document = finalizeOpenApiContract(
    app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "Routing corpus", version: "1.0.0" } }),
  );
  const operations = buildAgentOperationManifest(document);
  const catalog = buildAgentWorkflowCatalog(operations);
  const search = createWorkflowSearch({ catalog, operations });
  const ranks = MERCHANT_TASK_CORPUS.map((task) => {
    const { hits } = search({ query: task.prompt, surface: "dashboard", limit: 10 });
    const rank = hits.findIndex((hit) => covers(hit, task));
    return { prompt: task.prompt, rank, top: hits.slice(0, 3).map((hit) => hit.id) };
  });

  if (process.env.ROUTING_REPORT) {
    console.info(JSON.stringify({
      top1: ranks.filter((entry) => entry.rank === 0).length,
      top3: ranks.filter((entry) => entry.rank >= 0 && entry.rank <= 2).length,
      misses: ranks.filter((entry) => entry.rank !== 0),
    }, null, 2));
  }

  it("ranks the right operation set first for at least 28 of the 30 tasks", () => {
    const misses = ranks.filter((entry) => entry.rank !== 0);
    expect(misses.length, JSON.stringify(misses, null, 2)).toBeLessThanOrEqual(2);
  });

  it("ranks the right operation set within the top 3 for all 30 tasks", () => {
    expect(ranks.filter((entry) => entry.rank < 0 || entry.rank > 2)).toEqual([]);
  });

  it("answers each task in under 50 ms", () => {
    const started = performance.now();
    for (const task of MERCHANT_TASK_CORPUS) search({ query: task.prompt, surface: "dashboard" });
    expect((performance.now() - started) / MERCHANT_TASK_CORPUS.length).toBeLessThan(50);
  });

  it("keeps hit summaries within 160 characters", () => {
    for (const task of MERCHANT_TASK_CORPUS) {
      for (const hit of search({ query: task.prompt, surface: "dashboard", limit: 10 }).hits) {
        expect(hit.summary.length).toBeLessThanOrEqual(160);
      }
    }
  });
});
