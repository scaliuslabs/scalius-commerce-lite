# Scalius Commerce Lite SDK

This directory contains the auto-generated TypeScript SDK for the Scalius Commerce Lite API. It uses `@hey-api/openapi-ts` to provide a fully typed, lightweight, and performant Fetch client.

## 📦 What's Included

- **Fully Typed Client**: TypeScript interfaces for all API requests, responses, and data models (Products, Orders, Collections, etc.).
- **Zero-Dependency (Runtime)**: Uses the native `fetch` API.
- **OpenAPI v3.1 Support**: Generated directly from the Hono API definition.

## 🚀 Getting Started

### 1. Installation

If you are working within the Scalius monorepo, you can import the client directly:

```typescript
import { client, getProducts, postOrders } from "@/lib/sdk/client";
```

If you are moving this SDK to a separate storefront project (e.g., Next.js, Astro, Remix), simply copy the `src/lib/sdk/client` folder to your project's source tree (e.g., `src/lib/scalius-sdk`).

### 2. Environment Variables

Your storefront project requires the following environment variables to connect to the backend.

| Variable              | Description                                                                  | Required? | Location        |
| --------------------- | ---------------------------------------------------------------------------- | --------- | --------------- |
| `PUBLIC_API_BASE_URL` | The full URL of your backend API (e.g., `https://api.yourdomain.com/api/v1`) | **Yes**   | Client & Server |
| `API_TOKEN`           | Secret system token for "machine-to-machine" auth (creating orders, etc.)    | **Yes**   | **Server Only** |

> **⚠️ Security Warning:** Never expose `API_TOKEN` to the browser client. Actions requiring this token (like creating orders) should be proxied through your frontend's server (SSR, API Routes, or Server Actions).

### 3. Initialization

In your application's entry point (e.g., `app.tsx`, `layout.tsx`, or a dedicated `api.ts` file), configure the base URL.

```typescript
import { client } from "@/lib/sdk/client";

// Set the base URL from your environment variables
client.setConfig({
  baseUrl: process.env.PUBLIC_API_BASE_URL || "http://localhost:4321/api/v1",
});
```

---

## 💻 Usage Examples

### Fetching Public Data (Client-Side)

Fetching products, collections, or categories does not require authentication.

```typescript
import { getProducts } from "@/lib/sdk/client";

async function loadShop() {
  const { data, error } = await getProducts({
    query: {
      limit: 20,
      sort: "newest",
      // freeDelivery: 'true' // Optional filters
    },
  });

  if (error) {
    console.error("Failed to load products:", error);
    return;
  }

  console.log("Products:", data.products);
}
```

### Creating an Order (Server-Side / Protected)

The `/orders` endpoint is protected. To place an order from a public storefront, you must perform the action server-side using the `API_TOKEN`.

**Example: Next.js Server Action**

```typescript
"use server";

import { client, postOrders } from "@/lib/sdk/client";
import { getAuthToken } from "@/lib/sdk/client";

// 1. Configure client for server-side use
client.setConfig({
  baseUrl: process.env.PUBLIC_API_BASE_URL,
});

export async function placeOrder(orderData: any) {
  // 2. Obtain a JWT using your secret API_TOKEN
  const { data: authData } = await getAuthToken({
    headers: {
      "X-API-Token": process.env.API_TOKEN!,
    },
  });

  if (!authData?.data?.token) {
    throw new Error("Failed to authenticate with backend");
  }

  // 3. Use the JWT to create the order
  const { data: order, error } = await postOrders({
    body: orderData,
    headers: {
      Authorization: `Bearer ${authData.data.token}`,
    },
  });

  if (error) {
    throw new Error(error.message || "Order creation failed");
  }

  return order;
}
```

### Using with React Query (TanStack Query)

This SDK pairs perfectly with React Query for state management, caching, and loading states.

```typescript
import { useQuery } from "@tanstack/react-query";
import { getProducts } from "@/lib/sdk/client";

export function ShopGrid() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["products", "newest"],
    queryFn: async () => {
      const { data, error } = await getProducts({
        query: { sort: "newest", limit: 12 }
      });
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error loading products</div>;

  return (
    <div className="grid grid-cols-4 gap-4">
      {data?.products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
```

---

## 🛠️ Development Workflow

When you update the backend API (Hono):

1.  **Modify the API**: Add routes or change schemas in `src/server`.
2.  **Regenerate SDK**: Run the following command in the root of the `scalius-commerce-lite` project:

    ```bash
    pnpm generate:sdk
    ```

    This command will:
    1.  Extract the latest OpenAPI JSON spec from your running code.
    2.  Update the TypeScript interfaces and client code in `src/lib/sdk/client`.

---

## 🔒 Best Practices

1.  **Type Safety**: Always rely on the inferred types from the SDK. Avoid `any`.

    ```typescript
    import type { Product } from "@/lib/sdk/client";

    function ProductCard({ product }: { product: Product }) { ... }
    ```

2.  **Error Handling**: The SDK returns a discriminated union of `{ data, error, response }`. Always check for `error` before using `data`.
3.  **Security**: Keep `API_TOKEN` strictly on the server. Do not commit it to Git or bundle it in client-side code.
