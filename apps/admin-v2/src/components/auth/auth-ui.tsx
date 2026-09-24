/**
 * The pieces every sign-in screen shares: heading, error banner, labelled
 * field, password field with show/hide and the 6-digit code input.
 */
import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Input, fieldClassName } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { clearPendingTwoFactorMethods } from "~/lib/two-factor-pending";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import type { AuthMessage } from "./auth-error";

/** Quiet text actions: "Forgot password?", "Resend code", "Back to sign in". */
export const linkClassName =
  "rounded-md text-body text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground";

export function AuthHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-heading-lg">{title}</h1>
      {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
    </header>
  );
}

/** The banner for a failed request. `role="alert"` makes screen readers announce it. */
export function AuthAlert({ message, children }: { message: AuthMessage | null; children?: ReactNode }) {
  const t = useMessages(authMessages);
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertDescription>
        <p>{t(message.key, message.vars)}</p>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Leaves a half-finished sign-in (2FA, a required password change) for the
 * sign-in page. Better Auth loads on click, keeping it out of these chunks.
 */
export function SignOutButton({ label = "signOut" }: { label?: AuthMessageKey }) {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    clearPendingTwoFactorMethods();
    try {
      const { authClient } = await import("@/lib/auth-client");
      await authClient.signOut();
    } catch {
      // The sign-in page reads the session again and sends a live one onward.
    }
    await navigate({ to: "/auth/login", replace: true });
    setBusy(false);
  }

  return (
    <button type="button" className={linkClassName} disabled={busy} onClick={() => void signOut()}>
      {t(label)}
    </button>
  );
}

/** ARIA wiring for a control inside `Field`: the message below it describes it. */
/** Saves the recovery codes as a text file made in the browser; they never leave the page. */
export function downloadRecoveryCodes(codes: readonly string[], intro: string) {
  const url = URL.createObjectURL(new Blob([`${intro}\n\n${codes.join("\n")}\n`], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "recovery-codes.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function describedBy(id: string, error?: string | null, hint?: string) {
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error || hint ? `${id}-message` : undefined,
  };
}

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      {children}
      {error || hint ? (
        <p id={`${id}-message`} className={cn("text-body", error ? "text-destructive" : "text-muted-foreground")}>
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}

/** A password field with a show/hide button. It never carries a `name`, so nothing can serialize it. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<ComponentProps<"input">, "type" | "name">>(
  function PasswordInput(props, ref) {
    const t = useMessages(authMessages);
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          type={visible ? "text" : "password"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          // eslint-disable-next-line shadcn/no-restyle -- room for the show/hide button inside the field
          className="pr-11"
        />
        <button
          type="button"
          aria-label={t("showPassword")}
          aria-pressed={visible}
          aria-controls={props.id}
          disabled={props.disabled}
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          {visible ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
        </button>
      </div>
    );
  },
);

/** Seconds until another email code may be sent; `start` begins a 30-second wait. */
export function useResendCooldown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  const start = useCallback(() => setSeconds(30), []);
  const reset = useCallback(() => setSeconds(0), []);
  return { seconds, start, reset };
}

const CODE_LENGTH = 6;

/** Latin digits only; Bangla digits (০–৯) typed on a Bangla keyboard count too. */
function digitsOf(text: string): string {
  return text.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6)).replace(/\D/g, "");
}

/**
 * Six boxes for a verification code. Typing moves to the next box, Backspace
 * to the previous one, and a pasted or autofilled code fills every box.
 * Phones open the number pad. `onComplete` fires once all six are in.
 */
export function CodeInput({
  id,
  value,
  onChange,
  onComplete,
  invalid,
  describedById,
  disabled,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  invalid?: boolean;
  describedById?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const t = useMessages(authMessages);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  // Focus moves before the parent re-renders, so focus handlers read the code from here.
  const latest = useRef(value);
  latest.current = value;

  function commit(next: string, focusIndex: number) {
    const code = next.slice(0, CODE_LENGTH);
    latest.current = code;
    onChange(code);
    boxes.current[Math.min(focusIndex, code.length, CODE_LENGTH - 1)]?.focus();
    if (code.length === CODE_LENGTH && code !== value) onComplete?.(code);
  }

  function enter(index: number, text: string) {
    const typed = digitsOf(text);
    if (!typed) return;
    // A whole code (paste, or the phone's one-time-code autofill) replaces the lot.
    if (typed.length >= CODE_LENGTH) return commit(typed, CODE_LENGTH - 1);
    commit(value.slice(0, index) + typed + value.slice(index + typed.length), index + typed.length);
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (value[index]) commit(value.slice(0, index) + value.slice(index + 1), index);
      else if (index > 0) commit(value.slice(0, index - 1), index - 1);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      boxes.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < value.length) {
      event.preventDefault();
      boxes.current[index + 1]?.focus();
    }
  }

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="grid grid-cols-6 gap-2">
      {Array.from({ length: CODE_LENGTH }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          id={index === 0 ? id : undefined}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          autoFocus={autoFocus && index === 0}
          aria-label={t("digitLabel", { index: index + 1, count: CODE_LENGTH })}
          aria-invalid={invalid || undefined}
          aria-describedby={describedById}
          disabled={disabled}
          value={value[index] ?? ""}
          // Boxes fill left to right: focusing a later empty box lands on the first empty one.
          onFocus={(event) => {
            if (index > latest.current.length) boxes.current[latest.current.length]?.focus();
            else event.currentTarget.select();
          }}
          onChange={(event) => {
            // The typed digit is whatever is new next to the one already in the box.
            const typed = digitsOf(event.currentTarget.value);
            enter(index, typed.length >= CODE_LENGTH ? typed : typed.replace(value[index] ?? "", "") || typed);
          }}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={(event) => {
            event.preventDefault();
            enter(index, event.clipboardData.getData("text"));
          }}
          className={cn(fieldClassName, "h-12 px-0 text-center text-heading-md tabular-nums sm:text-heading-md")}
        />
      ))}
    </div>
  );
}
