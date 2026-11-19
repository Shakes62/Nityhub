"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { API_BASE } from "@/constants/config";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import type { LiveWallet, UserNotification } from "@/types/engagement";

/**
 * Real-time account stream (blueprint 4.4).
 *
 * Holds one Server-Sent Events connection per signed-in tab to
 * /api/me/events. EventSource cannot send an Authorization header, so the
 * stream is read with fetch() and parsed here. Reconnects with backoff, and
 * immediately when the tab becomes visible again.
 */

type NotificationListener = (notification: UserNotification) => void;

interface LiveEventsValue {
  /** Latest wallet figures pushed by the server; null until the first event. */
  wallet: LiveWallet | null;
  connected: boolean;
  /** Notifications received since the bell was last opened. */
  unread: number;
  clearUnread: () => void;
  /** Subscribe to incoming notifications; returns an unsubscribe function. */
  onNotification: (listener: NotificationListener) => () => void;
}

const LiveEventsContext = createContext<LiveEventsValue | null>(null);

interface SseMessage {
  event: string;
  data: string;
}

/** Split a buffer into complete SSE messages; returns the unparsed remainder. */
export function parseSseChunk(buffer: string): { messages: SseMessage[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const messages: SseMessage[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const index = line.indexOf(":");
      const field = index === -1 ? line : line.slice(0, index);
      const value = index === -1 ? "" : line.slice(index + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) messages.push({ event, data: data.join("\n") });
  }
  return { messages, rest };
}

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const toast = useToast();
  const [wallet, setWallet] = useState<LiveWallet | null>(null);
  const [connected, setConnected] = useState(false);
  const [unread, setUnread] = useState(0);
  const listeners = useRef(new Set<NotificationListener>());
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  });

  useEffect(() => {
    if (!user) {
      return;
    }
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const handle = (message: SseMessage) => {
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (message.event === "wallet_updated" && payload && typeof payload === "object") {
        const value = payload as Partial<LiveWallet>;
        setWallet({
          balance: Number(value.balance || 0),
          availableBalance: Number(value.availableBalance ?? value.balance ?? 0),
          heldBalance: Number(value.heldBalance || 0),
        });
      } else if (message.event === "notification" && payload && typeof payload === "object") {
        const note = payload as UserNotification;
        setUnread((count) => count + 1);
        toastRef.current.success(note.message ? `${note.title} — ${note.message}` : note.title);
        for (const listener of listeners.current) listener(note);
      }
    };

    const schedule = () => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5));
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (stopped) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/me/events`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
            "X-Requested-With": "NityHubWeb",
          },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        setConnected(true);
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          parsed.messages.forEach(handle);
        }
        setConnected(false);
        // The server recycles streams; reconnect promptly with a fresh token.
        if (!stopped) retryTimer = setTimeout(() => void connect(), 1000);
      } catch {
        setConnected(false);
        schedule();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !stopped) {
        if (retryTimer) clearTimeout(retryTimer);
        attempt = 0;
        void connect();
      }
    };

    void connect();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      setConnected(false);
      setWallet(null);
    };
  }, [user]);

  const clearUnread = useCallback(() => setUnread(0), []);
  const onNotification = useCallback((listener: NotificationListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<LiveEventsValue>(
    () => ({ wallet, connected, unread, clearUnread, onNotification }),
    [wallet, connected, unread, clearUnread, onNotification],
  );

  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

/** Live account events. Safe to call outside the provider (returns inert values). */
export function useLiveEvents(): LiveEventsValue {
  return (
    useContext(LiveEventsContext) ?? {
      wallet: null,
      connected: false,
      unread: 0,
      clearUnread: () => {},
      onNotification: () => () => {},
    }
  );
}
