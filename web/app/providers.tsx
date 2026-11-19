"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/contexts/auth-context";
import { ToastProvider } from "@/contexts/toast-context";
import { LiveEventsProvider } from "@/contexts/live-events-context";
import { RegisterServiceWorker } from "@/components/pwa/register-service-worker";

/** Client-side context providers shared across the whole app. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <RegisterServiceWorker />
      <ToastProvider>
        <LiveEventsProvider>{children}</LiveEventsProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
