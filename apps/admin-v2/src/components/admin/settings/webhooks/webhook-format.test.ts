import { describe, expect, it } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { actionErrorText } from "../../online-store/action-error";
import { deliveryErrorText } from "./webhook-format";

describe("a webhook delivery's error", () => {
  it("says what failed in plain words, and keeps the recorded reason as a detail", () => {
    const network = "network_error: internal error; reference = 0f3a9c2e5b7d";
    expect(deliveryErrorText(network)).toEqual({
      text: "Couldn't connect to the webhook's address. Check that the URL is right and the server is online.",
      detail: network,
    });
    expect(deliveryErrorText("timeout: no response within 10 s").text).toBe("The webhook's server didn't answer in time.");
    expect(deliveryErrorText("http_502").text).toBe("The webhook's server had an error (HTTP 502). Check the server, then send a test again.");
    expect(deliveryErrorText("http_404")).toEqual({ text: "The webhook's server refused the request (HTTP 404).", detail: null });
    expect(deliveryErrorText("redirect_not_followed: answer with a 2xx status at the subscribed URL").text).toContain("Webhooks don't follow redirects");
    expect(deliveryErrorText("url_refused: private address").detail).toBe("url_refused: private address");
    // A reason this dashboard doesn't know yet shows as sent.
    expect(deliveryErrorText("Receiver answered 500")).toEqual({ text: "Receiver answered 500", detail: null });
  });
});

describe("a lost dashboard session", () => {
  it("is said plainly, never with the API's cookie wording", () => {
    const expired = new AdminApiResponseError("Admin access requires a valid dashboard session cookie.", 401, "unauthorized");
    const plain = "You're signed out. Your changes are kept on this page: sign in again in a new tab, then save.";
    expect(getServerFnError(expired)).toBe(plain);
    expect(actionErrorText(expired)).toBe(plain);
  });
});
