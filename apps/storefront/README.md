<p align="center">
  <a href="https://scalius.com">
    <img alt="Scalius Commerce Storefront" src="https://raw.githubusercontent.com/scaliuslabs/scalius-commerce-lite/refs/heads/master/src/assets/logo-dark.png" width="200" />
  </a>
</p>

<h1 align="center">Scalius Commerce Storefront</h1>

<h4 align="center">
  <a href="https://docs.scalius.com">Documentation</a> |
  <a href="https://scalius.com">Website</a>
</h4>

<p align="center">
  A high-performance, modern e-commerce storefront template built with <strong>Astro 5</strong>, <strong>React 19</strong>, and <strong>Tailwind CSS 4</strong>. Designed to work seamlessly with the Open Source <strong>Scalius Commerce Lite Backend</strong>, this storefront is optimized for deployment on <strong>Cloudflare Workers</strong> with edge caching and zero cold starts.
</p>

<p align="center">
  <!-- License: MIT -->
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Scalius Commerce Storefront is released under the MIT license." />
  </a>
  <!-- PRs Welcome -->
  <a href="./CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
  <!-- Security Policy -->
  <a href="./SECURITY.md">
    <img src="https://img.shields.io/badge/Security-Policy-red.svg" alt="Security Policy" />
  </a>
</p>

<p align="center">
  <!-- Twitter / X -->
  <a href="https://scalius.com/x">
    <img src="https://img.shields.io/twitter/follow/scaliuslabs.svg?label=Follow%20@scaliuslabs" alt="Follow @scaliuslabs" />
  </a>
  <!-- Discord -->
  <a href="https://scalius.com/discord">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <!-- Facebook -->
  <a href="https://scalius.com/facebook">
    <img src="https://img.shields.io/badge/Facebook-Follow-1877F2?logo=facebook" alt="Follow on Facebook" />
  </a>
</p>

## 🚀 Key Features

- **⚡ Ultra-Fast Performance**: Built on Astro's server-side rendering (SSR) optimized for the Edge.
- **🌍 Cloudflare Workers Adapter**: Deploys natively to Cloudflare's global network with zero cold starts.
- **💾 Smart Edge Caching**: Custom L2 caching strategy using Cloudflare Cache API + KV for instant sub-second page loads.
- **🖼️ Optimized Images**: Real-time image resizing and optimization via Cloudflare Images (production) or Squoosh (local).
- **🛍️ Full Commerce Functionality**:
  - Dynamic Product & Category pages
  - Full Cart & Checkout flow
  - Search with Command Palette (FTS5 full-text search — prefix matching, multi-word queries)
  - Product Variants & Image Zoom
- **🎨 Modern UI/UX**:
  - **Tailwind CSS v4** for styling
  - **Radix UI** for accessible primitives
  - **Lucide React** for beautiful icons
  - **Sonner** for toast notifications
- **🔍 SEO Ready**: Auto-generated sitemaps, semantic HTML, and structured data.

## 🛠 Tech Stack

