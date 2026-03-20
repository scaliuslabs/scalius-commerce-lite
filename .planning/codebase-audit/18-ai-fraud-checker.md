# Audit 18 -- AI Module & Fraud Checker

**Scope:** AI context/prompts, OpenRouter integration, manual fraud checking tool
**Files reviewed:**
- `packages/core/src/modules/ai/ai-config.ts`
- `packages/core/src/modules/ai/ai-context-schema.ts`
- `packages/core/src/modules/ai/prompt-helper-v2.ts`
- `packages/core/src/modules/ai/index.ts`
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts`
- `packages/core/src/modules/fraud-checker/provider.ts`
- `packages/core/src/modules/fraud-checker/index.ts`
- `apps/api/src/routes/admin/ai-context.ts`
- `apps/api/src/routes/admin/ai-prompts.ts`
- `apps/api/src/routes/admin/openrouter.ts`
- `apps/api/src/routes/admin/fraud-checker.ts`
- `apps/api/src/routes/admin/settings/integrations.ts`
- `apps/admin/src/components/admin/FraudCheckerSettings.tsx`
- `apps/admin/src/lib/client/fraud-checker-actions.ts`
- `apps/admin/src/components/admin/order-list/FraudCheckIndicator.tsx`

---

## 1. Architecture Overview

### AI Module (`packages/core/src/modules/ai/`)

Three files compose the AI subsystem:

| File | Responsibility |
|------|---------------|
| `ai-config.ts` | Centralized constants: OpenRouter URLs/headers, model capabilities per provider, generation timeouts/retries, prompt instruction templates, UI config, error/success message catalogs |
| `ai-context-schema.ts` | Zod schema for widget AI context (persisted to DB): product/category/image references, staged generation plans, improvement history. Parse/serialize/merge helpers with multi-layer recovery |
| `prompt-helper-v2.ts` | Structured message builder: assembles system prompt + product/category/image context + user request into OpenRouter-compatible message arrays with per-provider cache_control |

The AI module does NOT call OpenRouter itself. It is a prompt-preparation library consumed by the admin frontend and proxied through the API routes. The actual LLM call happens server-side in the OpenRouter route (`apps/api/src/routes/admin/openrouter.ts`).

### Fraud Checker (`packages/core/src/modules/fraud-checker/`)

Two files:

| File | Responsibility |
|------|---------------|
| `fraud-checker.service.ts` | CRUD for fraud checker providers (stored in `settings` table), phone lookup dispatching, test-connection helper |
| `provider.ts` | Provider interface + registry pattern. Default provider: HTTP POST with phone FormData + Bearer token, parses delivery stats, computes risk level from cancel rate |

The fraud checker is a **manual merchant tool** (per project intent docs). The admin clicks a shield icon on an order row, which triggers a phone lookup against a third-party delivery fraud API. It is NOT automated checkout blocking.

### API Routes (4 files)

| Route prefix | File | Purpose |
|-------------|------|---------|
| `/admin/ai-context` | `ai-context.ts` | Batch fetch product/category details with prices, URLs, variants, attributes for AI prompt context |
| `/admin/ai-prompts` | `ai-prompts.ts` | Fetch system prompt text from external URLs |
| `/admin/openrouter` | `openrouter.ts` | List models, generate (standard + staged), proxies to OpenRouter API |
| `/admin/fraud-checker` | `fraud-checker.ts` | CRUD providers, test connection |

---

## 2. AI Module Analysis

### 2.1 Configuration (`ai-config.ts`)

**Strengths:**
- Excellent centralization. Every magic number (timeouts, retry delays, token thresholds, temperature values) lives in one file with clear section headers.
- Provider-aware model capabilities (Anthropic/OpenAI/Google/default) for cache tokens, breakpoints, TTLs, max images.
- Helper functions (`getProviderFromModel`, `getRetryDelay`, `isRetryableStatus`, etc.) are pure and well-typed.
- Comprehensive error/success message catalog prevents string duplication.
- Type exports (`PromptType`, `ModelProvider`, `OperationType`) for consumers.

**Issues:**

1. **Hardcoded external URLs** -- `SYSTEM_PROMPT_URLS` points to `text.wrygo.com` (lines 13-17). The same URLs are duplicated in `ai-prompts.ts` route (lines 8-12). This is a maintenance hazard: the config file exists specifically to centralize these values, but the route ignores it and redeclares them.

2. **Prompt instruction format mismatch** -- `PROMPT_INSTRUCTIONS.json` tells the LLM to use `<htmljs>` / `<css>` tags (line 128-144), NOT JSON. But the field name is `json` and the fallback prompts in `SYSTEM_PROMPT_FALLBACKS` say "Always return valid JSON with html and css fields" (lines 20-31). This contradiction would confuse the LLM when the external prompt is unavailable and the fallback is used.

3. **Fallback prompts never used** -- `SYSTEM_PROMPT_FALLBACKS` is defined (lines 19-31) and exported, but never imported anywhere. If the external prompt fetch fails, the `ai-prompts.ts` route throws an error rather than returning a fallback. The fallback mechanism is dead code.

### 2.2 Context Schema (`ai-context-schema.ts`)

**Strengths:**
- Thorough Zod schema with sensible defaults and optional fields.
- Three-tier parse recovery: (1) direct safeParse, (2) field-by-field recovery with array guards, (3) empty defaults. Handles double-stringified legacy data.
- Clean serialize/merge helpers.

**Issues:**

4. **`z.url()` may not exist in all Zod versions** -- `MediaFileSchema` uses `z.url()` (line 12) and `ProductReferenceSchema` uses `z.url().nullable()` (line 27). The `z.url()` validator was added in Zod 3.23+. If the project ever pins an older Zod version, this will break silently at runtime rather than compile time (Zod schemas are runtime-validated). This is low risk but worth noting.

5. **Recovery logic duplicates defaults** -- The `parseAiContext` recovery block (lines 126-139) manually specifies defaults that overlap with the schema's `.default()` calls. If schema defaults change, the recovery block could silently use stale values.

### 2.3 Prompt Builder (`prompt-helper-v2.ts`)

**Strengths:**
- Clean separation of static (cacheable) vs. dynamic (per-request) content.
- Provider-aware `shouldApplyCache` -- only adds `cache_control` for Anthropic models, correctly avoiding interference with auto-caching models.
- Multimodal support: properly handles vision-capable models by sending images as `image_url` content parts.
- Image dimension fetching with graceful fallback on failure.
- Metadata tracking (token estimates, image/product/category counts).
- Backward-compatible `generateCompletePrompt` that wraps the new structured API.

**Issues:**

6. **Browser-only API (`new Image()`)** -- `getImageDimensions` (line 142) uses `new Image()` which is a browser DOM API. The `/// <reference lib="dom" />` at line 1 makes TypeScript happy, but this function cannot run in a Cloudflare Worker or Node.js environment. Since the prompt builder is in `@scalius/core` (a shared package), this limits where it can be imported. Currently safe because it is only called from the admin frontend, but the package location is misleading.

