# Bengali FTS5 Search Research

**Project:** Scalius Commerce
**Researched:** 2026-03-22
**Confidence:** HIGH (SQLite official docs) / MEDIUM (D1 tokenizer confirmation)

---

## Bengali Script Characteristics

Bengali (Bangla) is an abugida script covering Unicode block U+0980–U+09FF. Key characteristics relevant to FTS5:

**Bengali IS space-separated.** Words are delimited by ASCII spaces, the same as English. This is fundamentally different from CJK scripts (Chinese, Japanese, Korean) which have no spaces between words. The "non-Latin search problem" for Bengali is NOT word segmentation — it is syllable integrity within words.

**The actual problem: vowel signs are combining marks.**

Bengali words are composed of consonants (base letters) and dependent vowel signs (diacritics attached to consonants). These fall into different Unicode general categories:

| Character Type | Example | Unicode Category | Category Meaning |
|----------------|---------|-----------------|-----------------|
| Consonants | ক খ গ | Lo | Other Letter |
| Independent vowels | অ আ ই | Lo | Other Letter |
| Spacing vowel signs | া ো ৌ | Mc | Spacing Mark |
| Non-spacing vowel signs | ি ী ু ূ ৃ ে ৈ | Mn | Nonspacing Mark |
| Virama / Hasanta | ্ (U+09CD) | Cf | Format character |
| Chandrabindu, Anusvara | ঁ ং | Mn | Nonspacing Mark |

**The FTS5 default tokenizer (unicode61) treats L\* and N\* as tokens and everything else as separators.** This means:

- `Lo` consonants and independent vowels: tokenized correctly (they are letters)
- `Mc` spacing vowel signs: treated as word SEPARATORS — splits syllables
- `Mn` non-spacing vowel signs: treated as word SEPARATORS — splits syllables
- `Cf` virama: treated as separator — severs conjunct consonants

A word like "বাংলা" (bangla) contains:
- ব (consonant, Lo) — token
- া (vowel sign AA, Mc) — SEPARATOR under default config — **splits here**
- ং (anusvara, Mn) — SEPARATOR — **splits again**
- ল (consonant, Lo) — token
- া (vowel sign AA, Mc) — SEPARATOR — **splits again**

Under the default tokenizer, "বাংলা" produces three fragments: "ব", "ল", and nothing useful. Searching for "বাংলা" fails entirely. This is confirmed behavior in the related Devanagari script, where unicode61 was observed splitting "हैलो" (hello) into individual character components rather than keeping the word intact.

**English is unaffected.** All ASCII Latin letters are in the Lo category (treated as tokens), and ASCII spaces are the only separator used for English words. Any tokenizer change that preserves L\* category handling will not break English search.

**Real-world implication for e-commerce.** Bangladeshi merchants name products in a mix of Bengali Unicode text and English/Banglish (Bengali words typed in Latin script). The search layer must handle:
1. Pure Bengali Unicode: "শাড়ি", "পাঞ্জাবি", "মোবাইল ফোন"
2. Pure English/ASCII: "shirt", "mobile phone", "Samsung"
3. Mixed: "Samsung মোবাইল", "Men's পাঞ্জাবি"

---

## FTS5 Tokenizer Options

### Default (ASCII-based internal implementation, not the `ascii` tokenizer)

The current migration uses `CREATE VIRTUAL TABLE products_fts USING fts5(name, description, content='products', content_rowid='rowid')` with no `tokenize=` option. This defaults to `unicode61`.

**Behavior for Bengali:** Breaks words at Mc/Mn character boundaries. Produces meaningless single-consonant tokens from Bengali words. Bengali search is completely broken.

**Behavior for English:** Works correctly.

### unicode61

The default FTS5 tokenizer. Classifies characters by Unicode general category. Default token categories: `L* N* Co` (letters, numbers, private use). Everything else is a separator.

**Behavior for Bengali without configuration:** Identical to the problem described above — Mc and Mn characters break syllables.

**Behavior for Bengali with `categories 'L* N* Co Mc Mn'` configuration:**
- Mc (Spacing Mark) and Mn (Nonspacing Mark) are promoted to token characters
- Vowel signs stay attached to their consonants
- "বাংলা" tokenizes as a single token: "বাংলা"
- Conjunct consonants (e.g., ক্ষ) remain intact because the virama (Cf) is NOT a letter and still acts as separator — which in Bengali text means the conjunct components become separate tokens. This is acceptable: searching for "ক্ষ" won't work for conjuncts, but conjunct-word searches are uncommon in e-commerce product names

