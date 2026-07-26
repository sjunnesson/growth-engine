"use client";

// Polls the server component while a background run (drafting, dry-run) is
// in flight — the Setup page is otherwise fully server-rendered.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AutoRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