7. **`imageCount` metadata is wrong** -- Line 532 reports `imageCount: selectedImages.length`, but the actual images sent include product images and category images too (lines 385-402). The metadata undercounts the real image payload.

8. **Token estimation is very rough** -- `Math.ceil(length / 4)` (line 525) is a char-based approximation. For multilingual content (e.g., Bengali product names), this underestimates significantly since non-Latin scripts use more tokens per character. Not a bug, but the metadata should document the approximation.

9. **No system message** -- All content is packed into a single `user` message with content parts. The system prompt is embedded as the first text block in the user message rather than using `role: "system"`. This works with OpenRouter but loses the semantic benefit of a separate system message for models that distinguish them. Some models treat system messages differently for safety and instruction following.

### 2.4 Module Index (`index.ts`)

Clean barrel export. Re-exports everything from all three files.

---

## 3. Fraud Checker Analysis

### 3.1 Service (`fraud-checker.service.ts`)

**Strengths:**
- Clean CRUD operations against the `settings` table (KV-style storage).
- Proper error types (`NotFoundError`, `ValidationError`, `ServiceUnavailableError`).
- `fraudLookupWithActiveProvider` finds the first active provider automatically.
- Test connection uses a dummy phone number (`+8801700000000`).

**Issues:**

10. **API key stored in plaintext** -- Unlike the delivery providers module (which uses AES-GCM encryption for credentials per recent changes), fraud checker provider API keys are stored as plain JSON in the `settings` table. This is inconsistent with the rest of the codebase's credential handling.