**Behavior for English with `categories 'L* N* Co Mc Mn'` configuration:**
- No change. ASCII Latin characters are Lo (Other Letter), which was already in L\*
- English tokenization identical to before
- remove_diacritics still applies to Latin diacritics (é → e)

**Options syntax:**
```sql
tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
```

Note: `remove_diacritics 2` (not the default `1`) correctly handles all combining diacritic cases in Latin script. This does NOT remove Bengali vowel signs even if Mc/Mn are token characters — the `remove_diacritics` option only strips recognized Latin diacritics.

**Prefix matching (`*`) with Bengali:** Works correctly. `sanitizeFtsQuery` appends `*` to each space-separated token. Since Bengali words are space-separated, each Bengali word becomes one token and `*` enables prefix matching. Searching "মোবাই" would match "মোবাইল" with the corrected tokenizer.

**Confidence:** HIGH (sourced from official SQLite FTS5 docs for category behavior). MEDIUM for the exact Mc/Mn fix effectiveness (inferred from Unicode category analysis, not a Bengali-specific SQLite test).

### trigram

Breaks every string into overlapping 3-character sequences, regardless of script. Instead of word-based tokens, it creates indexed n-grams.

**Behavior for Bengali:** Fully correct substring matching. "বাংলা" would be indexed as overlapping 3-character sequences at the byte/character level. Any substring of 3+ characters would match. Script-agnostic — makes no assumptions about word boundaries or character categories.

**Behavior for English:** Also correct, but changes the matching semantics from word-prefix matching to substring matching. "shirt" matches "t-shirt" which may or may not be desirable.

**Limitations:**
- Queries shorter than 3 Unicode characters produce no results (FTS5 trigram minimum)
- Index size is approximately 3x larger than the word-tokenized equivalent
- Write overhead is significantly higher (3x+ more index entries per character)
- Compatible with external content tables when triggers are set up correctly (the current migration pattern using AFTER INSERT/BEFORE DELETE/BEFORE UPDATE/AFTER UPDATE triggers is correct)

**D1 compatibility:** The trigram tokenizer is built into SQLite's FTS5 module and confirmed available in Cloudflare D1.

**Confidence:** HIGH (SQLite official docs, confirmed in D1 community discussions).

---

## Recommended Tokenizer

**Recommendation: unicode61 with `categories 'L* N* Co Mc Mn' remove_diacritics 2`**

**Rationale:**

1. **Bengali words are space-separated.** The word segmentation problem that forces CJK/Japanese to use trigram or pre-tokenization does not apply to Bengali. Spaces already delimit Bengali words. The only fix needed is ensuring vowel signs (Mc/Mn) are treated as token characters, not separators.

2. **Targeted fix, zero storage penalty.** Adding Mc and Mn to token categories only affects how within-word characters are classified. The FTS5 index size remains the same order of magnitude as today. Trigram's 3x index bloat is unnecessary for Bengali.

3. **English search preserved with no changes.** Latin characters are already L\* (Lo). The Mc/Mn addition only matters for characters that were previously separators — no Latin character is Mc or Mn.

4. **prefix matching (`*`) continues to work.** Because Bengali is space-separated, the existing `sanitizeFtsQuery` logic of splitting on `\s+` and appending `*` to each token works directly. No query sanitization changes are needed for Bengali words.

5. **Trigram is the right tool only when you need substring matching of arbitrary length.** For an e-commerce product search, users search for whole words or prefixes ("মোবাই" → "মোবাইল"), not arbitrary substrings of words. unicode61 with prefix matching covers this correctly.

**When trigram would be better:** If the product catalog has many conjunct-heavy words where partial conjunct search is needed, trigram would be more forgiving. But for a Bangladeshi e-commerce product catalog (garments, electronics, food, cosmetics), product names are primarily space-separated short phrases where whole-word prefix matching is sufficient.

**Tokenizer syntax for all FTS5 tables that hold Bengali text:**
```sql
tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
```

Tables that hold purely ASCII content (discounts codes, barcodes/SKUs, order IDs, phone numbers, emails) do NOT need this change. The tokenizer change should be applied selectively:

