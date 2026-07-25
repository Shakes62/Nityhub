"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, useFieldId } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { useToast } from "@/contexts/toast-context";
import { ApiError } from "@/types/api";
import { ORDER_STATUSES } from "@/types/admin";
import type { AdminOrder } from "@/types/admin";
import { updateOrderStatus } from "@/services/admin";

interface OrderStatusModalProps {
  /** The order being edited; `null` closes the modal. */
  order: AdminOrder | null;
  onClose: () => void;
  /** Called after a successful change so the caller can reload data. */
  onDone: () => void | Promise<void>;
}

/**
 * Manually set one order's status (PATCH /api/admin/orders/:reference/status).
 *
 * Used for the cases the providers get wrong — an order the provider reported
 * delivered that never arrived, or one stuck processing after a lost callback.
 * The backend records an audit entry and pins the order so the reconciler will
 * not immediately overwrite the correction.
 */
export function OrderStatusModal({ order, onClose, onDone }: OrderStatusModalProps) {
  const toast = useToast();
  const statusId = useFieldId("order-status");
  const noteId = useFieldId("order-status-note");

  const [status, setStatus] = useState<string>("delivered");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Re-seed the form whenever a different order is opened. Adjusting state
  // during render (rather than in an effect) is React's recommended pattern for
  // deriving state from props and avoids a cascading re-render.
  const orderKey = order?.reference ?? null;
  if (orderKey !== seededFor) {
    setSeededFor(orderKey);
    setStatus(order?.status || "delivered");
    setNote("");
  }

  const currentStatus = order?.status || "";
  const unchanged = status === currentStatus;

  const submit = async () => {
    if (!order?.reference) return;
    setBusy(true);
    try {
      const result = await updateOrderStatus(order.reference, status, note.trim() || undefined);
      toast.success(
        result.changed
          ? `Status changed to ${statusLabel(result.status)}`
          : `Order is already ${statusLabel(result.status)}`,
      );
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(order)}
      onClose={busy ? () => {} : onClose}
      title="Change order status"
      description={order?.reference}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy} disabled={unchanged}>
            Save status
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-muted">
          <span>Current:</span>
          <Badge tone={statusTone(currentStatus)} dot>
            {statusLabel(currentStatus)}
          </Badge>
        </div>

        <Field
          label="New status"
          htmlFor={statusId}
          error={unchanged ? "Pick a status different from the current one" : null}
        >
          <Select id={statusId} value={status} onChange={(e) => setStatus(e.target.value)}>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Note (optional)" htmlFor={noteId}>
          <Input
            id={noteId}
            value={note}
            maxLength={300}
            placeholder="Why this was changed — shown on the order"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
