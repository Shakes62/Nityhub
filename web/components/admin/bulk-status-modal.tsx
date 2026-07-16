"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, useFieldId } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { statusLabel } from "@/components/ui/badge";
import { useToast } from "@/contexts/toast-context";
import { ApiError } from "@/types/api";
import { ORDER_STATUSES } from "@/types/admin";
import type { BulkStatusResult } from "@/types/admin";
import { bulkUpdateOrderStatus } from "@/services/admin";

interface BulkStatusModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful update so the caller can reload data. */
  onDone: () => void | Promise<void>;
}

/**
 * Re-status every order in a UTC date range from one status to another
 * (PATCH /api/admin/orders/bulk-status). Shows the matched/updated counts on
 * success. The backend requires a valid range and differing statuses.
 */
export function BulkStatusModal({ open, onClose, onDone }: BulkStatusModalProps) {
  const toast = useToast();
  const startId = useFieldId("bulk-start");
  const endId = useFieldId("bulk-end");
  const currentId = useFieldId("bulk-current");
  const nextId = useFieldId("bulk-next");

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [currentStatus, setCurrentStatus] = useState("pending");
  const [nextStatus, setNextStatus] = useState("delivered");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkStatusResult | null>(null);

  const sameStatus = currentStatus === nextStatus;
  const valid = Boolean(startDate) && Boolean(endDate) && !sameStatus;

  const reset = () => {
    setResult(null);
  };

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await bulkUpdateOrderStatus({ startDate, endDate, currentStatus, nextStatus });
      setResult(res);
      toast.success(`Updated ${res.updated} of ${res.matched} matched orders`);
      await onDone();
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Bulk update order status"
      description="Re-status orders within a UTC date range."
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy} disabled={!valid}>
            Apply update
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start date" htmlFor={startId}>
            <Input id={startId} type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); reset(); }} />
          </Field>
          <Field label="End date" htmlFor={endId}>
            <Input id={endId} type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); reset(); }} />
          </Field>
          <Field label="From status" htmlFor={currentId}>
            <Select id={currentId} value={currentStatus} onChange={(e) => { setCurrentStatus(e.target.value); reset(); }}>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </Select>
          </Field>
          <Field label="To status" htmlFor={nextId} error={sameStatus ? "Must differ from the source status" : null}>
            <Select id={nextId} value={nextStatus} onChange={(e) => { setNextStatus(e.target.value); reset(); }}>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </Select>
          </Field>
        </div>

        {result ? (
          <div className="rounded-lg border border-border bg-surface-soft p-4 text-sm">
            <p className="font-medium text-ink">
              {result.updated} updated · {result.matched} matched
            </p>
            <p className="mt-1 text-muted">
              {statusLabel(result.currentStatus)} → {statusLabel(result.nextStatus)}
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
