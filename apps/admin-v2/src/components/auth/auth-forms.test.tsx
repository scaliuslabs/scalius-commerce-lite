// @vitest-environment happy-dom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn(async (_options: unknown) => undefined);
const authClient = {
  signIn: { email: vi.fn() },
  signOut: vi.fn(async () => ({ data: null, error: null })),
  twoFactor: {
    sendOtp: vi.fn(async () => ({ data: { status: true }, error: null })),
    verifyOtp: vi.fn(),
    verifyTotp: vi.fn(),
    verifyBackupCode: vi.fn(),
    enable: vi.fn(),
  },
};
const sdk = {
  postApiV1Setup: vi.fn(async (_options: unknown) => ({ userId: "u1" })),
  getApiV1AdminAuth2FaInfo: vi.fn(async () => ({ method: "email", email: "owner@example.com" })),
  postApiV1AdminAuth2FaMethod: vi.fn(async (_options: unknown) => ({ ok: true })),
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
vi.mock("@/lib/auth-client", () => ({ authClient }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("@/lib/api", () => ({ apiData: <T,>(promise: Promise<T>) => promise }));

const { LoginForm } = await import("./LoginForm");
const { ForgotPasswordForm } = await import("./ForgotPasswordForm");
const { ResetPasswordForm } = await import("./ResetPasswordForm");
const { SetupForm } = await import("./SetupForm");
const { TwoFactorForm } = await import("./TwoFactorForm");
const { TwoFactorSetup } = await import("./TwoFactorSetup");
const { CodeInput } = await import("./auth-ui");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "Sentinel-Secret-9876";
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/auth/login");
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function render(element: ReactElement) {
  act(() => root.render(element));
  await flush();
}

function type(input: Element | null, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error("no input");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submits like a browser would and reports whether the native (URL-building) submit was cancelled. */
async function submit(form = container.querySelector("form")!) {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  act(() => {
    form.dispatchEvent(event);
  });
  await flush();
  await flush();
  return event.defaultPrevented;
}

function alertText() {
  return container.querySelector("[role=alert]")?.textContent ?? "";
}

/** Nothing the merchant typed can reach the address bar: POST, cancelled, and no named fields to serialize. */
function expectNoNativeSerialization(form: HTMLFormElement) {
  expect(form.getAttribute("method")).toBe("post");
  expect([...new FormData(form).keys()]).toEqual([]);
  expect(window.location.href).not.toContain(SECRET);
  expect(window.location.search).toBe("");
}

describe("sign-in forms keep credentials out of URLs", () => {
  it("signs in through the API, never through the form's own submit", async () => {
    authClient.signIn.email.mockResolvedValue({ data: { token: "t" }, error: null });
    await render(<LoginForm />);
    const form = container.querySelector("form")!;
    type(container.querySelector("#email"), "owner@example.com");
    type(container.querySelector("#password"), SECRET);

    expect(await submit(form)).toBe(true);
    expectNoNativeSerialization(form);
    expect(authClient.signIn.email).toHaveBeenCalledWith(
      expect.objectContaining({ email: "owner@example.com", password: SECRET, rememberMe: true }),
    );
    expect(navigate).toHaveBeenCalledWith({ to: "/admin", replace: true });
    expect(JSON.stringify(navigate.mock.calls)).not.toContain(SECRET);
  });

  it("stores only the 2FA methods, not the password, when a second step is needed", async () => {
    authClient.signIn.email.mockResolvedValue({ data: { twoFactorRedirect: true, twoFactorMethods: ["otp"] }, error: null });
    await render(<LoginForm />);
    type(container.querySelector("#email"), "owner@example.com");
    type(container.querySelector("#password"), SECRET);
    await submit();

    expect(navigate).toHaveBeenCalledWith({ to: "/auth/two-factor", replace: true });
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
  });

  it("requests a reset link with a JSON body and says the same thing for any address", async () => {
    await render(<ForgotPasswordForm />);
    const form = container.querySelector("form")!;
    type(container.querySelector("#email"), `${SECRET}@example.com`);
    expect(await submit(form)).toBe(true);

    expect(window.location.href).not.toContain(SECRET);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/request-password-reset");
    expect(JSON.parse(String(init.body))).toMatchObject({ email: `${SECRET}@example.com` });
    expect(container.textContent).toContain("Check your email");
  });

  it("removes the reset proof from the address bar and posts only the new password", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#token=proof-proof-proof-1234");
    await render(<ResetPasswordForm />);
    expect(window.location.href).not.toContain("proof-proof");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      token: "proof-proof-proof-1234",
    });

    const form = container.querySelector("form")!;
    type(container.querySelector("#new-password"), SECRET);
    expect(await submit(form)).toBe(true);
    expectNoNativeSerialization(form);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/auth/reset-password-session");
    expect(JSON.parse(String(init.body))).toEqual({ newPassword: SECRET });
    expect(container.textContent).toContain("Password changed");
  });

  it("opens an invite as account setup and continues straight into sign-in", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#invite=proof-proof-proof-1234");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, purpose: "invite" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, signedIn: true }), { status: 200 }));
    await render(<ResetPasswordForm />);
    expect(window.location.href).not.toContain("proof-proof");
    expect(container.textContent).toContain("Set up your account");

    type(container.querySelector("#new-password"), SECRET);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: "/admin", replace: true });
  });

  it("goes from a new invite password straight to the emailed code, never asking for the password again", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#invite=proof-proof-proof-1234");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, purpose: "invite" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: true,
        signedIn: true,
        twoFactorSetup: { backupCodes: ["k7qx4-mn2pa", "b3cde-fgh45"] },
      }), { status: 200 }));
    await render(<ResetPasswordForm />);
    type(container.querySelector("#new-password"), SECRET);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: "/auth/setup-2fa", replace: true });
    expect(window.sessionStorage.length).toBe(0);

    await render(<TwoFactorSetup userEmail="karim@example.com" />);
    expect(container.querySelector("#setup-password")).toBeNull();
    expect(container.textContent).toContain("Check your email");
    expect(authClient.twoFactor.sendOtp).toHaveBeenCalledOnce();
    expect(authClient.twoFactor.enable).not.toHaveBeenCalled();

    container.querySelectorAll("form input").forEach((box, index) => type(box, String(index + 1)));
    await flush();
    expect(sdk.postApiV1AdminAuth2FaMethod).toHaveBeenCalledWith({ body: { method: "email", code: "123456" } });
    expect(container.textContent).toContain("k7qx4-mn2pa");

    // The hand-off is used once: a later visit starts with the password again.
    act(() => root.unmount());
    root = createRoot(container);
    await render(<TwoFactorSetup userEmail="karim@example.com" />);
    expect(container.querySelector("#setup-password")).not.toBeNull();
  });

  it("hands a reset for a two-step account to the code screen", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#token=proof-proof-proof-1234");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, purpose: "reset" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, twoFactorRedirect: true, twoFactorMethods: ["totp"] }), { status: 200 }));
    await render(<ResetPasswordForm />);
    type(container.querySelector("#new-password"), SECRET);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: "/auth/two-factor", replace: true });
    expect(window.sessionStorage.getItem("scalius.pendingTwoFactorMethods")).toContain("totp");
  });

  it("sends the setup key as a header, never in the body or the URL", async () => {
    authClient.signIn.email.mockResolvedValue({ data: {}, error: null });
    await render(<SetupForm setupTokenRequired />);
    const form = container.querySelector("form")!;
    type(container.querySelector("#setup-name"), "Owner");
    type(container.querySelector("#setup-email"), "owner@example.com");
    type(container.querySelector("#setup-password"), SECRET);
    type(container.querySelector("#setup-confirmPassword"), SECRET);
    type(container.querySelector("#setup-setupKey"), "setup-key-value");
    expect(await submit(form)).toBe(true);

    expectNoNativeSerialization(form);
    const [request] = sdk.postApiV1Setup.mock.calls[0] as [{ body: unknown; headers: Record<string, string> }];
    expect(JSON.stringify(request.body)).not.toContain("setup-key-value");
    expect(Object.values(request.headers)).toEqual(["setup-key-value"]);
    expect(navigate).toHaveBeenCalledWith({ to: "/admin" });
  });

  it("verifies a typed 2FA code without putting it anywhere but the request", async () => {
    window.sessionStorage.setItem("scalius.pendingTwoFactorMethods", JSON.stringify(["totp"]));
    authClient.twoFactor.verifyTotp.mockResolvedValue({ data: {}, error: null });
    await render(<TwoFactorForm />);
    const boxes = container.querySelectorAll("form input");
    boxes.forEach((box, index) => type(box, String(index + 1)));
    await flush();

    expectNoNativeSerialization(container.querySelector("form")!);
    expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledOnce();
    expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: false });
    expect(navigate).toHaveBeenCalledWith({ to: "/admin", replace: true });
    expect(window.sessionStorage.getItem("scalius.pendingTwoFactorMethods")).toBeNull();
  });

  it("confirms the password for 2FA setup without a native submit", async () => {
    authClient.twoFactor.enable.mockResolvedValue({ data: { method: "totp", totpURI: "otpauth://x", backupCodes: ["aaaa-1111"] }, error: null });
    await render(<TwoFactorSetup userEmail="owner@example.com" />);
    const form = container.querySelector("form")!;
    type(container.querySelector("#setup-password"), SECRET);
    expect(await submit(form)).toBe(true);
    expectNoNativeSerialization(form);
    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({ password: SECRET, method: "totp" });
    expect(authClient.twoFactor.sendOtp).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Check your email");
  });
});

