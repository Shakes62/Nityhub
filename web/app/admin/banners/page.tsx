"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { PageHero } from "@/components/layout/page-hero";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Field, Input } from "@/components/ui/field";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import {
  getAdminBanners,
  saveAdminBanner,
  deleteAdminBanner,
} from "@/services/admin";
import type { BannerVariant, StoreBanner } from "@/types/engagement";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";

/** A stored timestamp as the value of a datetime-local input (local time). */
function toLocalInput(value?: number | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function AdminBannersPage() {
  const toast = useToast();
  const { data: rawBanners, loading, error, reload, setData: setBanners } = useAsyncData(getAdminBanners, []);
  const banners = rawBanners ?? [];

  // Edit / Create modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [variant, setVariant] = useState<BannerVariant>("promotion");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [priority, setPriority] = useState("5");
  const [enabled, setEnabled] = useState(true);
  // Captured once per visit: enough to label banners as scheduled or ended.
  const [now] = useState(() => Date.now());
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const openCreateModal = () => {
    setEditingId(null);
    setVariant("promotion");
    setTitle("");
    setMessage("");
    setActionLabel("");
    setActionUrl("");
    setPriority("5");
    setEnabled(true);
    setStartsAt("");
    setEndsAt("");
    setModalOpen(true);
  };

  const openEditModal = (banner: StoreBanner) => {
    setEditingId(banner.id);
    setVariant(banner.variant);
    setTitle(banner.title);
    setMessage(banner.message);
    setActionLabel(banner.actionLabel || "");
    setActionUrl(banner.actionUrl || "");
    setPriority(String(banner.priority ?? 0));
    setEnabled(banner.enabled);
    setStartsAt(toLocalInput(banner.startsAt));
    setEndsAt(toLocalInput(banner.endsAt));
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!message.trim()) {
      toast.error("Message is required");
      return;
    }
    if (actionUrl.trim() && !actionLabel.trim()) {
      toast.error("Add button text for the banner link");
      return;
    }
    const start = startsAt ? new Date(startsAt).getTime() : null;
    const end = endsAt ? new Date(endsAt).getTime() : null;
    if (start && end && end <= start) {
      toast.error("The end time must be after the start time");
      return;
    }

    setSaving(true);
    try {
      await saveAdminBanner({
        id: editingId || undefined,
        variant,
        title: title.trim(),
        message: message.trim(),
        actionLabel: actionLabel.trim() || null,
        actionUrl: actionUrl.trim() || null,
        priority: Number(priority) || 0,
        enabled,
        startsAt: start,
        endsAt: end,
      });
      toast.success(editingId ? "Banner updated successfully" : "Banner created successfully");
      setModalOpen(false);
      reload();
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save banner"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (banner: StoreBanner) => {
    try {
      await saveAdminBanner({
        ...banner,
        enabled: !banner.enabled,
      });
      setBanners(
        banners.map((b) => (b.id === banner.id ? { ...b, enabled: !b.enabled } : b)),
      );
      toast.success(`Banner ${!banner.enabled ? "activated" : "deactivated"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update banner status");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this banner?")) return;

    try {
      await deleteAdminBanner(id);
      setBanners(banners.filter((b) => b.id !== id));
      toast.success("Banner deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete banner");
    }
  };

  return (
    <>
      <PageHero
        title="Banners"
        description="Dynamic promotional, operational, and announcement banners shown across the storefront."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreateModal}>
              <Plus className="size-4" />
              Add Banner
            </Button>
          </div>
        }
      />

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : banners.length === 0 && !loading ? (
        <Card>
          <EmptyState
            title="No banners found"
            description="Create your first promotional or operational banner to display across the storefront."
            action={
              <Button variant="primary" size="sm" onClick={openCreateModal}>
                <Plus className="size-4" />
                Add Banner
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          <CardHeader
            title="Active & Scheduled Banners"
            description="Banners are displayed by priority order across customer purchase screens."
          />

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Variant</Th>
                  <Th>Title & Content</Th>
                  <Th>Call to Action</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {banners.map((b) => (
                  <tr key={b.id}>
                    <Td>
                      {b.variant === "promotion" && (
                        <Badge tone="info">
                          <Sparkles className="mr-1 size-3" />
                          Promotion
                        </Badge>
                      )}
                      {b.variant === "operational" && (
                        <Badge tone="warning">
                          <AlertTriangle className="mr-1 size-3" />
                          Operational
                        </Badge>
                      )}
                      {b.variant === "announcement" && (
                        <Badge tone="neutral">
                          <Megaphone className="mr-1 size-3" />
                          Announcement
                        </Badge>
                      )}
                    </Td>
                    <Td className="max-w-md">
                      <p className="font-semibold text-ink text-sm">{b.title}</p>
                      <p className="text-xs text-muted line-clamp-2 mt-0.5">{b.message}</p>
                    </Td>
                    <Td>
                      {b.actionLabel ? (
                        <div className="flex items-center gap-1 text-xs text-brand font-medium">
                          <span>{b.actionLabel}</span>
                          <span className="text-muted">({b.actionUrl || "—"})</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">None</span>
                      )}
                    </Td>
                    <Td className="tabular font-medium text-xs text-ink">
                      {b.priority ?? 0}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => handleToggle(b)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
                          b.enabled
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                            : "bg-surface-muted text-muted hover:bg-surface-soft",
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            b.enabled ? "bg-emerald-500" : "bg-muted",
                          )}
                        />
                        {!b.enabled
                          ? "Disabled"
                          : b.endsAt && b.endsAt <= now
                            ? "Ended"
                            : b.startsAt && b.startsAt > now
                              ? "Scheduled"
                              : "Active"}
                      </button>
                    </Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditModal(b)}
                          aria-label="Edit banner"
                        >
                          <Pencil className="size-3.5 text-muted hover:text-ink" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(b.id)}
                          aria-label="Delete banner"
                        >
                          <Trash2 className="size-3.5 text-danger" />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? "Edit Banner" : "Create New Banner"}
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
              {editingId ? "Save Changes" : "Create Banner"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Banner Variant" htmlFor="banner-variant">
            <select
              id="banner-variant"
              value={variant}
              onChange={(e) => setVariant(e.target.value as BannerVariant)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-brand"
            >
              <option value="promotion">Promotion (Blue/Purple Gradient)</option>
              <option value="operational">Operational Notice (Amber Warning)</option>
              <option value="announcement">Announcement (Informational)</option>
            </select>
          </Field>

          <Field label="Banner Title" htmlFor="banner-title">
            <Input
              id="banner-title"
              placeholder="e.g. Weekend Data Promo: 10GB now GHS 45"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </Field>

          <Field label="Message Content" htmlFor="banner-message">
            <textarea
              id="banner-message"
              rows={3}
              placeholder="Detailed explanation of the promo, operational update, or carrier maintenance..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={300}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-brand resize-none"
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Button Label (Optional)" htmlFor="banner-action-label">
              <Input
                id="banner-action-label"
                placeholder="e.g. View Bundles"
                value={actionLabel}
                onChange={(e) => setActionLabel(e.target.value)}
                maxLength={40}
              />
            </Field>

            <Field label="Button URL (Optional)" htmlFor="banner-action-url">
              <Input
                id="banner-action-url"
                placeholder="/buy, /repair or https://…"
                value={actionUrl}
                onChange={(e) => setActionUrl(e.target.value)}
                maxLength={200}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 items-center">
            <Field label="Display Priority" htmlFor="banner-priority">
              <Input
                id="banner-priority"
                type="number"
                placeholder="0"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2 pt-5">
              <input
                id="banner-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4 rounded border-border text-brand focus:ring-brand"
              />
              <label htmlFor="banner-enabled" className="text-sm font-medium text-ink cursor-pointer">
                Enabled (Display immediately)
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Show from (optional)" htmlFor="banner-starts" hint="Leave blank to show right away.">
              <Input id="banner-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="Hide after (optional)" htmlFor="banner-ends" hint="Useful for weekend promos.">
              <Input id="banner-ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>

          {/* Live Preview Card */}
          <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Live Preview
            </p>
            <div
              className={cn(
                "rounded-lg border p-3.5",
                variant === "promotion" &&
                  "border-indigo-500/30 bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10 text-ink",
                variant === "operational" &&
                  "border-amber-500/30 bg-amber-500/10 text-ink",
                variant === "announcement" &&
                  "border-border bg-surface-soft text-ink",
              )}
            >
              <div className="flex items-start gap-2.5">
                <div
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md mt-0.5",
                    variant === "promotion" && "bg-indigo-500/20 text-indigo-600",
                    variant === "operational" && "bg-amber-500/20 text-amber-600",
                    variant === "announcement" && "bg-brand-soft text-brand-strong",
                  )}
                >
                  {variant === "promotion" && <Sparkles className="size-3.5" />}
                  {variant === "operational" && <AlertTriangle className="size-3.5" />}
                  {variant === "announcement" && <Megaphone className="size-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-bold text-ink">
                    {title.trim() || "Preview Banner Title"}
                  </h4>
                  <p className="mt-0.5 text-[11px] text-muted line-clamp-2">
                    {message.trim() || "Your banner message will appear here for customers..."}
                  </p>
                </div>
                {actionLabel.trim() && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold shrink-0 text-white",
                      variant === "promotion" && "bg-indigo-600",
                      variant === "operational" && "bg-amber-600",
                      variant === "announcement" && "bg-brand",
                    )}
                  >
                    {actionLabel}
                    <ArrowRight className="size-2.5" />
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

