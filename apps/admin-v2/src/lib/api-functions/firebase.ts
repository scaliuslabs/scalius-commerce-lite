import { createServerFn } from "@tanstack/react-start";
import { apiBaseGet } from "../api.server";

export type FirebasePublicConfig = Record<string, string>;

function toFirebasePublicConfig(config: Record<string, unknown>): FirebasePublicConfig {
  const normalized: FirebasePublicConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
}

export const getFirebaseConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const config = await apiBaseGet<Record<string, unknown>>(
      "/auth/firebase-config",
    );
    return toFirebasePublicConfig(config);
  },
);