| FTS Table | Bengali Content? | Recommended Tokenizer |
|-----------|-----------------|----------------------|
| `products_fts` | YES (name, description) | unicode61 + Mc Mn |
| `categories_fts` | YES (name, description) | unicode61 + Mc Mn |
| `pages_fts` | YES (title, content_col) | unicode61 + Mc Mn |
| `customers_fts` | YES (name) | unicode61 + Mc Mn |
| `orders_fts` | YES (customer_name) | unicode61 + Mc Mn |
| `product_variants_fts` | NO (sku only) | default (unicode61) |
| `discounts_fts` | NO (code only) | default (unicode61) |
| `abandoned_checkouts_fts` | NO (phone, IDs) | default (unicode61) |

---

## Migration Strategy

FTS5 virtual tables cannot be altered with `ALTER TABLE`. The tokenizer configuration is set at creation time. Migration requires dropping and recreating the FTS5 tables with their triggers.

The existing migration pattern in `0016_fts5_search.sql` already drops all triggers and tables before recreating them. The new migration follows the same pattern.

**Migration file:** Create `packages/database/migrations/0031_bengali_fts5_tokenizer.sql`

**Migration approach:**

```sql
-- Step 1: Drop all triggers for affected tables (must drop before table)
DROP TRIGGER IF EXISTS products_fts_ai;
DROP TRIGGER IF EXISTS products_fts_bd;
DROP TRIGGER IF EXISTS products_fts_bu;
DROP TRIGGER IF EXISTS products_fts_au;
-- ... repeat for categories, pages, customers, orders

-- Step 2: Drop the FTS5 virtual tables
DROP TABLE IF EXISTS products_fts;
DROP TABLE IF EXISTS categories_fts;
DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS customers_fts;
DROP TABLE IF EXISTS orders_fts;

-- Step 3: Recreate with new tokenizer
CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  description,
  content='products',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);

-- Step 4: Recreate triggers (identical to 0016 triggers)
CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, description)
    VALUES (new.rowid, new.name, new.description);
END;
-- ... etc

-- Step 5: Rebuild index from existing data
INSERT INTO products_fts(products_fts) VALUES('rebuild');
-- ... repeat for each table
```

**No data loss.** The FTS5 tables are derived indexes over the source tables. Dropping them does not affect `products`, `categories`, `pages`, `customers`, or `orders`. The `rebuild` command at the end repopulates the FTS index from the source table content.

**D1 migration execution.** The migration file is picked up by `pnpm db:migrate:local` (local) and the deploy pipeline (`pnpm deploy` → migrate → deploy). The `-->statement-breakpoint` comments from Drizzle must be maintained between each DDL statement since D1 executes them separately.

**Downtime.** Between the DROP and the `rebuild` INSERT, the FTS tables exist but are empty. Searches during this window return no results. For a migration executed via `wrangler d1 migrations apply`, this window is milliseconds to seconds depending on table size. This is acceptable for a non-zero-downtime migration on a read path (searches degrade, not errors — the `search()` function wraps in try/catch returning empty results on error).

---

## Query Sanitization Changes

**Current `sanitizeFtsQuery` behavior for Bengali:**

```typescript
const FTS5_SPECIAL_CHARS = /["\-*(){}[\]^~:\\/<>|@#&+!?.,'=]/g;
```

This regex contains only ASCII punctuation. Bengali Unicode characters (U+0980–U+09FF) are NOT matched by this regex and pass through unchanged. This is correct.

The `split(/\s+/)` step correctly splits on spaces, which Bengali uses as word separators.

The `map((t) => \`${t}*\`)` step appends `*` for prefix matching. With the corrected tokenizer, Bengali tokens are whole words (e.g., "বাংলা"), and `বাংলা*` will correctly match "বাংলা" and any extensions.

**Required changes:** None to `sanitizeFtsQuery`. The function already handles Bengali characters correctly — the problem is in the tokenizer, not the query sanitizer.

**One edge case to be aware of:** The Bengali punctuation characters (Danda U+0964 "।", Double Danda U+0965 "॥") are not in the special chars regex. If a user includes these in a search query, they would pass through as-is and could cause FTS5 query parse errors. However, these are rare in product search contexts. If robustness is desired, add them:

