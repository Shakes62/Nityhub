"use client";

import { useEffect, useState } from "react";
import { BellOff, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useToast } from "@/contexts/toast-context";
import { firebaseApp } from "@/lib/firebase";
import { registerPushToken, unregisterPushToken } from "@/services/api";
import { errorMessage } from "@/lib/errors";

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || "";
const TOKEN_KEY = "nityhub:push-token";

type PushState = "unsupported" | "blocked" | "off" | "on";

function readToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Opt-in for Web Push (deposit credited, eStore sale, order repaired). Hidden
 * entirely unless a VAPID key is configured and the browser supports push.
 * The firebase/messaging SDK is loaded only when the user opts in.
 */
export function PushOptIn() {
  const toast = useToast();
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supported = Boolean(VAPID_KEY) && typeof window !== "undefined" &&
      "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(!supported ? "unsupported" : Notification.permission === "denied" ? "blocked" : readToken() ? "on" : "off");
  }, []);

  if (state === "unsupported") return null;

  const enable = async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const { getMessaging, getToken } = await import("firebase/messaging");
      const token = await getToken(getMessaging(firebaseApp), { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
      if (!token) throw new Error("No push token");
      await registerPushToken(token);
      try {
        window.localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* storage unavailable: still subscribed server-side */
      }
      setState("on");
      toast.success("Notifications are on for this device");
    } catch (error) {
      toast.error(errorMessage(error, "Notifications could not be enabled on this device."));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const token = readToken();
      if (token) await unregisterPushToken(token);
      const { getMessaging, deleteToken } = await import("firebase/messaging");
      await deleteToken(getMessaging(firebaseApp)).catch(() => false);
      try {
        window.localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      setState("off");
      toast.info("Notifications turned off for this device");
    } catch (error) {
      toast.error(errorMessage(error, "Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title="Notifications"
        description="Get an alert when your wallet is credited, an eStore sale lands, or a repaired order is delivered."
      />
      {state === "blocked" ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <BellOff className="size-4" aria-hidden /> Notifications are blocked in your browser settings for this site.
        </p>
      ) : state === "on" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-success">
            <BellRing className="size-4" aria-hidden /> On for this device
          </span>
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void disable()}>Turn off</Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" loading={busy} onClick={() => void enable()}>
            <BellRing className="size-4" aria-hidden /> Enable notifications
          </Button>
        </div>
      )}
    </Card>
  );
}
