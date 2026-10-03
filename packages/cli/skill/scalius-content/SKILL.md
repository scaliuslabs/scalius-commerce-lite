---
name: scalius-content
description: "Operate Scalius Commerce CMS pages/articles, navigation, header/footer, homepage/hero, themes, resource SEO, canonicals, sitemaps, structured data, and buyer projection. Use to draft, edit, move, publish, trash, restore, preview, or verify content, presentation, discovery, and storefront visibility."
---

# Scalius Content

Contracts are authority. Never invent IDs, revisions, fields, state, URLs, media IDs, or discovery claims.

## Route the task

1. Start supported reads with MCP `workflows.read`; otherwise use `workflows.resolve`. CLI: `scalius workflow read|resolve "<request>" --surface dashboard|storefront`.
2. Honor returned facts, phases, stops, confirmation, and verification. Describe selected IDs only for exact input.
3. Never use removed search, inspect source/generated contracts, or bypass grants.
4. Resolve entity/revision; ask for missing copy/placement/status/SEO/media; preserve unrelated fields and confirm the diff.

## Edit and publish

- Preserve type, revision, lifecycle, canonical, and discovery. Keep drafts private until publish; reread visibility changes.
- Edit menus/items at current revisions. Read siblings/targets, keep the draft coherent, then publish.
- Edit the header, footer, homepage sections, and hero slides only through the theme document draft (see below). Commit media before use.
- Trash, restore, and publish are revisioned. On conflict, reread; never retry stale input or infer success.

For the campaign subset, require a new unused slug and staged/non-atomic acceptance. Create draft, accept sanitized reread, then publish its revision; any active/trashed slug stops. Require a clean published main menu with no page-target match; append at current revision, publish returned revision, never update/move/reorder others. In the theme draft, change only the topBar `text` and `link` (a store path or https URL) and append desktop/mobile hero slides; stop if the draft differs from the published theme, then publish that draft revision. Require distinct desktop and mobile assets or approved reuse. Preflight unique filename/folder for at most three HTTPS imports; if uncertain, list and accept one unambiguous new exact match, never re-import. Local/base64 need upload/re-entry. Stop on ambiguity, conflict, unrelated menu drafts, or scheduling. Preserve theme/presentation; report partial work, no rollback.

## Handle themes securely

Read the theme workspace, save the shared draft at its current draft and base-published revisions, then publish that exact draft revision. Open the secure body-only preview handoff; never print, persist, log, put its code in a URL, or replay it. Verify the active theme.

## Preserve discovery truth

- Keep canonicals same-store and route-shaped; reject absolute/protocol-relative URLs, queries, fragments, spaces, and dead paths.
- Distinguish `noIndex` from `excludeFromSitemap`: noindex keeps the page reachable with `noindex,follow` but removes XML/resource JSON-LD; sitemap exclusion alone does not hide it.
- Verify bounded dashboard state and separate buyer projection. API reads do not prove remote-asset reachability, destination-link health, responsive UI, head DOM, or exact sitemap XML. Never fabricate identity, images, policy, or schema facts.