```typescript
const FTS5_SPECIAL_CHARS = /["\-*(){}[\]^~:\\/<>|@#&+!?.,'=\u0964\u0965]/g;
```

This is a low-priority hardening, not a blocker.

---

## D1 Compatibility

**Confidence: MEDIUM** — D1's documentation does not enumerate supported FTS5 tokenizer options explicitly. The evidence supporting compatibility:

1. D1 is built on SQLite with FTS5 support confirmed in official Cloudflare docs ("FTS5 module for full-text search including fts5vocab")
2. The `unicode61` tokenizer with options is core SQLite FTS5 functionality, not an extension. It is compiled into SQLite's FTS5 module by default
3. The `categories` option is documented in official SQLite FTS5 docs (not a plugin or extension)
4. The current codebase already uses FTS5 with default unicode61 on D1 without issues — adding tokenizer options to the same tokenizer carries low risk
5. Community discussions confirm `trigram` (a different built-in tokenizer) works on D1, suggesting built-in tokenizers are all enabled

**Gap:** No confirmed test of `unicode61 categories 'L* N* Co Mc Mn'` specifically on Cloudflare D1. The implementation plan includes a validation step in the testing strategy below.

**What to do if the tokenizer option is rejected by D1:** Fall back to the trigram tokenizer (`tokenize = "trigram"`). Trigram is confirmed working on D1, handles Bengali correctly, and the current trigger-based external content pattern is compatible. The cost is 3x index size and slower writes.

---

## Performance Implications

**unicode61 + Mc/Mn categories:**
- Read performance: No change from current. Word-based token lookups are O(log n) in the FTS index.
- Write performance: No change. Token count per Bengali word is 1 (the whole word), same as before.
- Index size: No change. The same number of tokens per document, same index size.
- Query behavior: Prefix matching on whole Bengali words. Searching "শার্ট" finds "শার্ট" and any words starting with those characters.

**Trigram (if fallback needed):**
- Read performance: Fast for substring queries. For whole-word searches, comparable or slightly slower due to multiple trigram lookups being ANDed.
- Write performance: 3x+ more index entries per product write. Products with Bengali descriptions could generate hundreds of trigrams. Acceptable for single-tenant e-commerce at Bangladeshi merchant scale but worth monitoring.
- Index size: Approximately 3x larger than current FTS5 tables. For a catalog of 10,000 products with average 100-character descriptions, trigram index would be roughly 3-5MB vs ~1MB for unicode61.
- Query behavior: Substring matching. Searching "াড়ি" (middle of "শাড়ি") would match.

**D1 storage constraint:** D1 free tier has 5GB storage. Even with trigram 3x expansion, FTS5 tables for a typical Bangladeshi merchant catalog (thousands of products) would remain well under 50MB. Not a practical concern.

---

## Testing Strategy

### Pre-migration validation (local dev)

Before running the migration against D1, test the tokenizer option locally using the Drizzle Studio or wrangler:

```sql
-- Create a test table
CREATE VIRTUAL TABLE test_bengali USING fts5(
  name,
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);

-- Insert test data
INSERT INTO test_bengali(name) VALUES ('শাড়ি');
INSERT INTO test_bengali(name) VALUES ('পাঞ্জাবি');
INSERT INTO test_bengali(name) VALUES ('মোবাইল ফোন');
INSERT INTO test_bengali(name) VALUES ('Samsung Galaxy S24');
INSERT INTO test_bengali(name) VALUES ('লাল রঙের শার্ট');

-- Test full-word Bengali match
SELECT * FROM test_bengali WHERE test_bengali MATCH 'শাড়ি';
-- Expected: 1 row

-- Test prefix Bengali match
SELECT * FROM test_bengali WHERE test_bengali MATCH 'মোবাই*';
-- Expected: 1 row (মোবাইল ফোন)

-- Test English match still works
SELECT * FROM test_bengali WHERE test_bengali MATCH 'Samsung*';
-- Expected: 1 row

-- Test mixed query
SELECT * FROM test_bengali WHERE test_bengali MATCH 'লাল*';
-- Expected: 1 row (লাল রঙের শার্ট)

-- Test no match for partial syllable (expected failure)
SELECT * FROM test_bengali WHERE test_bengali MATCH 'শাড়';
-- Expected: 1 row (prefix match of শাড়ি)
```

If any of the full-word or English tests fail, the tokenizer option is unsupported in D1 and the fallback to trigram applies.

