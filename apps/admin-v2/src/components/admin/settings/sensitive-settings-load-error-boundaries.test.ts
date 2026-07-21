import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK_SOURCE = fileURLToPath(
  new URL("../../../hooks/use-settings-form.ts", import.meta.url),
);
const EMAIL_SOURCE = fileURLToPath(
  new URL("./EmailSettingsForm.tsx", import.meta.url),
);
const FIREBASE_SOURCE = fileURLToPath(
  new URL("./FirebaseSettingsForm.tsx", import.meta.url),
);
const AUTH_SOURCE = fileURLToPath(
  new URL("./AuthSettingsBuilder.tsx", import.meta.url),
);
const PAYMENT_SOURCE = fileURLToPath(
  new URL("./PaymentGatewaysManager.tsx", import.meta.url),
);
const NOTIFICATION_SOURCE = fileURLToPath(
  new URL("./NotificationChannelsBuilder.tsx", import.meta.url),
);

describe("sensitive settings load-error boundaries", () => {
  it("keeps the shared settings hook from saving before a successful load", () => {
    const source = readFileSync(HOOK_SOURCE, "utf8");

    expect(source).toContain("const hasLoaded = data !== undefined && !isError");
    expect(source).toContain("if (!hasLoaded)");
    expect(source).toContain('toast.error("Reload settings before saving.")');
    expect(source).toContain("isLoaded: hasLoaded");
    expect(source).toContain("getSettingsLoadErrorMessage");
  });

  it("renders retry-only load-error states for hook-based sensitive tabs", () => {
    const cases = [
      {
        source: readFileSync(EMAIL_SOURCE, "utf8"),
        title: "Email settings unavailable",
        saveLabel: "Save changes",
      },
      {
        source: readFileSync(FIREBASE_SOURCE, "utf8"),
        title: "Firebase settings unavailable",
        saveLabel: "Save All Settings",
      },
      {
        source: readFileSync(AUTH_SOURCE, "utf8"),
        title: "Auth settings unavailable",
        saveLabel: "Save Auth Settings",
      },
    ];

    for (const item of cases) {
      expect(item.source).toContain("isLoadError");
      expect(item.source).toContain("loadError");
      expect(item.source).toContain("getSettingsLoadErrorMessage");
      expect(item.source).toContain(item.title);
      expect(item.source).toContain("Retry");
      expect(item.source.indexOf("if (isLoadError)")).toBeLessThan(
        item.source.indexOf(item.saveLabel),
      );
    }
  });

  it("locks payment gateway credential saves behind each lazy credential load", () => {
    const source = readFileSync(PAYMENT_SOURCE, "utf8");

    expect(source).toContain("gatewayLoadErrors");
    expect(source).toContain("Gateway settings unavailable");
    expect(source).toContain("Existing credentials were not changed.");
    expect(source).toContain("Load ${META[gw].label} settings before saving.");
    expect(source).toContain("onClick={() => void loadCreds(method, true)}");
    expect(source).toContain("!gatewayLoaded");
    expect(source.indexOf("gatewayLoadError ?")).toBeLessThan(
      source.indexOf("<StripeForm"),
    );
    expect(source.indexOf("!gatewayLoaded")).toBeLessThan(
      source.indexOf("<StripeForm"),
    );
  });

  it("locks notification channel saves behind customer and admin reads", () => {
    const source = readFileSync(NOTIFICATION_SOURCE, "utf8");

    expect(source).not.toContain("Use defaults on error");
    expect(source).toContain("customerLoadError");
    expect(source).toContain("adminLoadError");
    expect(source).toContain("Notification channels unavailable");
    expect(source).toContain("Admin notification channels unavailable");
    expect(source).toContain(
      "Reload customer notification channels before saving.",
    );
    expect(source).toContain(
      "Reload admin notification channels before saving.",
    );
    expect(source).toContain("onClick={() => void loadCustomerChannels()}");
    expect(source).toContain("onClick={() => void loadAdminChannels()}");
    expect(source).toContain("Boolean(customerLoadError)");
    expect(source).toContain("Boolean(adminLoadError)");
  });

  it("blocks SMS OTP when auth settings cannot read SMS readiness", () => {
    const source = readFileSync(AUTH_SOURCE, "utf8");

    expect(source).toContain("smsReadinessError");
    expect(source).toContain(
      "SMS readiness could not be checked. Retry or review the SMS provider settings before enabling SMS OTP.",
    );
    expect(source).toContain("result.smsReadinessError = SMS_READINESS_LOAD_ERROR");
    expect(source).toContain("const smsReadinessIssue = getSmsReadinessIssue(v)");
    expect(source).toContain("if (smsReadinessIssue) throw new Error(smsReadinessIssue)");
    expect(source).toContain(
      "emailProviderIssue ?? smsReadinessIssue ?? smsProviderIssue ?? smsProviderServerIssue ?? whatsAppProviderIssue",
    );
    expect(source).toContain(
      "if (channel === \"sms\") return smsReadinessIssue ?? smsProviderIssue ?? smsProviderServerIssue",
    );
    expect(source).toContain(
      "formatProviderReadinessIssue(smsReadinessIssue ?? smsProviderIssue ?? smsProviderServerIssue)",
    );
    expect(source.indexOf("const smsReadinessIssue = getSmsReadinessIssue(v)")).toBeLessThan(
      source.indexOf("const smsIssue = getSmsProviderIssue(v)"),
    );
  });
});
