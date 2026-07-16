"use client";

import { Eye, Pencil } from "lucide-react";
import { RowMenu, type RowMenuItem } from "@/components/admin/row-menu";

interface RowActionsProps {
  onView?: () => void;
  onEdit?: () => void;
  moreItems?: RowMenuItem[];
}

/** Icon-button trigger shared by the View/Edit affordances. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-ink [&>svg]:size-4"
    >
      {children}
    </button>
  );
}

/**
 * The standard admin row action cluster: 👁 View, ✏ Edit (where provided), and
 * a ⋮ More menu. Renders only the affordances that are wired.
 */
export function RowActions({ onView, onEdit, moreItems }: RowActionsProps) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {onView ? (
        <IconButton label="View" onClick={onView}>
          <Eye />
        </IconButton>
      ) : null}
      {onEdit ? (
        <IconButton label="Edit" onClick={onEdit}>
          <Pencil />
        </IconButton>
      ) : null}
      {moreItems && moreItems.length > 0 ? <RowMenu items={moreItems} /> : null}
    </div>
  );
}