describe("sign-in error states", () => {
  async function signInWith(result: unknown, headers: Record<string, string> = {}) {
    authClient.signIn.email.mockImplementation(async (request: { fetchOptions?: { onError?: (context: unknown) => void } }) => {
      if (result instanceof Error) throw result;
      request.fetchOptions?.onError?.({ response: new Response(null, { status: 429, headers }) });
      return { data: null, error: result };
    });
    await render(<LoginForm />);
    type(container.querySelector("#email"), "owner@example.com");
    type(container.querySelector("#password"), SECRET);
    await submit();
  }

  it("asks for missing fields before calling the API", async () => {
    await render(<LoginForm />);
    await submit();
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter your email");
    expect(container.textContent).toContain("Enter your password");
    expect(container.querySelector("#email")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.id).toBe("email");
  });

  it("says the email or password is wrong, clears the password and focuses it", async () => {
    await signInWith({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
    expect(alertText()).toBe("Incorrect email or password.");
    expect((container.querySelector("#password") as HTMLInputElement).value).toBe("");
    expect(document.activeElement?.id).toBe("password");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("tells a rate-limited merchant exactly how long to wait", async () => {
    await signInWith({ status: 429, message: "Too many requests" }, { "X-Retry-After": "42" });
    expect(alertText()).toBe("Too many attempts. Try again in 42 seconds.");
  });

  it("separates a lost connection from a wrong password", async () => {
    await signInWith(new TypeError("Failed to fetch"));
    expect(alertText()).toBe("Couldn't reach Scalius. Check your connection and try again.");
  });

  it("never shows server internals", async () => {
    await signInWith({ status: 500, message: "D1_ERROR: no such table: session" });
    expect(alertText()).toBe("Something went wrong on our side. Try again in a moment.");
  });

  it("names the 2FA lockout honestly", async () => {
    window.sessionStorage.setItem("scalius.pendingTwoFactorMethods", JSON.stringify(["totp"]));
    authClient.twoFactor.verifyTotp.mockResolvedValue({ data: null, error: { status: 429, code: "ACCOUNT_TEMPORARILY_LOCKED" } });
    await render(<TwoFactorForm />);
    container.querySelectorAll("form input").forEach((box, index) => type(box, String(index)));
    await flush();
    expect(alertText()).toBe("Too many wrong codes. For your security, try again in 15 minutes.");
    // The boxes are cleared for the next attempt.
    expect([...container.querySelectorAll<HTMLInputElement>("form input")].map((box) => box.value).join("")).toBe("");
  });

  it("sends an expired 2FA sign-in back to the start", async () => {
    window.sessionStorage.setItem("scalius.pendingTwoFactorMethods", JSON.stringify(["otp"]));
    authClient.twoFactor.sendOtp.mockResolvedValueOnce({ data: null, error: { status: 401, code: "INVALID_TWO_FACTOR_COOKIE" } } as never);
    await render(<TwoFactorForm />);
    expect(alertText()).toContain("Your sign-in timed out. Sign in again.");
  });

  it("shows an expired reset link instead of a form that cannot work", async () => {
    window.history.replaceState(null, "", "/auth/reset-password");
    await render(<ResetPasswordForm />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("This link has expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says a used or expired invite has expired, before showing any form", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#invite=proof-proof-proof-1234");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "INVALID_TOKEN" }), { status: 400 }));
    await render(<ResetPasswordForm />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("This invite has expired");
    expect(container.textContent).toContain("Ask the store owner to resend it.");
  });

  it("says a used invite was already used and offers sign-in", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#invite=proof-proof-proof-1234");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "TOKEN_USED" }), { status: 400 }));
    await render(<ResetPasswordForm />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("This invite was already used");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/auth/login");
    expect(container.querySelector("a")?.textContent).toBe("Sign in");
  });

  it("says a cancelled invite was cancelled and who can invite again", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#invite=proof-proof-proof-1234");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "TOKEN_CANCELLED" }), { status: 400 }));
    await render(<ResetPasswordForm />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("This invite was cancelled");
    expect(container.textContent).toContain("Ask the store owner to invite you again.");
    expect(container.textContent).not.toContain("expired");
  });

  it("tells staff whose access was changed why they were signed out, before they type anything", async () => {
    await render(<LoginForm signedOut="access_changed" />);
    expect(alertText()).toBe("You were signed out because your access changed. Contact the store owner.");
  });

  it("tells a suspended staff member why sign-in stopped", async () => {
    await signInWith({ status: 403, code: "BANNED_USER", message: "Your access to this store is suspended." });
    expect(alertText()).toBe("Your access to this store is suspended. Contact the store owner.");
  });

  it("switches to the expired state when the server rejects the reset link", async () => {
    window.history.replaceState(null, "", "/auth/reset-password#token=proof-proof-proof-1234");
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "INVALID_TOKEN" }), { status: 400 }));
    await render(<ResetPasswordForm />);
    type(container.querySelector("#new-password"), SECRET);
    await submit();
    expect(container.textContent).toContain("This link has expired");
  });

  it("flags a wrong setup key on its field", async () => {
    const { AdminApiResponseError } = await import("@/lib/admin-api-error");
    sdk.postApiV1Setup.mockRejectedValueOnce(
      new AdminApiResponseError("A valid setup token is required to complete first-admin setup.", 403),
    );
    await render(<SetupForm setupTokenRequired />);
    type(container.querySelector("#setup-name"), "Owner");
    type(container.querySelector("#setup-email"), "owner@example.com");
    type(container.querySelector("#setup-password"), SECRET);
    type(container.querySelector("#setup-confirmPassword"), SECRET);
    type(container.querySelector("#setup-setupKey"), "wrong");
    await submit();
    expect(container.querySelector("#setup-setupKey-message")?.textContent).toBe(
      "That setup key isn't right. Check it and try again.",
    );
    expect(document.activeElement?.id).toBe("setup-setupKey");
  });
});

describe("verification code input", () => {
  function Harness({ onComplete }: { onComplete: (code: string) => void }) {
    const [code, setCode] = useState("");
    return <CodeInput id="code" value={code} onChange={setCode} onComplete={onComplete} />;
  }

  const boxes = () => [...container.querySelectorAll<HTMLInputElement>("input")];
  const code = () => boxes().map((box) => box.value).join("");

  function key(box: HTMLInputElement, name: string) {
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    });
  }

  function paste(box: HTMLInputElement, text: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    act(() => {
      box.dispatchEvent(event);
    });
  }

  it("opens the number pad and offers one-time-code autofill on the first box", async () => {
    await render(<Harness onComplete={vi.fn()} />);
    expect(boxes()).toHaveLength(6);
    expect(boxes().every((box) => box.inputMode === "numeric" && box.getAttribute("pattern") === "[0-9]*")).toBe(true);
    expect(boxes()[0]!.autocomplete).toBe("one-time-code");
    expect(boxes().every((box) => !box.name)).toBe(true);
  });

  it("moves to the next box as each digit is typed and completes once", async () => {
    const onComplete = vi.fn();
    await render(<Harness onComplete={onComplete} />);
    type(boxes()[0]!, "4");
    expect(document.activeElement).toBe(boxes()[1]);
    type(boxes()[1]!, "x");
    expect(code()).toBe("4");
    for (const [index, digit] of ["2", "0", "7", "1", "9"].entries()) type(boxes()[index + 1]!, digit);
    expect(code()).toBe("420719");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("420719");
  });

  it("fills every box from a pasted code, Bangla digits included", async () => {
    const onComplete = vi.fn();
    await render(<Harness onComplete={onComplete} />);
    paste(boxes()[0]!, " ১২৩-৪৫৬ ");
    expect(code()).toBe("123456");
    expect(onComplete).toHaveBeenCalledWith("123456");
    expect(document.activeElement).toBe(boxes()[5]);
  });

  it("fills the whole code when the phone autofills the first box", async () => {
    await render(<Harness onComplete={vi.fn()} />);
    type(boxes()[0]!, "654321");
    expect(code()).toBe("654321");
  });

  it("deletes backwards with Backspace", async () => {
    await render(<Harness onComplete={vi.fn()} />);
    paste(boxes()[0]!, "123");
    expect(document.activeElement).toBe(boxes()[3]);
    key(boxes()[3]!, "Backspace");
    expect(code()).toBe("12");
    expect(document.activeElement).toBe(boxes()[2]);
    key(boxes()[2]!, "Backspace");
    expect(code()).toBe("1");
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it("keeps the boxes filled left to right", async () => {
    await render(<Harness onComplete={vi.fn()} />);
    act(() => boxes()[4]!.focus());
    expect(document.activeElement).toBe(boxes()[0]);
  });
});