11. **No rate limiting on lookups** -- `fraudLookup` makes an external API call on every invocation with no deduplication or throttling. A merchant repeatedly clicking the shield icon (or an automated script hitting the endpoint) would burn through the external API quota. The FraudCheckIndicator component does prevent re-fetch on re-open (`if (open && !fraudData && !isLoading)`), but that is client-side only.

12. **Test connection uses real API call** -- `testFraudProvider` sends a request to the external API with a known phone number. If the external API charges per request, this costs money on every test.

13. **Multiple active providers ambiguous** -- `fraudLookupWithActiveProvider` uses `providers.find(p => p.isActive)` which returns the first active provider by insertion order. If multiple providers are active, the selection is non-deterministic (depends on DB row order). There is no UI indication of priority.

### 3.2 Provider Pattern (`provider.ts`)

**Strengths:**
- Clean interface (`FraudCheckProvider`) with `name` + `lookup()`.
- Registry pattern with `Map<string, FraudCheckProvider>` and fallback to default.
- `registerFraudCheckProvider` allows adding custom providers.
- Risk level computation is simple and reasonable (cancel rate thresholds: 50%+ = high, 20%+ = medium, else low, 0 parcels = unknown).
- Uses `formatPhoneForProvider` from shared utils for phone normalization.

**Issues:**

14. **Registry uses module-level `Map`** -- `const providers = new Map(...)` at module scope (line 93). In Cloudflare Workers, module-level state persists within a single isolate but is NOT shared across isolates. This is fine for the default provider (always registered), but any custom provider registered via `registerFraudCheckProvider` would only exist in the isolate that registered it. This is a latent footgun if custom providers are ever used.

15. **`getFraudCheckProvider` silently falls back** -- If a provider type is requested that does not exist, it silently returns the default provider (line 110). No warning or log. A typo in `providerType` would cause the wrong provider to be used with no indication.

### 3.3 Module Index (`index.ts`)

Exports everything needed. Notably exports both `FraudCheckResult` (from service, user-facing) and `ProviderFraudCheckResult` (from provider, internal). The naming with the alias is correct but the dual-type situation is somewhat confusing.

---

## 4. API Routes Analysis

### 4.1 AI Context Route (`ai-context.ts`)

**Strengths:**
- Efficient batch fetching with `Promise.all` for images, variants, attributes, categories.
- Computes final prices with discount logic.
- Generates storefront URLs for products and buy-now links.

**Issues:**

16. **No pagination or limits** -- The batch endpoint accepts arbitrary arrays of `productIds` and `categoryIds` with no size limits. `allCategories: true` fetches every category. Combined with the parallel variant/image/attribute fetches, a large store could produce a very large response.

17. **Route response schema is empty** -- `responses: { 200: { description: "Batch details" } }` (line 75-76) has no response body schema. This means the OpenAPI spec documents no return type for this endpoint. Same issue on all four AI routes and the fraud checker routes. This is a pattern across the codebase but worth flagging for the AI routes specifically since they are newer.

18. **Price calculation duplicated** -- `calculateFinalPrice` (lines 43-58) is defined locally in the route file. This same logic almost certainly exists in the products or pricing service. Duplication risks drift.

### 4.2 AI Prompts Route (`ai-prompts.ts`)

**Issues:**

