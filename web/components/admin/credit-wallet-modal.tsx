"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, useFieldId } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { formatMoney } from "@/lib/format";

interface CreditWalletModalProps {
  open: boolean;
  /** Name shown in the dialog copy (never the UID). */
  subjectName: string;
  currentBalance?: number;
  onClose: () => void;
  /** Resolve on success; the modal clears + closes. Reject to keep it open. */
  onCredit: (amount: number) => Promise<void>;
}

/** Manually credit a user's wallet by a GHS amount. */
export function CreditWalletModal({
  open,
  subjectName,
  currentBalance,
  onClose,
  onCredit,
}: CreditWalletModalProps) {
  const amountId = useFieldId("credit-amount");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onCredit(value);
      setAmount("");
      onClose();
    } catch {
      /* parent surfaces the error via toast; keep the modal open */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Credit wallet"
      description={subjectName}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy} disabled={!valid}>
            Credit {valid ? formatMoney(value) : ""}
          </Button>
        </>
      }
    >
      <Field
        label="Amount (GHS)"
        htmlFor={amountId}
        hint={currentBalance != null ? `Current balance: ${formatMoney(currentBalance)}` : undefined}
      >
        <Input
          id={amountId}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          autoFocus
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
