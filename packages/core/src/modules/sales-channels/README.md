# Sales channels

Where products are published (docs/MARKETS-DESIGN.md D6, "Step 5 implemented"): the channels, the products published to each, and the locations whose stock each sells. Read this before you change which products a surface shows or which stock a channel sells.

## Entries and layer

`index.ts` is the only entry. Layer L4: the domain imports `products` (the publication statements and the catalogue projection refresh). `orders` imports it (a staff order's channel).

The SQL that buyer reads fold into their own statements is a product fact and lives in [`products/channel-publications.ts`](../products/channel-publications.ts): `productPublishedToChannelSql`, `salesChannelActiveSql`, `channelAvailableStockSql` and the publication write statements.

## Tables

| Table | Holds |
|-------|-------|
| `sales_channels` | The built-in `sc_online_store` (always active), `sc_google`, `sc_meta`, `sc_agents`, and an app's `<plugin id>:<id>` channels (`plugins/installations.ts` writes them). |
| `product_channel_publications` | A product is published to a channel while its row has no `unpublished_at`. A new product is published to every channel (trigger). |
| `sales_channel_locations` | The locations whose on-hand a channel sells. A new channel links every location and a new location every channel (triggers). |

## Rules

- The online store's publication is part of public eligibility and of `product_buyer_state.is_public`. A feed and UCP need their own channel's publication and the online store's, and list nothing while their channel is inactive.
- A channel sells `stock - reserved_stock` minus the SKU's levels at its unlinked locations; reservations stay location-free. No per-channel stock count is stored.
- `setProductPublications` writes up to 90 products on up to 10 channels in one batch; a write that touches the online store refreshes the buyer state in that batch. `setProductChannels` sets one product's channels exactly. Neither changes the product's revision.
- `updateSalesChannel` refuses switching the online store off, switching an app's channel on (the app's status decides) and a channel with no active location. A location change answers `locationsChanged`; the API then requests a catalogue projection rebuild.
- `resolveStaffOrderSalesChannel`: an active channel, else the online store. Staff may sell any product.
- `listChannelProducts` pages a channel's live published product ids (keyset by id, at most 100): the port a sales-channel app syncs from, with the `product.publication_changed` event.
- Triggers keep the online store, a channel's kind and app, an order's channel, and refuse to delete a channel with orders. Unpublishing a product and switching a channel off advance the checkout authority fence.
- DVC: `sales_channels` advances `lm:seo`; publications advance `p:<product>` and `lm:seo` (the online store's also `lm:all` and `srch`); a location link advances `store`; a stock level at a location some channel does not sell advances its SKU's `p:`.

## Routes

| Method and path | Function | Permission |
|-----------------|----------|------------|
| `GET /api/v1/admin/settings/sales-channels`, `GET /{id}` | `listSalesChannels`, `getSalesChannel` | `settings.general.view` or `products.view` |
| `PATCH /api/v1/admin/settings/sales-channels/{id}` | `updateSalesChannel` | `settings.general.edit` |
| `GET /api/v1/admin/settings/sales-channels/{id}/products` | `listChannelProducts` | `products.view` |
| `PUT /api/v1/admin/products/{id}/publications` | `setProductChannels` | `products.edit` |
| `POST /api/v1/admin/products/publications` | `setProductPublications` | `products.bulk_operations` |
