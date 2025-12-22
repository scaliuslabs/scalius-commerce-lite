// src/env.d.ts

/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly DATABASE_URL: string;
  readonly DATABASE_AUTH_TOKEN: string;
  readonly PUBLIC_CLERK_PUBLISHABLE_KEY: string;
  readonly CLERK_SECRET_KEY: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET_NAME: string;
  readonly R2_PUBLIC_URL: string;
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
  readonly PUBLIC_FIREBASE_MEASUREMENT_ID: string;
  readonly PUBLIC_VAPID_FIREBASE: string;
  readonly FIREBASE_SERVICE_ACCOUNT_CRED_JSON: string;
  readonly SECRET_VAPID_FIREBASE: string;
  readonly PUBLIC_VAPID_FIREBASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Add JSX type support for Astro components
declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

// This correctly types `context.locals` for your entire application
declare namespace App {
  interface Locals {
    auth: () => import("@clerk/astro/server").AuthObject;
    currentUser: () => Promise<import("@clerk/backend").User | null>;
  }
}