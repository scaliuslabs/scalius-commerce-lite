# Storefront

1. Create an agent storefront context and retain its context ID/revision in memory.
2. Discover products/categories/collections and select exact variant IDs through bounded public reads.
3. Mutate cart lines with the current context revision; never submit client prices or stock.
4. Resolve city → zone → area → shipping method, then apply discount/delivery and request a quote.
5. Submit checkout with one canonical idempotency key. Current prices, stock, tax, discount, delivery, and payment readiness are recalculated by the store.
6. COD can complete directly when enabled. Customer authentication, online payment, or payment recovery may return a fixed body-only browser continuation; follow it without exposing its fields.
7. Verify the receipt/order through the context authority. Receipt proofs, OTPs, customer cookies, and payment secrets never enter model context.
8. Close disposable contexts when the workflow finishes.

Use public reads as `visitor`; private profile/order actions require a live customer-bound context. Dashboard credentials do not impersonate customers.

## Fast cart setup

Use one sequential batch for context creation, cart mutation, and delivery selection. In MCP, give each step an `id` and reference a prior result as `{"$step":"create","pointer":"/data/data/id"}`; the cart revision is at `/data/data/context/revision`. In the CLI, use the JSON Pointer form below. This keeps IDs and revisions out of manual copy/paste:

```json
{
  "steps": [
    { "operationId": "storefront.context.create", "input": {} },
    {
      "operationId": "storefront.cart.add",
      "input": {
        "path": { "contextId": { "$ref": "#/results/0/data/data/id" } },
        "body": {
          "revision": { "$ref": "#/results/0/data/data/revision" },
          "variantId": "<variant-id>",
          "quantity": 1
        }
      }
    },
    {
      "operationId": "storefront.delivery.set",
      "input": {
        "path": { "contextId": { "$ref": "#/results/0/data/data/id" } },
        "body": {
          "revision": { "$ref": "#/results/1/data/data/context/revision" },
          "cityId": "<city-id>",
          "zoneId": "<zone-id>",
          "areaId": null,
          "shippingMethodId": "<shipping-method-id>"
        }
      }
    }
  ]
}
```

Keep checkout submission outside the batch: review the final cart/quote first, then supply its own explicit idempotency key and confirmation.
