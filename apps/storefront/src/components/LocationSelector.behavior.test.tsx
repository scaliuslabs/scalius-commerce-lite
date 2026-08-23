// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocationData } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  getZones: vi.fn(),
  getAreas: vi.fn(),
  readCheckoutFormDraft: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getZones: mocks.getZones,
  getAreas: mocks.getAreas,
}));

vi.mock("@/lib/checkout/session-state", () => ({
  readCheckoutFormDraft: mocks.readCheckoutFormDraft,
}));

import LocationSelector, { type LocationSelection } from "./LocationSelector";

const cities: LocationData[] = [{
  id: "city_dhaka",
  name: "Dhaka",
  type: "city",
  parentId: null,
  isActive: true,
  sortOrder: 0,
}];
const zones: LocationData[] = [{
  id: "zone_mirpur",
  name: "Mirpur",
  type: "zone",
  parentId: "city_dhaka",
  isActive: true,
  sortOrder: 0,
}];
const areas: LocationData[] = [{
  id: "area_10",
  name: "Mirpur 10",
  type: "area",
  parentId: "zone_mirpur",
  isActive: true,
  sortOrder: 0,
}];

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function Parent({ showAreaField }: { showAreaField: boolean }) {
  const [, setSelection] = useState<LocationSelection | null>(null);
  return (
    <LocationSelector
      cities={cities}
      showAreaField={showAreaField}
      onSelectionChange={(next) => setSelection(next)}
    />
  );
}

describe("LocationSelector loading", () => {
  it("restores city, zone, and area once without restarting requests on rerender", async () => {
    mocks.readCheckoutFormDraft.mockReturnValue({
      city: "city_dhaka",
      cityName: "Dhaka",
      zone: "zone_mirpur",
      zoneName: "Mirpur",
      area: "area_10",
      areaName: "Mirpur 10",
    });
    mocks.getZones.mockResolvedValue(zones);
    mocks.getAreas.mockResolvedValue(areas);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Parent showAreaField />);
    });

    await vi.waitFor(() => {
      expect(mocks.getZones).toHaveBeenCalledTimes(1);
      expect(mocks.getAreas).toHaveBeenCalledTimes(1);
      expect(container.querySelector<HTMLInputElement>('input[name="city"]')?.value)
        .toBe("city_dhaka");
      expect(container.querySelector<HTMLInputElement>('input[name="zone"]')?.value)
        .toBe("zone_mirpur");
      expect(container.querySelector<HTMLInputElement>('input[name="area"]')?.value)
        .toBe("area_10");
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.getZones).toHaveBeenCalledTimes(1);
    expect(mocks.getAreas).toHaveBeenCalledTimes(1);
  });

  it("does not request or render areas when the merchant hides that field", async () => {
    mocks.readCheckoutFormDraft.mockReturnValue({
      city: "city_dhaka",
      cityName: "Dhaka",
      zone: "zone_mirpur",
      zoneName: "Mirpur",
    });
    mocks.getZones.mockResolvedValue(zones);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Parent showAreaField={false} />);
    });

    await vi.waitFor(() => {
      expect(mocks.getZones).toHaveBeenCalledTimes(1);
      expect(container.querySelector<HTMLInputElement>('input[name="zone"]')?.value)
        .toBe("zone_mirpur");
    });
    expect(mocks.getAreas).not.toHaveBeenCalled();
    expect(container.querySelector('input[name="area"]')).toBeNull();
  });
});
