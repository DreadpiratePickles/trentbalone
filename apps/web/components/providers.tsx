"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { RuntimeHealthProvider } from "@/components/runtime-health";
import { StatusToastProvider } from "@/components/status-toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <RuntimeHealthProvider>
        <StatusToastProvider>{children}</StatusToastProvider>
      </RuntimeHealthProvider>
    </SessionProvider>
  );
}
