import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

interface PageHeroProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Standard page header card with title, optional description and actions. */
export function PageHero({ title, description, actions, children }: PageHeroProps) {
  return (
    <Card className="bg-gradient-to-br from-surface to-brand-soft/40">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-sm text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}
