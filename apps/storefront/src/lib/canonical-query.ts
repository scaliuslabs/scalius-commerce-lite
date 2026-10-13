import {
  isStorefrontTrackingQueryParam,
  normalizeStorefrontCacheQueryValue,
} from "@scalius/shared/storefront-cache-path";

/** Ad-click and campaign parameters: never part of a page's state or canonical. */
export const isStorefrontIgnoredQueryParam = isStorefrontTrackingQueryParam;

type QueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | null
  | undefined;
type QueryDefaults = Record<string, string | number | boolean>;

function appendSortedParams(
  params: URLSearchParams,
  entries: Array<[string, string]>,
): void {
  entries
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .forEach(([key, value]) => params.append(key, value));
}

export function buildCanonicalQueryString(
  values: Record<string, QueryValue>,
  { defaultParams = {} }: { defaultParams?: QueryDefaults } = {},
): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const normalized = normalizeStorefrontCacheQueryValue(key, String(item));
      if (
        normalized !== "" &&
        (!Object.hasOwn(defaultParams, key) ||
          normalized !== String(defaultParams[key]))
      ) {
        entries.push([key, normalized]);
      }
    }
  }

  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  return params.toString();
}
