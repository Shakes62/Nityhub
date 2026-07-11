"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { Stat } from "@/components/ui/stat";
import { ErrorState } from "@/components/ui/states";
import { formatMoney } from "@/lib/format";
import { getDashboardData } from "@/services/api";
import { useAsyncData } from "@/hooks/use-async-data";

export default function DashboardPage() {
  const { data, loading, error, reload } = useAsyncData(getDashboardData, []);

  return (
    <>
      <PageHero
        title="Dashboard"
        description="Your account at a glance."
        actions={
          <>
            <Link href="/buy" className={buttonVariants("primary", "sm")}>
              Buy Data
            </Link>
            <Link href="/wallet" className={buttonVariants("secondary", "sm")}>
              Fund Wallet
            </Link>
          </>
        }
      />

      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Today"
          description="Fresh server totals for today's activity."
        />

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Wallet Balance"
                value={formatMoney(data?.balance)}
                meta="Ready for purchases"
                loading={loading}
              />
              <Stat
                label="Today's Orders"
                value={String(Number(data?.todayOrders || 0))}
                meta="Placed today"
                loading={loading}
              />
              <Stat
                label="Today's Sales"
                value={formatMoney(data?.todaySales)}
                meta="Confirmed value today"
                loading={loading}
              />
            </div>

            <div className="rounded-lg border border-border bg-surface-soft p-4">
              <div className="flex items-center justify-between py-1 text-sm">
                <span className="text-muted">All-time orders</span>
                <span className="font-semibold text-ink">
                  {String(Number(data?.ordersCount || 0))}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-border py-1 pt-2 text-sm">
                <span className="text-muted">All-time sales</span>
                <span className="font-semibold text-ink">
                  {formatMoney(data?.totalSales)}
                </span>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
