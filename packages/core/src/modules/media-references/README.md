# Media References

How other records point at a stored file. Depends on no other domain, so any
writer that embeds a file can use it without loading the Files library
(`modules/media`).

| File | Exports | Purpose |
|------|---------|---------|
| `presentation.ts` | `publishedMediaObjectKey()`, `presentMediaProjection()`, `MediaPosterProjection` | The SQL key of a published media object and its URL/poster projection for any reader |
| `reference-guard.ts` | `noDeletingMediaReferences()`, `hasDeletingMediaReference()`, `isMediaReferenceDeletingGuardError()`, `MEDIA_REFERENCE_DELETING_MESSAGE` | The `MEDIA_REFERENCE_DELETING` batch guard a URL-bearing write adds, so it never commits a reference to a file that is being deleted |

Writers: the business settings document (`settings`), categories, pages and
staff photos (API). The usage index and permanent delete stay in
`modules/media`, which must read every referrer.
