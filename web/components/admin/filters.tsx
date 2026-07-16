"use client";

import { Search } from "lucide-react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Input, Select } from "@/components/ui/field";

/** Responsive container for a row of filter controls above a table. */
export function FilterToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center", className)}>
      {children}
    </div>
  );
}

/** Compact search box with a leading icon. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 pl-9"
      />
    </div>
  );
}

interface FilterSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: { value: string; label: string }[];
}

/** Compact labeled <select> for a single filter dimension. */
export function FilterSelect({ label, options, className, ...props }: FilterSelectProps) {
  return (
    <Select aria-label={label} className={cn("h-10 w-full sm:w-auto", className)} {...props}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
