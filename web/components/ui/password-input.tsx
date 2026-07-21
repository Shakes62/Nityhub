"use client";

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/field";

/**
 * Password field with a show/hide toggle.
 *
 * The toggle is a real button so it is keyboard reachable, and it carries
 * aria-pressed plus an aria-label that reflects the current state. It is
 * excluded from the tab order's happy path only in the sense that it sits
 * after the input, which is the expected reading order.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className, ...props }, ref) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-11", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        title={visible ? "Hide password" : "Show password"}
        className={cn(
          "absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center",
          "rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-ink",
          "focus:outline-none focus:ring-2 focus:ring-brand/40",
        )}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});
