# Pages

Static CMS pages and chronological articles (one `pages` table), their publish and schedule workflow, and the store policy pages. Read this before you change a page write, a public page read or the policy links. Navigation owns where a page appears in menus.

## Entries and layer

- `browser.ts` exports `pages.validation.ts` (page schemas, `contentEntryPath`, `isValidContentEntryPath`, `PAGE_BATCH_LIMIT` 90). `index.ts` exports everything in `browser.ts`, plus `pages.service.ts`, `pages.revision.ts` and `store-policies.ts`.
- Layer L4. The domain imports `custom-fields`, `media-references` and `settings`. `navigation` and `storefront` import `pages`.

## Owns

| Table | Key columns and constraints |
|-------|-----------------------------|
| `pages` | `id` (prefix `page_` or `article_`), `content_type` (`page`, `article`; never changes), `slug` (unique across live and trashed rows), `content` (sanitized HTML), `tags` (articles only; a CHECK keeps them empty on a page), SEO fields (`canonical_path`, `no_index`, `exclude_from_sitemap`), `is_published`, `published_at`, `hide_header`, `hide_footer`, `hide_title`, `revision`, `deleted_at` |

`pages.sort_order` is internal: new rows write 0, and no write input or admin sort uses it. Admin search uses the `pages_fts` full-text index.

The domain declares no settings document. The `policies` document (`refund`, `privacy`, `terms`, `shipping`, `contact`, each a page id or null) is declared in `settings/documents.ts`; `store-policies.ts` reads and writes it.

DVC: public readers declare `deps.page(id)`, or `deps.anyPage()` when a slug lookup finds nothing. A page scheduled for later declares `deps.validUntil` at its `published_at`, so the cache entry ends when the page goes live.

## Routes

- Admin: `/api/v1/admin/pages` in `apps/api/src/routes/admin/pages.ts`: `GET /` (filter by `contentType`, `status`, `trashed`; page and limit paging), `POST /`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}`, `DELETE /{id}/permanent`, `POST /{id}/restore`, `POST /bulk-delete`, `/bulk-publish`, `/bulk-unpublish`, `/bulk-restore`.
- Public pages: `/api/v1/pages` in `apps/api/src/routes/pages.ts`: `GET /`, `GET /slug/{slug}`, `GET /{id}`.
- Public articles: `/api/v1/articles` in `apps/api/src/routes/articles.ts`: `GET /` (newest first, limit at most 24, optional `tag`), `GET /slug/{slug}`.
- Store policies: `GET` and `PUT /api/v1/admin/settings/policies` in `apps/api/src/routes/admin/settings/policies.ts`.

Permissions are in `packages/core/src/auth/rbac/route-permissions/content.ts` (`pages.view`, `create`, `edit`, `delete`, `publish`). Policies need `settings.general.view` to read and `settings.seo.edit` to save. The storefront serves pages at `/{slug}` and articles at `/blog/{slug}`; it renders page data from `GET /api/v1/storefront/pages/slug/{slug}` (see `storefront`).

## Rules

- **Revision guard.** Every edit and lifecycle command carries a positive `expectedRevision`. A stale claim is `page_revision_conflict` (409); the wrong lifecycle state is `page_state_conflict` (409). Bulk commands take at most 90 unique claims and apply all or none.
- **Lifecycle.** Create defaults to draft. Trash and restore force draft and clear the schedule. Permanent delete works only from trash.
- **Publish authority.** Changing `is_published` or `published_at` needs `pages.publish`. The route passes `canPublish`; without it the service throws `ForbiddenError`. An ordinary edit may keep the current publication state.
- **Visibility.** A page is public when it is not trashed, `is_published` is true and `published_at` is null or not in the future.
- **Slugs.** A slug is 3 to 100 characters of lowercase letters, digits and single hyphens. An omitted slug derives from the title and gets `-2`, `-3` until free and not reserved. A typed taken slug is a conflict, trash included. Reserved storefront roots (the list in `packages/shared/src/seo-canonical.ts`) and the slug of a dashboard served below the storefront host are refused.
- **Canonical path** is optional. A page uses one non-reserved `/<slug>` segment. An article uses `/blog/<slug>`.
- **Content.** The service sanitizes HTML on write and again on public read. A write that names a file in deleting state is refused (`media-references` guard).
- **Articles.** `excerpt`, `author` and `tags` (at most 20, unique ignoring case) exist only on articles. A static page that carries them is refused.
- **Public shape.** Public reads omit `revision` and keep `updatedAt` for sitemap lastmod. Public page reads by id or slug also carry the storefront-visible `customFields`.
- **Display flags** `hideHeader`, `hideFooter` and `hideTitle` are read by the storefront layout (`apps/storefront/src/pages/[slug].astro` and `blog/[slug].astro`). The storefront replaces `[product slug="..."]` in page content with a product card (`apps/storefront/src/lib/shortcodes.ts`).
- **Store policies.** `saveStorePolicies` links only the store's own pages (`content_type = 'page'`, not trashed, drafts allowed) and takes the document's `expectedRevision`. Buyers see a linked policy only while its page is public (`planPublicStorePolicies`, batched into the storefront layout read).
