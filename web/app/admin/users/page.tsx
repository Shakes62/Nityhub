"use client";

import { useMemo, useState } from "react";
import { RefreshCw, ShieldCheck, SlidersHorizontal, Trash2, UserCog, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { FilterSelect, FilterToolbar, SearchInput } from "@/components/admin/filters";
import { Pagination } from "@/components/admin/pagination";
import { SortHeader } from "@/components/admin/sort-header";
import { RowActions } from "@/components/admin/row-actions";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { CreditWalletModal } from "@/components/admin/credit-wallet-modal";
import { DetailGrid, DetailRow, DetailSection } from "@/components/admin/detail";
import { formatDate, formatMoney } from "@/lib/format";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import { useAdminData } from "@/contexts/admin-data-context";
import { useTable } from "@/hooks/use-table";
import { ApiError } from "@/types/api";
import type { AdminUser } from "@/types/admin";
import { creditUserWallet, deleteUser, updateUserRole } from "@/services/admin";

type RoleFilter = "all" | "admin" | "agent" | "user";
type ConfirmKind = "admin" | "agent" | "delete";

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "admin", label: "Admins" },
  { value: "agent", label: "Agents" },
  { value: "user", label: "Regular users" },
];

function name(user: AdminUser): string {
  return user.username || user.email || "Unnamed user";
}

function RoleBadges({ user }: { user: AdminUser }) {
  return (
    <div className="flex flex-wrap gap-1">
      {user.isadmin ? <Badge tone="success">Admin</Badge> : null}
      {user.isagent ? <Badge tone="info">Agent</Badge> : null}
      {!user.isadmin && !user.isagent ? <Badge tone="neutral">User</Badge> : null}
    </div>
  );
}

