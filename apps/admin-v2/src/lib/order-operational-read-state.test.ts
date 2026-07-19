import { describe, expect, it } from "vitest";
import { resolveOrderOperationalReadState } from "./order-operational-read-state";

describe("order operational read state", () => {
  it("keeps optional reads loading until hydration and their first result", () => {
    expect(resolveOrderOperationalReadState({
      hydrated: false,
      loading: false,
      error: false,
      fetching: false,
      hasData: true,
    })).toEqual({ status: "loading", refreshing: false });

    expect(resolveOrderOperationalReadState({
      hydrated: true,
      loading: true,
      error: false,
      fetching: true,
      hasData: false,
    })).toEqual({ status: "loading", refreshing: false });
  });

  it("distinguishes an unavailable read from a truthful empty result", () => {
    expect(resolveOrderOperationalReadState({
      hydrated: true,
      loading: false,
      error: true,
      fetching: false,
      hasData: false,
    })).toEqual({ status: "unavailable", refreshing: false });

    expect(resolveOrderOperationalReadState({
      hydrated: true,
      loading: false,
      error: false,
      fetching: false,
      hasData: true,
    })).toEqual({ status: "ready", refreshing: false });
  });

  it("keeps prior data visible while reporting a failed refresh", () => {
    expect(resolveOrderOperationalReadState({
      hydrated: true,
      loading: false,
      error: true,
      fetching: true,
      hasData: true,
    })).toEqual({ status: "stale", refreshing: true });
  });
});
