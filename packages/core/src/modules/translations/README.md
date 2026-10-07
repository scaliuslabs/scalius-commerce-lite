# Translations

The store's languages and the translation of its buyer text (docs/MARKETS-DESIGN.md D9, "Step 4b implemented"). Read this before a buyer-facing read shows text a merchant writes.

## Entries and layer

`index.ts` is the only entry. Layer L0, a leaf: the domain imports no other domain (it reads the source tables itself), so every domain that shows buyer text can import it. `markets`, `catalog`, `categories`, `brands`, `pages`, `navigation`, `checkout`, `notifications` and `storefront` do.

## The rules

- `store_languages` is the one list of the store's languages. The default language is the backup market's root presence locale. A presence names a store language; only a published language's presences are served (the matrix filters them).
- `resolveTranslatedRecord()` and `translationChain()` in `@scalius/shared/translations` are the one fallback: the page's locale in its market, the page's locale, the default locale in the market, the default locale, then the source value. An empty field falls through.
- A translation records the digest of each field's source (`source_digest`). A source edit marks the field Outdated; outdated text is still served (Shopify).
- A root read folds no translation and keeps its bytes. A presence read folds its translations into a statement it already runs (`translationColumns`, `productTranslationRowsSql`), or, for rows from code or another read (delivery rates, payment methods), reads them in one statement (`readTranslationChains`).
- A handle lookup tries the source handle, then a localized one (the page's language first, else any): a buyer who switches language on a localized URL still reaches the page.

## Files

| File | Purpose |
|------|---------|
| `store-languages.service.ts` | The language list: add, publish, remove, make default; `ensureStoreLanguageWrites` for market writes; the checkout copy in use follows the default language. |
| `translations.service.ts` | The editor: list resources with their status, one resource with its parts, save (digest per field, localized handle), delete. |
| `resources.ts` | The source side of each type: table, columns, title, handle; a product's options and values; a menu's links. |
| `fold.ts` | The SQL a read folds in, and the chains it resolves. |
| `rows.ts` | `translationColumns` and `translateRows`: the columns a row statement adds at a presence and the step that applies them. |
| `checkout-copy.ts` | The checkout copy of a page's language: its own copy, its built-in copy, else the default language's. |

## Cache dependencies

`tr:<type>:<id>` per resource (a product's options and values advance `tr:product:<id>`), `tr:slugs:<type>:<locale>` for a handle space, `tr:locales` for the presences' locales, the default language and the published languages. A read of more than 128 resources declares the coarse `t:translations` and `t:localized_slugs`.

## Deferred

Search matches and sorts by source text. Attribute names and values, theme text, the SEO document, email, SMS and invoice templates, and agent product sections serve the source text. The platform has no machine translation provider; an app provides one through the `translation` port.
