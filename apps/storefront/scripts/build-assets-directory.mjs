import { readFileSync } from "node:fs";

const SAFE_BUILD_ID = /^[a-zA-Z0-9._-]+$/;

export function parseGeneratedBuildId(source) {
  const match = source.match(/export const BUILD_ID = ["']([^"']+)["'];/);
  const buildId = match?.[1]?.trim() ?? "";

  if (!buildId || !SAFE_BUILD_ID.test(buildId)) {
    throw new Error("Generated Storefront BUILD_ID is missing or unsafe.");
  }

  return buildId;
}

export function buildAssetsDirectory(buildId) {
  if (!SAFE_BUILD_ID.test(buildId)) {
    throw new Error("Storefront asset build ID is unsafe.");
  }

  return `_astro/${buildId}`;
}

export function readBuildAssetsDirectory(buildIdUrl) {
  return buildAssetsDirectory(
    parseGeneratedBuildId(readFileSync(buildIdUrl, "utf8")),
  );
}
