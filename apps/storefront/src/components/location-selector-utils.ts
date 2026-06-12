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
    .filter(Boolean);

  return locations.find((location) =>
    candidates.some(
      (candidate) => location.id === candidate || location.name === candidate,
    ),
  );
}
