"use client";

import { useState, type FocusEvent, type FormEvent } from "react";
import { formatDate, formatMoney, normalizePhone } from "@/lib/format";
import { getUserProfile, getWalletBalance, updateUserProfile } from "@/services/api";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";

async function loadAccount() {
  const [profile, balance] = await Promise.all([
    getUserProfile(),
    getWalletBalance(),
  ]);
  return { profile, balance };
}

export default function AccountPage() {
  const { user } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsyncData(loadAccount, []);
  const [saving, setSaving] = useState(false);

  function normalizePhoneField(event: FocusEvent<HTMLInputElement>) {
    event.target.value = normalizePhone(event.target.value);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "").trim();
    const phone = normalizePhone(String(form.get("phone") || ""));

    if (!username || username.length < 2) {
      toast.error("Enter a valid username.");
      return;
    }
    if (phone.length !== 10) {
      toast.error("Enter a valid 10-digit phone number.");
      return;
    }

    setSaving(true);
    try {
      await updateUserProfile({ username, phone });
      toast.success("Account updated.");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save account.");
    } finally {
      setSaving(false);
    }
  }

  const email = data?.profile.email || user?.email || "-";
  const joined = data?.profile.createdAt ? formatDate(data.profile.createdAt) : "-";

  return (
    <>
      <PageHero title="Account" description="Manage your profile details." />

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Card className="flex flex-col gap-4">
            <CardHeader title="Profile" description="Update your name and phone." />
            {loading || !data ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-11 rounded-lg" />
                <Skeleton className="h-11 rounded-lg" />
                <Skeleton className="h-11 w-36 rounded-lg" />
              </div>
            ) : (
              // Remounts with fresh defaultValues each time data reloads.
              <form
                key={JSON.stringify(data.profile)}
                onSubmit={handleSave}
                className="flex flex-col gap-4"
              >
                <Field label="Username" htmlFor="account-name">
                  <Input
                    id="account-name"
                    name="username"
                    defaultValue={data.profile.username || user?.displayName || ""}
                    placeholder="Your username"
                  />
                </Field>
                <Field label="Phone" htmlFor="account-phone">
                  <Input
                    id="account-phone"
                    name="phone"
                    type="tel"
                    inputMode="numeric"
                    defaultValue={data.profile.phone || ""}
                    onBlur={normalizePhoneField}
                    placeholder="0XXXXXXXXX"
                  />
                </Field>
                <div>
                  <Button type="submit" loading={saving}>
                    Save Changes
                  </Button>
                </div>
              </form>
            )}
          </Card>

          <Card className="flex flex-col gap-4">
            <CardHeader title="Overview" />
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Email</dt>
                <dd className="truncate font-medium text-ink">{email}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <dt className="text-muted">Joined</dt>
                <dd className="font-medium text-ink">{joined}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <dt className="text-muted">Wallet</dt>
                <dd className="font-medium text-ink">
                  {loading ? "…" : formatMoney(data?.balance)}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
