"use client";

import { useState, type FormEvent } from "react";
import { ShieldAlert, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { PageHero } from "@/components/layout/page-hero";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import {
  checkBlacklist,
  clearRiskFlag,
  getSecurityOverview,
  setBlacklist,
  type BlacklistKind,
} from "@/services/admin";
import { formatDate } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

const REASONS: Record<string, string> = {
  recipient_velocity: "Sent to 20+ different numbers in 5 minutes",
};

/**
 * Anti-fraud controls (blueprint 8.3, 8.4). Blacklisted values are stored as
 * keyed hashes, so the list cannot be browsed - an admin checks a specific
 * number or identity and blocks or unblocks it.
 */
export default function AdminSecurityPage() {
  const toast = useToast();
  const overview = useAsyncData(getSecurityOverview, []);
  const [kind, setKind] = useState<BlacklistKind>("phone");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState<{ value: string; kind: BlacklistKind; blocked: boolean; note: string; updatedAt: number | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (event?: FormEvent) => {
    event?.preventDefault();
    const target = value.trim();
    if (!target) return;
    setBusy(true);
    try {
      const status = await checkBlacklist(kind, target);
      setChecked({ value: target, kind, ...status });
    } catch (error) {
      setChecked(null);
      toast.error(errorMessage(error, "Could not check that value."));
    } finally {
      setBusy(false);
    }
  };

  const change = async (active: boolean) => {
    if (!checked) return;
    setBusy(true);
    try {
      await setBlacklist(checked.kind, checked.value, active, note.trim());
      toast.success(active ? "Blocked. It is refused everywhere within seconds." : "Unblocked");
      setChecked({ ...checked, blocked: active, note: active ? note.trim() : "", updatedAt: Date.now() });
      setNote("");
      void overview.reload();
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the blacklist."));
    } finally {
      setBusy(false);
    }
  };

  const dismissFlag = async (id: string) => {
    try {
      await clearRiskFlag(id);
      toast.success("Flag dismissed");
      void overview.reload();
    } catch (error) {
      toast.error(errorMessage(error, "Could not dismiss the flag."));
    }
  };

  const flags = overview.data?.riskFlags ?? [];

  return (
    <>
      <PageHero title="Security" description="Block abusive recipients or accounts and review automated risk flags." />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Blocked numbers" value={overview.data?.blacklist.phone ?? 0} loading={overview.loading && !overview.data} />
        <Stat label="Blocked identities" value={overview.data?.blacklist.identity ?? 0} loading={overview.loading && !overview.data} />
        <Stat label="Open risk flags" value={flags.length} loading={overview.loading && !overview.data} />
      </div>

      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Blacklist"
          description="Blocked recipients are refused at the shop, eStores and repair with a neutral message. Identities can be an email or a user id."
        />
        <form onSubmit={check} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <Field label="Type" htmlFor="blacklist-kind">
            <Select id="blacklist-kind" value={kind} onChange={(event) => { setKind(event.target.value as BlacklistKind); setChecked(null); }}>
              <option value="phone">Phone number</option>
              <option value="identity">Email / user id</option>
            </Select>
          </Field>
          <Field label={kind === "phone" ? "Phone number" : "Email or user id"} htmlFor="blacklist-value">
            <Input
              id="blacklist-value"
              value={value}
              inputMode={kind === "phone" ? "tel" : "text"}
              placeholder={kind === "phone" ? "0XXXXXXXXX" : "name@example.com"}
              onChange={(event) => { setValue(event.target.value); setChecked(null); }}
            />
          </Field>
          <Button type="submit" variant="secondary" loading={busy && !checked}>Check</Button>
        </form>

        {checked ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-soft p-4">
            <div className="flex flex-wrap items-center gap-2">
              {checked.blocked ? <ShieldX className="size-5 text-danger" aria-hidden /> : <ShieldCheck className="size-5 text-success" aria-hidden />}
              <span className="font-mono text-sm text-ink">{checked.value}</span>
              <Badge tone={checked.blocked ? "danger" : "success"}>{checked.blocked ? "Blocked" : "Not blocked"}</Badge>
              {checked.updatedAt ? <span className="text-xs text-muted">since {formatDate(checked.updatedAt)}</span> : null}
            </div>
            {checked.blocked && checked.note ? <p className="text-sm text-ink-soft">Note: {checked.note}</p> : null}
            {checked.blocked ? (
              <div>
                <Button variant="secondary" size="sm" loading={busy} onClick={() => void change(false)}>Unblock</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Field label="Reason (optional)" htmlFor="blacklist-note" className="flex-1">
                  <Input id="blacklist-note" value={note} maxLength={140} placeholder="e.g. chargeback on 12 Oct" onChange={(event) => setNote(event.target.value)} />
                </Field>
                <Button variant="danger" loading={busy} onClick={() => void change(true)}>Block</Button>
              </div>
            )}
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Risk flags"
          description="Raised automatically when an account or IP shows bot-like behaviour. The activity was already refused; review and block if needed."
        />
        {overview.error ? (
          <ErrorState message={overview.error} onRetry={overview.reload} />
        ) : overview.loading && !overview.data ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : flags.length === 0 ? (
          <EmptyState title="No risk flags" description="Nothing suspicious has been detected." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr><Th>Actor</Th><Th>Reason</Th><Th>Count</Th><Th>Last seen</Th><Th /></tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <tr key={flag.id}>
                    <Td className="font-mono text-xs text-ink">{flag.actor}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldAlert className="size-3.5 text-warning" aria-hidden />
                        {REASONS[flag.reason] || flag.reason}
                      </span>
                    </Td>
                    <Td className="tabular">{flag.count}</Td>
                    <Td>{formatDate(flag.lastAt)}</Td>
                    <Td className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => void dismissFlag(flag.id)} aria-label="Dismiss flag">
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
