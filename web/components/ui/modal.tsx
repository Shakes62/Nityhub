"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Footer actions, right-aligned. */
  footer?: ReactNode;
  /** Max width. Defaults to a comfortable form width. */
  size?: "sm" | "md" | "lg";
}

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
} as const;

/**
 * Accessible, self-contained modal dialog. Closes on Escape and overlay click,
 * locks body scroll while open, and traps initial focus on the panel. Used for
 * every admin confirm/edit action (credit wallet, role changes, delete, etc.).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-ink/60 backdrop-blur-[2px] animate-overlay-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          // Full-bleed bottom sheet on phones (no side gutters), centered card
          // from `sm` up. `flex-col` + capped height keeps the header/footer
          // pinned while only the body scrolls.
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-2xl outline-none",
          "rounded-t-card border border-border animate-sheet-in sm:max-h-[85dvh] sm:rounded-card",
          SIZES[size],
        )}
      >
        {/* Grab handle — reads as a bottom sheet on touch; hidden on desktop. */}
        <div className="flex justify-center pb-1 pt-2.5 sm:hidden" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-border-strong" />
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border px-5 pb-4 pt-2 sm:pt-4">
          <div className="min-w-0">
            <h2 className="text-[1.0625rem] font-semibold leading-[1.4] text-ink">{title}</h2>
            {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-muted hover:text-ink"
            aria-label="Close dialog"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
