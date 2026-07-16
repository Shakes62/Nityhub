"use client";

import { useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  onCancel: () => void;
  /** May be async; the dialog shows a spinner until it settles. */
  onConfirm: () => void | Promise<void>;
}

/** A confirm/deny dialog wrapping {@link Modal}, awaiting an async confirm. */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "primary",
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} size="sm" onClick={handleConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? <p className="text-sm text-ink-soft">This action cannot be undone.</p>}
    </Modal>
  );
}
