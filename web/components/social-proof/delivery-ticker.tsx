"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { getDeliveryProofs } from "@/services/api";
import type { DeliveryProof } from "@/types/engagement";

export function DeliveryTicker() {
  const [proofs, setProofs] = useState<DeliveryProof[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    let active = true;
    getDeliveryProofs()
      .then((items) => {
        if (active && items.length > 0) {
          setProofs(items);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (proofs.length <= 1 || isPaused) return;

    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % proofs.length);
        setFade(true);
      }, 250);
    }, 4500);

    return () => clearInterval(interval);
  }, [proofs.length, isPaused]);

  if (proofs.length === 0) {
    return null;
  }

  const current = proofs[currentIndex];

  const handleNext = () => {
    if (proofs.length <= 1) return;
    setFade(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % proofs.length);
      setFade(true);
    }, 150);
  };

  return (
    <div
      role="region"
      aria-label="Live delivery proof"
      aria-live="polite"
      className="inline-flex w-full items-center justify-between gap-3 overflow-hidden rounded-full border border-border/80 bg-surface/90 px-3.5 py-1.5 shadow-sm backdrop-blur transition-colors hover:border-brand/40"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onClick={handleNext}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-500 dark:text-amber-400">
          <Zap className="size-3 fill-current" />
        </span>
        <div
          className={`truncate text-xs text-ink transition-opacity duration-200 ${
            fade ? "opacity-100" : "opacity-0"
          }`}
        >
          <span className="font-semibold text-ink">
            {current.networkLabel}
          </span>{" "}
          <span className="text-muted">last delivery took</span>{" "}
          <span className="font-medium tabular text-brand">
            {current.durationText}
          </span>{" "}
          <span className="text-muted">({current.completedAgoText})</span>
        </div>
      </div>

      {proofs.length > 1 && (
        <span className="shrink-0 text-[10px] font-medium text-muted">
          {currentIndex + 1}/{proofs.length}
        </span>
      )}
    </div>
  );
}

