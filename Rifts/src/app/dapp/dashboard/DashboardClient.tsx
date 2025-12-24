"use client";

import { useEffect, useState } from "react";
import dynamicImport from "next/dynamic";

// Heavy dashboard kept dynamic to avoid server render issues with supabase client
const RealtimeDashboard = dynamicImport(
  () => import("@/components/dashboard/RealtimeDashboard"),
  { ssr: false }
);

export default function DashboardClient() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Return null on server to avoid hydration mismatch
  if (!mounted) return null;

  return <RealtimeDashboard />;
}
