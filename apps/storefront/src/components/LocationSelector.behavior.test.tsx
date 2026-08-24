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

const cities: LocationData[] = [
  {
    id: "city_dhaka",
    name: "Dhaka",
    type: "city",
    parentId: null,
    isActive: true,
    sortOrder: 0,
  },
];
const zones: LocationData[] = [
  {
    id: "zone_mirpur",
    name: "Mirpur",
    type: "zone",
    parentId: "city_dhaka",
    isActive: true,
    sortOrder: 0,
  },
];
const areas: LocationData[] = [
  {
    id: "area_10",
    name: "Mirpur 10",
    type: "area",
    parentId: "zone_mirpur",
    isActive: true,
    sortOrder: 0,
  },
];
const secondCity: LocationData = {
  id: "city_bagerhat",
  name: "Bagerhat",
  type: "city",
  parentId: null,
  isActive: true,
  sortOrder: 1,
};
const secondZone: LocationData = {
  id: "zone_bajua",
  name: "Bajua",
  type: "zone",
  parentId: secondCity.id,
  isActive: true,
  sortOrder: 0,
};
const secondArea: LocationData = {
  id: "area_bajua_bazar",
  name: "Bajua Bazar",
  type: "area",
  parentId: secondZone.id,
  isActive: true,
  sortOrder: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
      expect(
        container.querySelector<HTMLInputElement>('input[name="city"]')?.value,
      ).toBe("city_dhaka");
      expect(
        container.querySelector<HTMLInputElement>('input[name="zone"]')?.value,
      ).toBe("zone_mirpur");
      expect(
        container.querySelector<HTMLInputElement>('input[name="area"]')?.value,
      ).toBe("area_10");
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
      expect(
        container.querySelector<HTMLInputElement>('input[name="zone"]')?.value,
      ).toBe("zone_mirpur");
    });
    expect(mocks.getAreas).not.toHaveBeenCalled();
    expect(container.querySelector('input[name="area"]')).toBeNull();
  });

  it("publishes a restored city and zone before an optional area request settles", async () => {
    const pendingAreas = deferred<LocationData[]>();
    const onSelectionChange = vi.fn();
    mocks.readCheckoutFormDraft.mockReturnValue({
      city: "city_dhaka",
      cityName: "Dhaka",
      zone: "zone_mirpur",
      zoneName: "Mirpur",
      area: "area_10",
      areaName: "Mirpur 10",
    });
    mocks.getZones.mockResolvedValue(zones);
    mocks.getAreas.mockReturnValue(pendingAreas.promise);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LocationSelector
          cities={cities}
          onSelectionChange={onSelectionChange}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(mocks.getAreas).toHaveBeenCalledWith("zone_mirpur");
      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          cityId: "city_dhaka",
          zoneId: "zone_mirpur",
          areaId: "",
        }),
      );
    });

    await act(async () => pendingAreas.resolve(areas));
    await vi.waitFor(() => {
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cityId: "city_dhaka",
          zoneId: "zone_mirpur",
          areaId: "area_10",
        }),
      );
    });
  });

  it("ignores an older area response after a newer location restore starts", async () => {
    const firstAreas = deferred<LocationData[]>();
    const secondAreas = deferred<LocationData[]>();
    const onSelectionChange = vi.fn();
    mocks.readCheckoutFormDraft.mockReturnValue(null);
    mocks.getZones.mockImplementation(async (cityId: string) =>
      cityId === "city_dhaka" ? zones : [secondZone],
    );
    mocks.getAreas.mockImplementation((zoneId: string) =>
      zoneId === "zone_mirpur" ? firstAreas.promise : secondAreas.promise,
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocationSelector
          cities={[...cities, secondCity]}
          onSelectionChange={onSelectionChange}
        />,
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("location-prefill", {
          detail: {
            city: "city_dhaka",
            zone: "zone_mirpur",
            area: "area_10",
          },
        }),
      );
    });
    await vi.waitFor(() =>
      expect(mocks.getAreas).toHaveBeenCalledWith("zone_mirpur"),
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("location-prefill", {
          detail: {
            city: secondCity.id,
            zone: secondZone.id,
            area: secondArea.id,
          },
        }),
      );
    });
    await vi.waitFor(() =>
      expect(mocks.getAreas).toHaveBeenCalledWith(secondZone.id),
    );

    await act(async () => firstAreas.resolve(areas));
    expect(onSelectionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        areaId: "area_10",
      }),
    );

    await act(async () => secondAreas.resolve([secondArea]));
    await vi.waitFor(() => {
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cityId: secondCity.id,
          zoneId: secondZone.id,
          areaId: secondArea.id,
        }),
      );
      expect(
        container.querySelector<HTMLInputElement>('input[name="city"]')?.value,
      ).toBe(secondCity.id);
      expect(
        container.querySelector<HTMLInputElement>('input[name="zone"]')?.value,
      ).toBe(secondZone.id);
      expect(
        container.querySelector<HTMLInputElement>('input[name="area"]')?.value,
      ).toBe(secondArea.id);
    });
  });
});
