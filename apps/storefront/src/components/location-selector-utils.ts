export interface LocationOptionLike {
  id: string;
  name: string;
}

export interface LocationPrefillDetail {
  city?: string | null;
  cityName?: string | null;
  zone?: string | null;
  zoneName?: string | null;
  area?: string | null;
  areaName?: string | null;
}

export function resolveLocationOption<T extends LocationOptionLike>(
  locations: T[],
  idOrName?: string | null,
  displayName?: string | null,
): T | undefined {
  const candidates = [idOrName, displayName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const exactId = locations.find((location) => location.id === candidate);
    if (exactId) return exactId;
  }

  const normalizedNames = new Set(
    candidates.map((candidate) =>
      candidate.replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
    ),
  );

  return locations.find((location) =>
    normalizedNames.has(
      location.name.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
    ),
  );
}