export default function AdminUsersPage() {
  const { overview, loading, error, reload } = useAdminData();
  const { user: authUser } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [viewUid, setViewUid] = useState<string | null>(null);
  const [creditUid, setCreditUid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; uid: string } | null>(null);

  const walletsMap = overview?.walletsMap ?? {};
  const balanceOf = (uid: string) => Number(walletsMap[uid]?.balance || 0);
  const isSelf = (u: AdminUser) => Boolean(authUser && u.uid === authUser.uid);
  const userByUid = (uid: string | null) =>
    (overview?.users ?? []).find((u) => u.uid === uid) ?? null;

  const filtered = useMemo(() => {
    const users = overview?.users ?? [];
    const term = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter === "admin" && !u.isadmin) return false;
      if (roleFilter === "agent" && !u.isagent) return false;
      if (roleFilter === "user" && (u.isadmin || u.isagent)) return false;
      if (!term) return true;
      return [u.username, u.email, u.phone]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(term));
    });
  }, [overview, search, roleFilter]);

  const table = useTable<AdminUser>(
    filtered,
    {
      name: (u) => name(u).toLowerCase(),
      phone: (u) => u.phone || "",
      balance: (u) => balanceOf(u.uid),
      joined: (u) => Number(u.createdAt || 0),
    },
    { pageSize: 25, initialSort: { key: "joined", dir: "desc" } },
  );

  const viewUser = userByUid(viewUid);
  const creditUser = userByUid(creditUid);
  const confirmUser = userByUid(confirm?.uid ?? null);

  const handleError = (err: unknown, fallback: string) =>
    toast.error(err instanceof ApiError || err instanceof Error ? err.message : fallback);

  const doCredit = async (amount: number) => {
    if (!creditUser) return;
    try {
      await creditUserWallet(creditUser.uid, amount);
      toast.success(`Credited ${formatMoney(amount)} to ${name(creditUser)}`);
      await reload();
    } catch (err) {
      handleError(err, "Failed to credit wallet");
      throw err;
    }
  };

  const runConfirm = async () => {
    if (!confirm || !confirmUser) return;
    try {
      if (confirm.kind === "admin") {
        await updateUserRole(confirmUser.uid, { isadmin: !confirmUser.isadmin });
        toast.success(confirmUser.isadmin ? "Admin access revoked" : "Admin access granted");
      } else if (confirm.kind === "agent") {
        await updateUserRole(confirmUser.uid, { isagent: !confirmUser.isagent });
        toast.success(confirmUser.isagent ? "Agent role revoked" : "User promoted to agent");
      } else {
        await deleteUser(confirmUser.uid);
        toast.success("User deleted");
      }
      setConfirm(null);
      await reload();
    } catch (err) {
      handleError(err, "Action failed");
    }
  };

  const confirmCopy = () => {
    if (!confirm || !confirmUser) return { title: "", description: "", label: "Confirm", danger: false };
    const who = name(confirmUser);
    if (confirm.kind === "admin") {
      return confirmUser.isadmin
        ? { title: "Revoke admin access?", description: `${who} will lose access to the admin panel.`, label: "Revoke admin", danger: true }
        : { title: "Grant admin access?", description: `${who} will get full access to the admin panel.`, label: "Grant admin", danger: false };
    }
    if (confirm.kind === "agent") {
      return confirmUser.isagent
        ? { title: "Revoke agent role?", description: `${who} will return to regular pricing.`, label: "Revoke agent", danger: true }
        : { title: "Promote to agent?", description: `${who} will get agent (wholesale) pricing.`, label: "Make agent", danger: false };
    }
    return { title: "Delete user?", description: `Permanently remove ${who}, their wallet, orders and history. This cannot be undone.`, label: "Delete user", danger: true };
  };

  const copy = confirmCopy();

  const moreItemsFor = (u: AdminUser) => [
    {
      label: u.isadmin ? "Revoke admin" : "Grant admin",
      icon: <ShieldCheck />,
      onClick: () => setConfirm({ kind: "admin", uid: u.uid }),
      disabled: isSelf(u) && u.isadmin,
    },
    {
      label: u.isagent ? "Revoke agent" : "Make agent",
      icon: <UserCog />,
      onClick: () => setConfirm({ kind: "agent", uid: u.uid }),
    },
    {
      label: "Credit wallet",
      icon: <Wallet />,
      onClick: () => setCreditUid(u.uid),
    },
    {
      label: "Delete user",
      icon: <Trash2 />,
      danger: true,
      disabled: isSelf(u),
      onClick: () => setConfirm({ kind: "delete", uid: u.uid }),
    },
  ];

  return (
    <>
      <PageHero
        title="Users"
        description="Manage accounts, roles and wallets."
        actions={
          <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      <Card className="flex flex-col gap-4">
        <CardHeader
          title={`${filtered.length} ${filtered.length === 1 ? "user" : "users"}`}
          action={
            <FilterToolbar>
              <SearchInput value={search} onChange={setSearch} placeholder="Name, email or phone" />
              <FilterSelect
                label="Role"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
                options={ROLE_OPTIONS}
              />
            </FilterToolbar>
          }
        />

        {loading && !overview ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={search || roleFilter !== "all" ? "No matching users" : "No users yet"}
            description={search || roleFilter !== "all" ? "Adjust your filters." : undefined}
            icon={<SlidersHorizontal className="size-5" />}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <SortHeader label="User" sortKey="name" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <SortHeader label="Phone" sortKey="phone" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th>Roles</Th>
                    <SortHeader label="Balance" sortKey="balance" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} align="right" />
                    <SortHeader label="Joined" sortKey="joined" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.pageRows.map((u) => (
                    <tr key={u.uid} className="transition-colors hover:bg-surface-soft/60">
                      <Td className="py-2.5">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{name(u)}</p>
                          {u.email && u.email !== name(u) ? (
                            <p className="truncate text-xs text-muted">{u.email}</p>
                          ) : null}
                        </div>
                      </Td>
                      <Td className="py-2.5 font-mono text-[0.8125rem]">{u.phone || "—"}</Td>
                      <Td className="py-2.5">
                        <RoleBadges user={u} />
                      </Td>
                      <Td className="py-2.5 text-right font-medium tabular text-ink">{formatMoney(balanceOf(u.uid))}</Td>
                      <Td className="py-2.5 whitespace-nowrap">{formatDate(u.createdAt)}</Td>
                      <Td className="py-2.5 text-right">
                        <RowActions onView={() => setViewUid(u.uid)} moreItems={moreItemsFor(u)} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              from={table.from}
              to={table.to}
              total={table.total}
              noun="users"
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      {/* View */}
      <Modal
        open={Boolean(viewUser)}
        onClose={() => setViewUid(null)}
        title={viewUser ? name(viewUser) : "User"}
        description={viewUser?.email || undefined}
        size="md"
        footer={
          <Button variant="ghost" size="sm" onClick={() => setViewUid(null)}>
            Close
          </Button>
        }
      >
        {viewUser ? (
          <div className="flex flex-col gap-5">
            <DetailSection title="Account">
              <DetailGrid>
                <DetailRow label="Full name / username" value={viewUser.username} full />
                <DetailRow label="Email" value={viewUser.email} />
                <DetailRow label="Phone" value={viewUser.phone} mono />
                <DetailRow label="Joined" value={formatDate(viewUser.createdAt)} />
                <DetailRow label="Last updated" value={formatDate(viewUser.updatedAt)} />
              </DetailGrid>
            </DetailSection>
            <DetailSection title="Roles & wallet">
              <DetailGrid>
                <DetailRow label="Roles" value={<RoleBadges user={viewUser} />} />
                <DetailRow label="Wallet balance" value={<span className="font-semibold tabular">{formatMoney(balanceOf(viewUser.uid))}</span>} />
              </DetailGrid>
            </DetailSection>
          </div>
        ) : null}
      </Modal>

      {/* Credit */}
      <CreditWalletModal
        open={Boolean(creditUser)}
        subjectName={creditUser ? name(creditUser) : ""}
        currentBalance={creditUser ? balanceOf(creditUser.uid) : undefined}
        onClose={() => setCreditUid(null)}
        onCredit={doCredit}
      />

      {/* Role / delete confirm */}
      <ConfirmDialog
        open={Boolean(confirm && confirmUser)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.label}
        confirmVariant={copy.danger ? "danger" : "primary"}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirm}
      />
    </>
  );
}
