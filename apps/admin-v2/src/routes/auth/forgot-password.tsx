import { createFileRoute } from "@tanstack/react-router";
import { redirectIfAuthenticated } from "~/lib/auth.fns";
import { useState } from "react";
import { Mail } from "lucide-react";

export const Route = createFileRoute("/auth/forgot-password")({
  beforeLoad: () => redirectIfAuthenticated(),
  head: () => ({
    meta: [{ title: "Forgot Password - Scalius Admin" }],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!email.trim()) {
      setError("Please enter your email address.");
      return;
    }

    setIsLoading(true);
    try {
      await fetch("/api/auth/forget-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/auth/reset-password" }),
      });
      setSubmitted(true);
    } catch {
      // Always show success to prevent email enumeration.
      // The server won't send an email if the account doesn't exist,
      // but we don't reveal that to the user.
      setSubmitted(true);
    } finally {
      setIsLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Check your email</h2>
          <p className="text-sm text-muted-foreground">
            If an account exists for <span className="font-medium text-foreground">{email}</span>,
            we've sent a password reset link. It will expire in 1 hour.
          </p>
        </div>
        <div className="space-y-3 pt-2">
          <p className="text-xs text-muted-foreground">
            Didn't receive the email? Check your spam folder or try again.
          </p>
          <button
            type="button"
            onClick={() => { setSubmitted(false); setEmail(""); }}
            className="text-sm font-medium text-primary hover:underline"
          >
            Try a different email
          </button>
        </div>
        <a
          href="/auth/login"
          className="mt-4 block text-sm text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold">Forgot your password?</h2>
        <p className="text-sm text-muted-foreground">
          Enter your email address and we'll send you a reset link.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
            autoFocus
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {isLoading ? "Sending..." : "Send reset link"}
        </button>
      </form>
      <a
        href="/auth/login"
        className="block text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Back to sign in
      </a>
    </div>
  );
}