19. **URL duplication (repeat of #1)** -- Redeclares `PROMPT_URLS` (lines 8-12) instead of importing from `ai-config.ts` where `SYSTEM_PROMPT_URLS` already has the same values.

20. **No fallback on fetch failure** -- When the external prompt URL fails, the route throws (line 59) instead of returning a fallback. `SYSTEM_PROMPT_FALLBACKS` in `ai-config.ts` exists exactly for this purpose but is unused.

21. **Cache header but no server-side cache** -- Returns `Cache-Control: public, max-age=300` (line 55) for the client, but does no server-side caching. Every request re-fetches from `text.wrygo.com`. In a Cloudflare Worker, the Cache API or KV could trivially cache this.

22. **Prompt type is not validated** -- `type` query param is `z.string().optional().default("widget")` but accepts any string (line 21). Invalid types silently fall through to `PROMPT_URLS.widget` via `|| PROMPT_URLS.widget` (line 32). Should use `z.enum(["widget", "landing-page", "collection"])`.

### 4.3 OpenRouter Route (`openrouter.ts`)

**Strengths:**
- API key fetched from DB on each request (not cached in memory).
- AbortController with configurable timeout.
- Cache hit rate logging for Anthropic models.
- Streaming support (returns raw SSE body).
- Staged generation with per-stage temperature and timeout.
- Planning stage uses `response_format: { type: "json_object" }`.

**Issues:**

23. **API key query missing `category` filter** -- The OpenRouter route queries `settings` with `eq(settings.key, "openrouter_api_key")` only (lines 102, 242). But the integrations settings route SAVES the key with `category: "integrations"` (line 64 of integrations.ts). If another setting with key `openrouter_api_key` exists in a different category, the wrong value could be returned. The `.get()` call returns the first match. The save path (integrations.ts) correctly uses both `key` and `category`, but the read path (openrouter.ts) only uses `key`.

24. **`content: z.any()` in message schema** -- The generate schema uses `z.any()` for message content (line 75) and images (line 78). This bypasses all validation. Malicious or malformed payloads pass through to OpenRouter unvalidated. While OpenRouter itself will reject bad payloads, the API should validate its own inputs.

25. **Streaming response bypasses envelope** -- When `stream: true`, the route returns a raw `Response` object (lines 177-184) instead of using Hono's response helpers. This is necessary for SSE, but it means streaming responses do not follow the `{ success: true, data: T }` envelope contract. Consumers must handle this case specially.

26. **Error responses use `ValidationError` for all failures** -- API errors, timeouts, and upstream failures all throw `ValidationError` (lines 107, 127, 174, 203, 304, 329). A 502 from OpenRouter is not a validation error. Should use `ServiceUnavailableError` or a dedicated upstream error type.

27. **No cost tracking or usage logging** -- Token usage is logged to console but not persisted. For a feature that costs real money per API call, there is no way to audit spend or set limits.

### 4.4 Fraud Checker Route (`fraud-checker.ts`)

**Strengths:**
- API key masking on all responses (`MASKED_VALUE = "..."`).
- Smart update handling: if the masked value is sent back in an update, it fetches the real key from DB rather than overwriting.
- Clean CRUD mapping to service layer.

**Issues:**

28. **Missing `/lookup` endpoint** -- The `FraudCheckIndicator` component calls `POST /api/v1/admin/fraud-checker/lookup` (FraudCheckIndicator.tsx line 25), but no such route exists in `fraud-checker.ts`. The route file only has list, create, update, delete, and test. This means the actual fraud check from the order list UI is broken -- it will 404.

29. **No `providerType` in create/update schemas** -- The create schema (lines 42-47) and update schema (lines 82-87) do not include a `providerType` field. The service layer supports it and defaults to `"default"`, but there is no way to configure a non-default provider type through the API.

---

## 5. Admin Frontend Analysis

### 5.1 FraudCheckerSettings Component

**Strengths:**
- Clean list/detail split layout with provider selection.
- Loading/saving/deleting states prevent double-clicks.
- API key shown as password field during edit.

**Issues:**

30. **Global `window.fraudCheckerActions` pattern** -- The component relies on `window.fraudCheckerActions` being set by an external script. This is a fragile coupling pattern -- if the script fails to load or initializes late, all actions silently fail (each handler checks `if (!window.fraudCheckerActions)` and shows a toast). A more robust approach would be to inject the actions as props or use a context provider.

31. **No URL validation** -- The API URL field accepts any string. No `z.url()` or even basic format checking on the client side.

### 5.2 Fraud Checker Actions (`fraud-checker-actions.ts`)

**Issues:**

32. **URL path mismatch (critical bug)** -- `deleteProvider` calls `/api/v1/admin/settings/fraud-checker/${id}` (line 53) and `testProvider` calls `/api/v1/admin/settings/fraud-checker/${id}/test` (line 74). But the fraud checker routes are mounted at `/api/v1/admin/fraud-checker`, NOT under `/admin/settings/`. The `saveProvider` call correctly uses `/api/v1/admin/fraud-checker` (line 31). This means **delete and test are broken** -- they hit non-existent routes and 404.

33. **Inconsistent type definitions** -- The actions file defines its own `FraudCheckerProvider` type with `[key: string]: unknown` (lines 3-6), while the component imports the type from `@scalius/core`. These types are structurally different. The actions type is too loose and loses all field information.

### 5.3 FraudCheckIndicator Component

**Strengths:**
- On-demand loading: only fetches fraud data when popover opens.
- Visual risk indicators with color-coded shield icons and progress bar.
- Courier breakdown display when available.
- Refresh button for re-checking.

**Issues:**

34. **Calls non-existent endpoint (critical bug, repeat of #28)** -- `POST /api/v1/admin/fraud-checker/lookup` does not exist. This component is completely non-functional.

35. **`any` types** -- `fraudData` is `useState<any>(null)` (line 20) and the courier data callback uses `[string, any]` (line 170). The FraudCheckResult type from the service is well-defined and should be used here.

36. **Risk calculation differs from server** -- The component uses delivery rate (delivered/total) with 80%/50% thresholds (lines 56-67), while the server provider uses cancel rate (cancelled/total) with 50%/20% thresholds. These produce different results. Example: 70% delivered, 30% cancelled => server says "high" (cancel rate 0.3 >= 0.2 but < 0.5, so "medium") but client says "yellow" (delivery rate 70% < 80% but >= 50%). The component ignores the server's `riskLevel` entirely and recomputes locally.

37. **`orderId` prop is unused** -- The component accepts `orderId` in props (line 14) but never uses it. Dead parameter.

---

## 6. Security Analysis

### 6.1 API Key Handling

| Key | Storage | Encryption | Masking |
|-----|---------|-----------|---------|
| OpenRouter API key | `settings` table, category `integrations` | None (plaintext) | Masked in GET response |
| Fraud checker API key | `settings` table, category `fraud-checker` | None (plaintext) | Masked in list/create/update responses |

Both API keys are stored in plaintext in the database. This contrasts with delivery provider credentials which use AES-GCM encryption. The inconsistency is a security gap.

### 6.2 Rate Limiting

- **OpenRouter `/generate`**: No rate limiting. Each request costs money.
- **OpenRouter `/models`**: No rate limiting. Fetches from OpenRouter API.
- **AI prompts**: No rate limiting. Fetches from external URL.
- **Fraud checker lookup**: No rate limiting. Calls external paid API.
- **AI context batch**: No rate limiting. Can trigger large DB queries.

All AI and fraud checker endpoints rely solely on admin authentication (RBAC middleware). There is no per-user or per-time-window rate limiting.

### 6.3 Input Validation Gaps

- OpenRouter generate: `content: z.any()` and `images: z.array(z.any())` pass arbitrary data to the LLM API.
- AI prompts: `type` query accepts any string, no enum validation.
- AI context batch: No limits on array sizes.
- Fraud checker: No phone format validation in the (missing) lookup endpoint.

---

## 7. Provider Pattern Consistency

Compared to other provider patterns in the codebase (delivery, payment):

| Aspect | Delivery Providers | Payment Providers | Fraud Checker |
|--------|-------------------|-------------------|---------------|
| Interface | `DeliveryProvider` | Per-gateway classes | `FraudCheckProvider` |
| Registry | Map-based | Switch/factory | Map-based |
| Credential storage | AES-GCM encrypted | Env vars / settings | Plaintext JSON |
| Validation | Zod schemas | Zod schemas | Basic null checks |
| Config pattern | DB-backed with encryption | Mixed (env + DB) | DB-backed, plaintext |

The fraud checker follows the delivery provider pattern structurally (interface + registry Map + service CRUD) but lacks the security hardening (encryption) that delivery providers received in recent updates.

---

## 8. LLM-Friendliness Assessment

Ironic but important: can an LLM understand and work with the AI module?

**Strengths:**
- `ai-config.ts` is extremely well-organized with clear section headers and JSDoc comments.
- Constants are named descriptively (`SYSTEM_PROMPT_CACHE_TTL`, `MODEL_CAPABILITIES`).
- The structured message format in `prompt-helper-v2.ts` follows OpenAI/Anthropic conventions.
- Error messages are centralized and human-readable.

**Weaknesses:**
- The relationship between `ai-config.ts` (package), `ai-prompts.ts` (API route), and the admin frontend prompt fetching is not obvious. The config defines URLs and fallbacks that the route ignores.
- The `PROMPT_INSTRUCTIONS.json` name suggests JSON output but the actual instructions describe custom XML-like tags (`<htmljs>`, `<css>`).
- No architecture diagram or data flow explanation in the module.

---

## 9. Issues Summary

### Critical (broken functionality)

| # | Issue | Location |
|---|-------|----------|
| 28/34 | **Missing `/lookup` endpoint** -- FraudCheckIndicator calls `POST /admin/fraud-checker/lookup` but no such route exists. Manual fraud check from order list is completely broken. | `fraud-checker.ts` (missing route), `FraudCheckIndicator.tsx` (line 25) |
| 32 | **URL path mismatch in delete/test** -- Client calls `/admin/settings/fraud-checker/{id}` but routes are at `/admin/fraud-checker/{id}`. Delete and test-connection are broken. | `fraud-checker-actions.ts` (lines 53, 74) |

### High

| # | Issue | Location |
|---|-------|----------|
| 23 | **API key query missing category filter** -- OpenRouter route queries by key only, but key is saved with category `integrations`. Could return wrong value if key exists in another category. | `openrouter.ts` (lines 102, 242) |
| 36 | **Risk calculation mismatch** -- Client uses delivery-rate thresholds; server uses cancel-rate thresholds. They produce different risk assessments for the same data. | `FraudCheckIndicator.tsx` (lines 56-67) vs `provider.ts` (lines 42-52) |
| 10 | **Plaintext API key storage** -- Both OpenRouter and fraud checker keys stored unencrypted, unlike delivery providers which use AES-GCM. | `fraud-checker.service.ts`, `integrations.ts` |

### Medium

| # | Issue | Location |
|---|-------|----------|
| 1/19 | **Duplicated prompt URLs** -- `SYSTEM_PROMPT_URLS` in config and `PROMPT_URLS` in route are identical but independent. | `ai-config.ts` (lines 13-17), `ai-prompts.ts` (lines 8-12) |
| 2 | **Prompt format contradiction** -- Config instructs XML-like tags but fallbacks say "valid JSON". | `ai-config.ts` (lines 20-31 vs 128-144) |
| 3/20 | **Unused fallback prompts** -- `SYSTEM_PROMPT_FALLBACKS` defined but never imported. Route throws on fetch failure. | `ai-config.ts` (lines 19-31), `ai-prompts.ts` (line 59) |
| 6 | **Browser-only API in shared package** -- `new Image()` in `prompt-helper-v2.ts` cannot run server-side. | `prompt-helper-v2.ts` (line 142) |
| 22 | **Unvalidated prompt type** -- `type` query accepts any string, falls back silently. | `ai-prompts.ts` (line 21) |
| 24 | **`z.any()` in generate schema** -- Bypasses input validation for message content and images. | `openrouter.ts` (lines 75, 78) |
| 26 | **Wrong error type for upstream failures** -- All errors thrown as `ValidationError` regardless of cause. | `openrouter.ts` |
| 30 | **Global `window` actions pattern** -- Fragile coupling between component and action script. | `FraudCheckerSettings.tsx` |

### Low

| # | Issue | Location |
|---|-------|----------|
| 7 | **`imageCount` metadata undercounts** -- Reports only selected images, not product/category images. | `prompt-helper-v2.ts` (line 532) |
| 9 | **No system message** -- Everything packed into user message, losing system message semantics. | `prompt-helper-v2.ts` |
| 11 | **No rate limiting on fraud lookups** -- External API calls with no throttle. | `fraud-checker.service.ts` |
| 13 | **Multiple active providers ambiguous** -- First-match selection with no priority. | `fraud-checker.service.ts` (line 228) |
| 14 | **Module-level Map in Workers** -- Provider registry not shared across isolates. | `provider.ts` (line 93) |
| 16 | **No pagination on batch context** -- Unbounded product/category arrays. | `ai-context.ts` |
| 17 | **Empty response schemas** -- No typed response bodies in OpenAPI spec. | All route files |
| 18 | **Duplicated price calculation** -- `calculateFinalPrice` redefined in route file. | `ai-context.ts` (lines 43-58) |
| 25 | **Streaming bypasses envelope** -- SSE responses do not follow `{ success, data }` contract. | `openrouter.ts` (lines 177-184) |
| 27 | **No cost tracking** -- Token usage logged to console only, not persisted. | `openrouter.ts` |
| 29 | **No `providerType` in CRUD schemas** -- Cannot configure non-default fraud provider types via API. | `fraud-checker.ts` |
| 33 | **Loose type definitions** -- Actions file uses `[key: string]: unknown` instead of proper types. | `fraud-checker-actions.ts` (lines 3-6) |
| 35/37 | **`any` types and dead props** -- FraudCheckIndicator uses `any` for fraud data, unused `orderId`. | `FraudCheckIndicator.tsx` |

---

## 10. Recommendations

### Immediate (fix broken functionality)

1. **Add the `/lookup` endpoint** to `apps/api/src/routes/admin/fraud-checker.ts`. It should accept `{ phone: string }`, call `fraudLookupWithActiveProvider(db, phone)`, and return the result including the server-computed `riskLevel`.

2. **Fix URL paths** in `apps/admin/src/lib/client/fraud-checker-actions.ts`. Change:
   - `deleteProvider`: `/api/v1/admin/settings/fraud-checker/${id}` to `/api/v1/admin/fraud-checker/${id}`
   - `testProvider`: `/api/v1/admin/settings/fraud-checker/${id}/test` to `/api/v1/admin/fraud-checker/${id}/test`

3. **Add category filter** to OpenRouter API key query. Change `eq(settings.key, "openrouter_api_key")` to `and(eq(settings.key, "openrouter_api_key"), eq(settings.category, "integrations"))` in both generate and generate-staged handlers.

### Short-term

4. **Use server `riskLevel`** in FraudCheckIndicator instead of recomputing locally. Display the server's assessment and remove the client-side delivery rate calculation, or align thresholds if local computation is intentional.

5. **Import `SYSTEM_PROMPT_URLS` from `ai-config.ts`** in the prompts route and delete the duplicated `PROMPT_URLS` constant. Also wire up `SYSTEM_PROMPT_FALLBACKS` as the catch block response instead of throwing.

6. **Fix prompt format contradiction** -- Either update fallbacks to describe the `<htmljs>/<css>` tag format, or rename `PROMPT_INSTRUCTIONS.json` to something more accurate like `PROMPT_INSTRUCTIONS.output`.

7. **Validate inputs more strictly** -- Use `z.enum()` for prompt type, define proper schemas for message content instead of `z.any()`, add max-length constraints on batch arrays.

### Medium-term

8. **Encrypt API keys** for OpenRouter and fraud checker providers using the same AES-GCM pattern as delivery providers.

9. **Add rate limiting** for OpenRouter generation and fraud checker lookups. At minimum, per-user throttle on generate endpoints.

10. **Add cost/usage tracking** -- Persist token usage from OpenRouter responses to a table or KV for spend auditing.

11. **Move `getImageDimensions`** out of the shared core package into the admin frontend where it actually runs (browser context). Or provide a server-side fallback that returns `{ width: 0, height: 0 }`.

12. **Replace `window.fraudCheckerActions`** pattern with React props/context injection for the FraudCheckerSettings component.
