"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteUser } from "firebase/auth";
import { cn } from "@/lib/cn";
import { normalizePhone } from "@/lib/format";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import { bootstrapAccount } from "@/services/api";
import { Brand } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";

type Tab = "login" | "signup" | "reset";

const TABS: { id: Tab; label: string }[] = [
  { id: "login", label: "Login" },
  { id: "signup", label: "Sign Up" },
  { id: "reset", label: "Reset" },
];

export default function AuthPage() {
  const router = useRouter();
  const { user, loading, signIn, signUp, resetPassword } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("login");
  const [submitting, setSubmitting] = useState(false);

  // If already authenticated, leave the auth screen (mirrors auth.js).
  useEffect(() => {
    if (!loading && user) {
      router.replace("/dashboard");
    }
  }, [loading, user, router]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");

    setSubmitting(true);
    try {
      await signIn(email, password);
      router.replace("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "").trim();
    const email = String(form.get("email") || "").trim();
    const phone = normalizePhone(String(form.get("phone") || ""));
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirmPassword") || "");

    if (password !== confirm) {
      toast.error("Passwords do not match.");
      return;
    }
    if (username.length < 2) {
      toast.error("Username is too short.");
      return;
    }
    if (phone.length !== 10) {
      toast.error("Enter a valid 10-digit phone number.");
      return;
    }

    setSubmitting(true);
    try {
      const credential = await signUp(email, password);
      try {
        await bootstrapAccount({ username, phone });
      } catch (bootstrapError) {
        // Roll back the auth account if server bootstrap fails (matches auth.js).
        await deleteUser(credential.user).catch(() => null);
        throw bootstrapError;
      }
      router.replace("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Signup failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") || "").trim();

    setSubmitting(true);
    try {
      await resetPassword(email);
      toast.success("Password reset link sent. Check your email.");
      form.reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reset failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Brand withNote={false} />
        </div>

        <div className="rounded-card border border-border bg-surface p-6 shadow-md sm:p-8">
          <div className="mb-6 flex gap-1 rounded-lg bg-surface-muted p-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={cn(
                  "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  tab === entry.id
                    ? "bg-surface text-ink shadow-xs"
                    : "text-muted hover:text-ink-soft",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            key={tab}
            className="animate-[page-rise_0.15s_ease-out] motion-reduce:animate-none"
          >
          {tab === "login" && (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <Field label="Email" htmlFor="login-email">
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </Field>
              <Field label="Password" htmlFor="login-password">
                <PasswordInput
                  id="login-password"
                  name="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  required
                />
              </Field>
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                Log In
              </Button>
            </form>
          )}

          {tab === "signup" && (
            <form onSubmit={handleSignup} className="flex flex-col gap-4">
              <Field label="Username" htmlFor="signup-username">
                <Input
                  id="signup-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  placeholder="Choose a username"
                  required
                />
              </Field>
              <Field label="Email" htmlFor="signup-email">
                <Input
                  id="signup-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </Field>
              <Field label="Phone" htmlFor="signup-phone">
                <Input
                  id="signup-phone"
                  name="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="0XXXXXXXXX"
                  required
                />
              </Field>
              <Field label="Password" htmlFor="signup-password">
                <PasswordInput
                  id="signup-password"
                  name="password"
                  autoComplete="new-password"
                  placeholder="Create a password"
                  required
                />
              </Field>
              <Field label="Confirm Password" htmlFor="signup-confirm">
                <PasswordInput
                  id="signup-confirm"
                  name="confirmPassword"
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  required
                />
              </Field>
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                Create Account
              </Button>
            </form>
          )}

          {tab === "reset" && (
            <form onSubmit={handleReset} className="flex flex-col gap-4">
              <Field
                label="Email"
                htmlFor="reset-email"
                hint="We'll email you a secure reset link."
              >
                <Input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </Field>
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                Send Reset Link
              </Button>
            </form>
          )}
          </div>

          <div className="mt-6 text-center text-sm text-muted">
            <Link href="/dashboard" className="font-medium text-brand hover:underline">
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