### Post-migration verification

After running `pnpm db:migrate:local`:

1. Use Drizzle Studio (`pnpm db:studio`) to verify FTS5 tables exist with the new tokenizer
2. Run the storefront search UI against common Bengali product names
3. Verify English search still returns results

### Common Bengali e-commerce search terms to test

| Category | Test Term | Unicode |
|----------|-----------|---------|
| Clothing | শাড়ি (saree) | শাড়ি |
| Clothing | পাঞ্জাবি (punjabi) | পাঞ্জাবি |
| Clothing | শার্ট (shirt) | শার্ট |
| Electronics | মোবাইল ফোন (mobile phone) | মোবাইল ফোন |
| Electronics | ল্যাপটপ (laptop) | ল্যাপটপ |
| Food | চাল (rice) | চাল |
| Cosmetics | ক্রিম (cream) | ক্রিম |
| Prefix test | মোবাই → মোবাইল | partial prefix |
| Mixed | Samsung মোবাইল | mixed script |

---

## Implementation Plan

### Phase 1: Database Migration (1 migration file)

Create `packages/database/migrations/0031_bengali_fts5_tokenizer.sql`:

1. Drop triggers for the 5 Bengali-content tables: products, categories, pages, customers, orders
2. Drop the 5 FTS5 virtual tables
3. Recreate all 5 tables with `tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"`
4. Recreate all triggers (identical to migration 0016)
5. Run `rebuild` on each table to repopulate from source

Tables NOT to touch (ASCII-only content): `product_variants_fts`, `discounts_fts`, `abandoned_checkouts_fts`

### Phase 2: Validation

1. Run locally: `pnpm db:migrate:local`
2. Execute the test queries from the testing strategy section
3. If tokenizer option fails (D1 does not support it): switch to `tokenize = "trigram"` in the migration

### Phase 3: Code changes (if validation passes with unicode61)

No TypeScript code changes required. `sanitizeFtsQuery` works correctly with Bengali. `ftsMatch` works correctly. The fix is entirely in the database schema layer.

Optional low-priority hardening: add Bengali danda characters to `FTS5_SPECIAL_CHARS` in `fts5.ts`.

### Phase 4: Deploy

`pnpm deploy` runs `pnpm db:migrate:local` (which targets D1 in production). Alternatively run `wrangler d1 migrations apply scalius-d1 --remote` explicitly before deploying the Worker.

**Total scope:** 1 SQL migration file. No TypeScript changes required for the primary fix. The entire implementation is a single migration file with find-and-replace of the tokenizer option across 5 virtual table definitions.

---

## Sources

- [SQLite FTS5 Extension — Official Documentation](https://www.sqlite.org/fts5.html) — tokenizer configuration, unicode61 category options, trigram behavior, external content tables
- [SQLite FTS5 Tokenizers: unicode61 and ascii — Feldroy (January 2025)](https://audrey.feldroy.com/articles/2025-01-13-SQLite-FTS5-Tokenizers-unicode61-and-ascii) — confirms unicode61 splits Devanagari (Indic sister script) into character components under default config
- [Cloudflare D1 FTS5 Japanese Search — Zenn/Cybozu Frontend](https://zenn.dev/cybozu_frontend/articles/cloudflare-d1-fts) — demonstrates D1 FTS5 limitations for non-space-separated scripts; confirms space-separated scripts (like Bengali) are fundamentally different
- [Bengali Layout Requirements — W3C](https://www.w3.org/International/ilreq/bengali/) — Bengali word boundary specification
- [Bengali Orthography — r12a](https://r12a.github.io/scripts/beng/bn.html) — confirms Bengali is space-separated; vowel signs are combining marks
- [FTS5 Trigram with External Content — SQLite Forum](https://sqlite.org/forum/info/413819ed723cc007) — confirms trigram works with external content tables when triggers populate the index
- [Faster SQLite LIKE Queries Using FTS5 Trigram — Andrew Mara](https://andrewmara.com/blog/faster-sqlite-like-queries-using-fts5-trigram-indexes) — trigram index is ~3x larger, significant write overhead
- [BanglishRev E-Commerce Dataset — arXiv 2024](https://arxiv.org/html/2412.13161v2) — confirms real-world BD e-commerce uses mixed Bengali/English/Banglish text