- **Framework**: [Astro 5](https://astro.build/)
- **UI Library**: [React 19](https://react.dev/)
- **Styling**: [Tailwind CSS 4](https://tailwindcss.com/)
- **State Management**: [Nano Stores](https://github.com/nanostores/nanostores)
- **Deployment**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Package Manager**: pnpm

## 📁 Project Structure

```bash
├── public/              # Static assets
├── scripts/             # Build and deploy scripts
├── src/
│   ├── components/      # UI Components (Header, Footer, Product, etc.)
│   ├── config/          # Build ID and runtime config
│   ├── layouts/         # Page layouts (Layout.astro)
│   ├── lib/             # Utilities, API client, middleware helpers
│   │   ├── api/         # Backend API client (direct fetch via createApiUrl)
│   │   ├── edge-cache.ts # L2 edge caching (Cache API + KV versioning)
│   │   ├── smart-cache.ts # In-memory cache + request deduplication
│   │   └── middleware-helper/ # CSP, cache context
│   ├── pages/           # File-based routing
│   │   ├── api/         # Proxy routes (checkout, purge-cache, auth/logout)
│   │   ├── products/    # Product details pages
│   │   ├── categories/  # Category listing pages
│   │   ├── buy/         # Buy/redirect pages
│   │   ├── cart.astro   # Cart page
│   │   ├── checkout.astro
│   │   ├── order-success.astro
│   │   ├── account.astro
│   │   └── search/      # Search with filters
│   ├── store/           # Global state (Cart, Toast, etc.)
│   └── middleware.ts    # Edge caching, CSP, BACKEND_API context
├── astro.config.mjs     # Astro configuration
├── tailwind.config.mjs  # Tailwind configuration
└── wrangler.jsonc       # Cloudflare Workers configuration
```

## 🏁 Getting Started

### Prerequisites

- **Node.js**: v18.17.1 or higher (v20+ recommended)
- **pnpm**: v9+ (Recommended package manager)

### Installation

1.  Clone the repository:

    ```bash
    git clone https://github.com/scaliuslabs/scalius-commerce-storefront.git
    cd scalius-commerce-storefront
    ```

2.  Install dependencies:
    ```bash
    pnpm install
    ```

### Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

For local development, update `.env` with your backend details. In production, many variables can be set in `wrangler.jsonc` under `vars`; secrets should use `wrangler secret put`.

| Variable              | Description                                                                 | Required |
| :-------------------- | :-------------------------------------------------------------------------- | :------- |
| `PUBLIC_API_URL`      | Full URL of your Scalius Backend API (e.g. `http://localhost:4321/api/v1`)  | Yes      |
| `PUBLIC_API_BASE_URL` | Base URL for image optimization and auth redirects (e.g. `http://localhost:4321`) | Yes  |
| `API_TOKEN`           | Backend API token for server-side proxy routes (create-order, payment intents). Must match backend. | Yes |
| `PURGE_TOKEN`         | Token for cache purge requests. Must match backend's `PURGE_TOKEN`.         | Yes      |
| `STOREFRONT_URL`      | URL where this storefront is deployed (sitemaps, Facebook feed)             | Optional |
| `CDN_DOMAIN_URL`      | CDN domain for image optimization (R2 custom domain)                         | Optional |
| `JWT_SECRET`          | Backend JWT signing secret (for compatibility; storefront does not verify)  | Optional |

### Development

Start the local development server:

```bash
pnpm dev
```

The site will be available at `http://localhost:4321` (or `http://localhost:4322` if the backend is already using 4321).

### Build & Preview

From `package.json`:

```bash
pnpm dev      # astro dev --host
pnpm build    # generate-build-id + astro check + astro build
pnpm preview  # astro preview
pnpm deploy   # full pipeline: build ID, type check, build, wrangler deploy
pnpm start    # node ./dist/server/entry.mjs (Node.js preview)
```

## ☁️ Deployment

This project is configured for **Cloudflare Workers**.

1.  **Login to Cloudflare**:

    ```bash
    npx wrangler login
    ```

2.  **Deploy** (recommended — runs full pipeline: build ID, type check, build, deploy):

    ```bash
    pnpm deploy
    ```

    Or deploy manually:

    ```bash
    pnpm build
    npx wrangler deploy
    ```

3.  **Configure secrets** in Cloudflare (required for production):

    ```bash
    npx wrangler secret put API_TOKEN
    npx wrangler secret put PURGE_TOKEN
    ```

    Non-secret variables (`PUBLIC_API_URL`, `PUBLIC_API_BASE_URL`, `STOREFRONT_URL`, `CDN_DOMAIN_URL`) can be set in `wrangler.jsonc` under `vars`.

### Cloudflare bindings

`wrangler.jsonc` declares:

| Binding         | Type     | Purpose                                                                 |
| :-------------- | :------- | :---------------------------------------------------------------------- |
| `CACHE_CONTROL` | KV       | Cache version for L2 invalidation (purge-cache bumps version)           |
| `BACKEND_API`   | Service  | Service binding to the Scalius backend for 0ms latency internal calls  |
| `ASSETS`        | Fetcher  | Static asset serving                                                    |

The `BACKEND_API` service binding allows SSR requests to call the backend without a network hop when both are deployed on Cloudflare. Configure the `service` name in `wrangler.jsonc` to match your backend Worker name.

## 🧩 Backend Integration

This storefront requires a running instance of the **Scalius Commerce Lite Backend**. Ensure your `PUBLIC_API_URL` points to the correct backend endpoint (e.g. `https://your-backend.com/api/v1`).

The API client in `src/lib/api/` uses direct `fetch` calls via `createApiUrl` — it does **not** use the backend's generated SDK. It handles:

- Fetching products, categories, collections, pages, layout data, and widgets
- Customer auth (OTP-based), cart, checkout, and **asynchronous queue-based order creation (polling)**
- Payment intents (Stripe, SSLCommerz) via server-side proxy routes
- Discount validation, shipping locations, and analytics config

**Server-side proxy routes** (`src/pages/api/checkout/*`, `create-order`, `stripe-intent`, `sslcommerz-session`) require `API_TOKEN` to obtain a JWT from the backend for protected operations.

## ⚡ Performance Optimization

### Edge Caching

The project uses `middleware.ts` for **L2 Caching** at the edge:

- **L1**: In-memory `smartCache` for API responses (layout, homepage, widgets)
- **L2**: Cloudflare Cache API for HTML, with KV (`CACHE_CONTROL`) for versioning (`v_hostname`)

When the backend triggers `/api/purge-cache?token=PURGE_TOKEN`, the storefront bumps the KV version, invalidating all cached HTML and clearing the in-memory API cache. Critical paths are then warmed in the background.

- **Cacheable paths**: Homepage, products, categories, search, sitemaps
- **Non-cacheable**: Cart, checkout, account, order-success

### Image Optimization

- **Development**: Uses `squoosh` service.
- **Production**: Uses Cloudflare Images service via `@astrojs/cloudflare` adapter for on-the-fly resizing and format conversion (WebP/AVIF).

## 📄 License

[MIT](LICENSE) © Scalius
