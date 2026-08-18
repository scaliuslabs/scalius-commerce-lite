---
name: scalius-content
description: "Operate Scalius Commerce storefront content and discovery: CMS pages/articles, navigation menus/items, header, footer, homepage/hero, theme drafts and publication, resource SEO, canonical paths, robots, sitemaps, structured data, and public projection. Use to draft, edit, move, publish, trash, restore, preview, or verify content, layout, theme, SEO, discovery, and storefront visibility."
---

# Scalius Content

Treat the live workflow and operation contract as authority. Never invent IDs, revisions, fields, publication state, URLs, media IDs, or discovery claims.

## Route the task

1. For a supported natural-language data read, start with MCP `workflows.read`; otherwise use `workflows.resolve`. CLI parity is `scalius workflow read "<request>" --surface dashboard|storefront` or `scalius workflow resolve ...`.
2. Follow the returned facts, ordered phases, stop rules, confirmation, and bounded verification. Describe only selected operation IDs when their exact input schema is needed.
3. Never use the removed MCP operation-search tool, inspect repository/source/generated contracts, or bypass an unavailable grant.
4. Resolve the bounded entity and current revision. Ask for missing copy, placement, status, SEO, or media facts; preserve unrelated fields. Confirm a concrete mutation immediately before execution.

## Edit and publish

- Preserve page/article type, revision, status, canonical path, and discovery settings. Drafts remain non-public until a reviewed publish succeeds; verify admin state and storefront projection after visibility changes.
- Edit reusable navigation menus/items with current revisions. Read valid move targets first, keep the draft tree coherent, then publish.
- Prefer semantic header, footer, homepage, and hero projections over legacy aggregates. Commit media before referencing its ID.
- Treat trash, restore, and publish as revisioned mutations. On conflict, reread and reconcile; never retry stale input or infer partial-write success.

## Handle themes securely

Use draft → optional rebase → publish with exact revisions. Theme preview is a secure body-only browser continuation: let the client open its fixed handoff; never print, persist, log, put in a URL, or replay the code. Confirm publication and verify the active public theme.

## Preserve discovery truth

- Keep canonical paths same-store and route-shaped; reject absolute/protocol-relative URLs, queries, fragments, spaces, and dead arbitrary paths.
- Distinguish `noIndex` from `excludeFromSitemap`: noindex keeps the page reachable with `noindex,follow` but removes it from XML and resource JSON-LD; sitemap exclusion alone does not hide or noindex it.
- Verify relevant public canonical, robots, sitemap, Open Graph URL, and enabled JSON-LD. Never fabricate organization identity, images, return policy, or schema facts.
- Use public HTTPS import from remote MCP. Remote MCP cannot read local paths; use a capable local client's reviewed upload flow. Never embed large base64 or invent direct HTTP/upload steps.
