import type { ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Friendly placeholder shown when a list has no data. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg bg-surface-soft px-6 py-10 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description ? (
          <p className="mt-1 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  className?: string;
}

/** Inline error surface with an optional retry action. */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-danger/20",
        "bg-danger-soft px-6 py-8 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        <AlertCircle className="size-5" />
      </div>
      <p className="text-sm font-medium text-ink">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
