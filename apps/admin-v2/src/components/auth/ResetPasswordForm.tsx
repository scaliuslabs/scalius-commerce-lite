import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useHydrated } from "@/hooks/use-hydrated";

function getResetError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Could not reset the password. Request a new reset link and try again.";
}

export function ResetPasswordForm() {
  const [resetSessionReady, setResetSessionReady] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const isHydrated = useHydrated();
  const resetExchangeRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    let active = true;
    if (!resetExchangeRef.current) {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const token = fragment.get("token");

      // The reset proof is accepted only from the fragment, which browsers do
      // not send in the document request or Referer header. Remove it before
      // exchanging it for the short-lived HttpOnly reset-session cookie.
      window.history.replaceState(null, "", window.location.pathname);
      resetExchangeRef.current = token
        ? fetch("/api/auth/reset-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          })
            .then((response) => response.ok)
            .catch(() => false)
        : Promise.resolve(false);
    }

    void resetExchangeRef.current.then((ready) => {
      if (!active) return;
      setResetSessionReady(ready);
      setTokenReady(true);
    });

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!resetSessionReady) {
      setError("This reset link is invalid or has expired.");
      return;
    }

    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || "This reset link is invalid or expired.");
      }
      setPassword("");
      setConfirmPassword("");
      setIsComplete(true);
    } catch (resetError) {
      setPassword("");
      setConfirmPassword("");
      setError(getResetError(resetError));
    } finally {
      setIsLoading(false);
    }
  }

  if (!tokenReady) {
    return (
      <Card className="w-full border-0 bg-transparent shadow-none">
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (isComplete) {
    return (
      <Card className="w-full border-0 bg-transparent shadow-none">
        <CardHeader className="space-y-4 px-0 pt-0 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              Password updated
            </CardTitle>
            <CardDescription>
              You can now sign in with your new password.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Button asChild className="h-11 w-full">
            <Link to="/auth/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const invalidToken = !resetSessionReady;

  return (
    <Card className="w-full border-0 bg-transparent shadow-none">
      <CardHeader className="space-y-2 px-0 pt-0 text-center">
        <CardTitle className="text-2xl font-semibold tracking-tight">
          Reset password
        </CardTitle>
        <CardDescription>
          Choose a new password for your admin account.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {invalidToken ? (
          <div className="space-y-4">
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>This reset link is invalid or has expired.</span>
            </div>
            <Button asChild className="h-11 w-full">
              <Link to="/auth/forgot-password">Request a new link</Link>
            </Button>
          </div>
        ) : (
          <form
            method="post"
            action="/auth/reset-password"
            onSubmit={handleSubmit}
            className="space-y-4"
            noValidate
          >
            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter a strong password"
                  autoComplete="new-password"
                  required
                  disabled={!isHydrated || isLoading}
                  className="h-11 pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                  required
                  disabled={!isHydrated || isLoading}
                  className="h-11 pl-10"
                />
              </div>
            </div>

            <Button
              type="submit"
              className="h-11 w-full"
              disabled={!isHydrated || isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update password"
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
