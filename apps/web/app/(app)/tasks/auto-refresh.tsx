"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page every few seconds while it's visible, so bot replies appear. */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
