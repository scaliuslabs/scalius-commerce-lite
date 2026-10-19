---
name: scalius-content
description: Edit what a Scalius store shows. Use to write and publish pages (About Us, policies) and articles, edit menus and the footer, change the homepage, hero or header through the theme draft and publish it, restore theme versions, and set page SEO, canonical paths and sitemap inclusion.
license: AGPL-3.0-only
---

# Scalius Content

Follow the loop in `scalius`. Recipes: [references/recipes.md](references/recipes.md). Reviewed workflows: [references/workflows.md](references/workflows.md).

## Words are the merchant's

Write copy only from what the merchant gave or approved. Ask for anything missing (title, slug, placement, publish now or later). Preserve every field you were not asked to change.

## Pages and menus

- Pages and articles: create (published or draft), then verify with `dashboard.content.get`. Slugs are one segment; a taken slug stops the task.
- Menus: read the menu and its revision, add or move items at that revision, then publish the menu. `dashboard.navigation.placements_list` tells you which menu is the header or footer.
- Link to a store page by resource (`labelMode: resource`), not by typing a URL.

## Theme

1. `dashboard.theme.workspace_get` for the draft and live revisions.
2. `dashboard.theme.document_get` for the whole draft.
3. `dashboard.theme.draft_save` the whole document with only the requested change, at the current draft and published revisions.
4. Show the merchant the change (a preview session when they want to look), then `dashboard.theme.publish` that exact draft revision.

The header, footer, homepage sections and hero slides live in the theme document. Commit images first (see `scalius-catalog`). On a conflict, reread; never save a stale document.

## Discovery

- Canonical paths are store paths of the right shape (`/products/<slug>`, `/categories/<slug>`, `/collections/<id>`, a page `/<slug>`); never full URLs, queries or fragments.
- `noIndex` keeps a page reachable but hides it from search engines; `excludeFromSitemap` only leaves it out of the sitemap.
- Never invent structured data, images or policy facts. Store-wide SEO is a separate request from a page edit.
