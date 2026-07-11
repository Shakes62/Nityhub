"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, formatMoney, normalizePhone } from "@/lib/format";
import {
  getAfaFee,
  getAfaRegistrations,
  getWalletBalance,
  registerAfa,
} from "@/services/api";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";

async function loadAfa() {
  const [balance, registrations] = await Promise.all([
    getWalletBalance(),
    getAfaRegistrations(30),
  ]);
  return { balance, registrations };
}

export default function AfaPage() {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { data, loading, reload } = useAsyncData(loadAfa, []);

  // Load the AFA fee (defaults to 6 on failure, matching the original).
  useEffect(() => {
    let active = true;
    getAfaFee()
      .then((value) => active && setFee(value || 6))
      .catch(() => active && setFee(6));
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      fullname: String(form.get("fullname") || "").trim(),
      phone: normalizePhone(String(form.get("phone") || "")),
      dob: String(form.get("dob") || ""),
      ghanaCard: String(form.get("ghanaCard") || "").trim(),
      location: String(form.get("location") || "").trim(),
    };

    if (
      !payload.fullname ||
      payload.phone.length !== 10 ||
      !payload.dob ||
      !payload.ghanaCard ||
      !payload.location
    ) {
      toast.error("Fill all required fields with valid values.");
      return;
    }

    setSubmitting(true);
    try {
      await registerAfa(payload);
      toast.success("AFA registration completed.");
      formRef.current?.reset();
      await reload();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to complete registration.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const registrations = data?.registrations ?? [];

  return (
    <>
      <PageHero title="AFA" description="Register a new AFA profile.">
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">Fee · {fee === null ? "…" : formatMoney(fee)}</Badge>
          <Badge tone="success">
            Wallet · {loading ? "…" : formatMoney(data?.balance)}
          </Badge>
        </div>
      </PageHero>

      <Card className="flex flex-col gap-4">
        <CardHeader title="Register" />
        <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full Name" htmlFor="afa-fullname">
              <Input id="afa-fullname" name="fullname" type="text" required />
            </Field>
            <Field label="Phone" htmlFor="afa-phone">
              <Input
                id="afa-phone"
                name="phone"
                type="tel"
                inputMode="numeric"
                placeholder="0XXXXXXXXX"
                required
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date of Birth" htmlFor="afa-dob">
              <Input id="afa-dob" name="dob" type="date" required />
            </Field>
            <Field label="Ghana Card" htmlFor="afa-card">
              <Input id="afa-card" name="ghanaCard" type="text" required />
            </Field>
          </div>
          <Field label="Location" htmlFor="afa-location">
            <Input id="afa-location" name="location" type="text" required />
          </Field>
          <div>
            <Button type="submit" loading={submitting}>
              Submit Registration
            </Button>
          </div>
        </form>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title="Records" />
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : registrations.length === 0 ? (
          <EmptyState
            title="No registrations yet"
            description="Completed AFA registrations will appear here."
          />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Location</Th>
                  <Th>Fee</Th>
                  <Th>Date</Th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((row, index) => (
                  <tr key={index} className="hover:bg-surface-soft">
                    <Td className="font-medium text-ink">{row.fullname || "-"}</Td>
                    <Td>{row.phone || "-"}</Td>
                    <Td>{row.location || "-"}</Td>
                    <Td>{formatMoney(row.fee || 0)}</Td>
                    <Td>{formatDate(row.timestamp)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
