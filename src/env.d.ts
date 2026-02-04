// src/env.d.ts

/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  // Database
  readonly TURSO_DATABASE_URL: string;
  readonly TURSO_AUTH_TOKEN: string;

  // Better Auth
  readonly BETTER_AUTH_SECRET: string;
  readonly BETTER_AUTH_URL: string;
  readonly PUBLIC_API_BASE_URL: string;

  // R2 Storage
  readonly R2_ACCOUNT_ID: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET_NAME: string;
  readonly R2_PUBLIC_URL: string;

  // Firebase (optional)
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
  readonly PUBLIC_FIREBASE_MEASUREMENT_ID: string;
  readonly PUBLIC_VAPID_FIREBASE: string;
  readonly FIREBASE_SERVICE_ACCOUNT_CRED_JSON: string;

  // Redis (optional)
  readonly UPSTASH_REDIS_REST_URL: string;
  readonly UPSTASH_REDIS_REST_TOKEN: string;

  // Hono API auth
  readonly API_TOKEN: string;
  readonly JWT_SECRET: string;

  // Email
  readonly EMAIL_SENDER: string;
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

// Better Auth user type
interface BetterAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
  twoFactorEnabled?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

// Better Auth session type
interface BetterAuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  impersonatedBy?: string | null;
  twoFactorVerified?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// This correctly types `context.locals` for your entire application
declare namespace App {
  interface Locals {
    user: BetterAuthUser | null;
    session: BetterAuthSession | null;
    runtime?: {
      env: Env;
    };
  }
}

// Cloudflare Email Workers send binding type
interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}

// EmailMessage class for Cloudflare Email Workers
declare class EmailMessage {
  constructor(from: string, to: string, raw: string | ReadableStream);
  readonly from: string;
  readonly to: string;
}

// Cloudflare Workers environment bindings
interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_PUBLIC_URL?: string;
  API_TOKEN?: string;
  JWT_SECRET?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  PROJECT_CACHE_PREFIX?: string;
  SHARED_AUTH_CACHE?: KVNamespace;
  EMAIL?: SendEmail;
  EMAIL_SENDER?: string;
  [key: string]: unknown;
}
