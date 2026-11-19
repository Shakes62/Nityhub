"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/** Defence in depth: the API already rejects anything but an in-app path or https URL. */
function isSafeBannerUrl(url: string): boolean {
  return /^\/(?!\/)/.test(url) || url.startsWith("https://");
}
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  Sparkles,
} from "lucide-react";
import { getBanners } from "@/services/api";
import type { StoreBanner } from "@/types/engagement";
import { cn } from "@/lib/cn";

export function BannerCarousel() {
  const [banners, setBanners] = useState<StoreBanner[]>([]);
  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    let active = true;
    getBanners()
      .then((items) => {
        if (active && items.length > 0) {
          setBanners(items);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (banners.length <= 1 || isPaused) return;

    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % banners.length);
        setFade(true);
      }, 250);
    }, 6000);

    return () => clearInterval(interval);
  }, [banners.length, isPaused]);

  if (banners.length === 0) {
    return null;
  }

  const current = banners[index];

  const goNext = () => {
    setFade(false);
    setTimeout(() => {
      setIndex((prev) => (prev + 1) % banners.length);
      setFade(true);
    }, 150);
  };

  const goPrev = () => {
    setFade(false);
    setTimeout(() => {
      setIndex((prev) => (prev - 1 + banners.length) % banners.length);
      setFade(true);
    }, 150);
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card border p-4 shadow-sm transition-all duration-300",
        current.variant === "promotion" &&
          "border-indigo-500/30 bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10 text-ink",
        current.variant === "operational" &&
          "border-amber-500/30 bg-amber-500/10 text-ink",
        current.variant === "announcement" &&
          "border-border bg-surface-soft text-ink",
      )}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      role="region"
      aria-label="Announcements & Promos"
    >
      <div
        className={cn(
          "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between transition-opacity duration-200",
          fade ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
              current.variant === "promotion" &&
                "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400",
              current.variant === "operational" &&
                "bg-amber-500/20 text-amber-600 dark:text-amber-400",
              current.variant === "announcement" &&
                "bg-brand-soft text-brand-strong",
            )}
          >
            {current.variant === "promotion" && <Sparkles className="size-4" />}
            {current.variant === "operational" && <AlertTriangle className="size-4" />}
            {current.variant === "announcement" && <Megaphone className="size-4" />}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-wider",
                  current.variant === "promotion" && "text-indigo-600 dark:text-indigo-400",
                  current.variant === "operational" && "text-amber-600 dark:text-amber-400",
                  current.variant === "announcement" && "text-brand",
                )}
              >
                {current.variant === "promotion" && "Special Promotion"}
                {current.variant === "operational" && "Operational Notice"}
                {current.variant === "announcement" && "Announcement"}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-ink">{current.title}</h3>
            <p className="mt-0.5 text-xs text-muted leading-relaxed max-w-2xl">
              {current.message}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          {current.actionLabel && current.actionUrl && isSafeBannerUrl(current.actionUrl) && (
            <Link
              href={current.actionUrl}
              {...(current.actionUrl.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold shadow-xs transition-colors",
                current.variant === "promotion" &&
                  "bg-indigo-600 text-white hover:bg-indigo-700",
                current.variant === "operational" &&
                  "bg-amber-600 text-white hover:bg-amber-700",
                current.variant === "announcement" &&
                  "bg-brand text-white hover:bg-brand-strong",
              )}
            >
              <span>{current.actionLabel}</span>
              <ArrowRight className="size-3" />
            </Link>
          )}

          {banners.length > 1 && (
            <div className="flex items-center gap-1 ml-2">
              <button
                type="button"
                onClick={goPrev}
                aria-label="Previous banner"
                className="flex size-7 items-center justify-center rounded-full border border-border/80 bg-surface text-muted transition-colors hover:bg-surface-soft hover:text-ink"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={goNext}
                aria-label="Next banner"
                className="flex size-7 items-center justify-center rounded-full border border-border/80 bg-surface text-muted transition-colors hover:bg-surface-soft hover:text-ink"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {banners.length > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1">
          {banners.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              onClick={() => {
                setFade(false);
                setTimeout(() => {
                  setIndex(i);
                  setFade(true);
                }, 150);
              }}
              aria-label={`Go to banner ${i + 1}`}
              className={cn(
                "h-1 rounded-full transition-all duration-300",
                i === index ? "w-6 bg-brand" : "w-1.5 bg-border hover:bg-muted",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

