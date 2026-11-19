"use client";

import { useEffect, useState } from "react";
import { getNetworkAvailability } from "@/services/api";
import type { NetworkAvailability } from "@/types/engagement";

const REFRESH_MS = 15_000;

/**
 * The admin switchboard and delivery estimates, refreshed every 15 seconds and
 * whenever the tab regains focus, so a network paused by an admin flips to
 * "paused" on open shop screens within seconds (blueprint 2.2).
 *
 * `availability` is null only until the first answer. A failed refresh keeps
 * the last known state; if the very first read fails, networks are shown as
 * open, because the server re-checks availability at checkout anyway.
 */
export function useNetworkAvailability() {
  const [availability, setAvailability] = useState<NetworkAvailability | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getNetworkAvailability()
        .then((value) => {
          if (active) setAvailability(value);
        })
        .catch(() => {
          if (active) setAvailability((current) => current ?? { enabled: true, networks: {}, estimates: {} });
        });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const isOpen = (network: string) =>
    Boolean(availability) && availability!.enabled && (availability!.networks[network] ?? "active") === "active";

  return { availability, loading: availability === null, isOpen };
}
