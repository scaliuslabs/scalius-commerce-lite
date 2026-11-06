# Media references

How other records point at a stored file: the published object key, the URL and poster projection, and the batch guard that refuses a reference to a file being deleted. Audience: contributors who write a record that embeds a file.

The Files library itself (uploads, trash, renditions, usage index, permanent delete) is [`media`](../media/README.md).

## Entries

`index.ts` is the only entry. There is no `browser.ts`.

| File | Exports | Purpose |
|------|---------|---------|
| `presentation.ts` | `publishedMediaObjectKey()`, `presentMediaProjection()`, `MediaPosterProjection` | `publishedMediaObjectKey()` is the SQL for the key a joined `media` row publishes: the largest rendition when `variant_width` is set, else the original. `presentMediaProjection()` turns stored keys into public URLs and drops the joined poster columns. |
| `reference-guard.ts` | `noDeletingMediaReferences()`, `hasDeletingMediaReference()`, `isMediaReferenceDeletingGuardError()`, `MEDIA_REFERENCE_DELETING_MESSAGE` | The `MEDIA_REFERENCE_DELETING` batch guard for a write that stores a media URL. |

## Layer and imports

- Layer L0. It imports no domain. It reads the `media` table and uses `packages/core/src/integrations/storage.ts` for the URL base.
- Imported by `agent-storefront`, `categories`, `media`, `orders`, `pages`, `reviews`, `settings` and `warranty`. Because it is a leaf, these writers do not load the Files library.

## Rules

- A URL-bearing write adds `noDeletingMediaReferences(value)` to its D1 batch. The guard fails when the value contains the object key of a media row in `deleting` or `deleted` status. It skips values without `media/`.
- `hasDeletingMediaReference()` is the same check as a read, for early validation. The batch guard stays the authority.
- A poster that is not a `ready` or `trashed` image projects as `posterUrl: null`. So does a poster whose URL would be a bare object key (no media base URL). The dashboard then shows its neutral video placeholder.
- The usage index and permanent delete stay in `media`, because they must read every referrer.
