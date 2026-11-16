"use client";
import { useState } from "react";

/** Copies the whole knowledge file to the clipboard. */
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2500);
        } catch {
          window.alert("Copy didn't work in this browser. Use Download instead.");
        }
      }}
    >
      {done ? "Copied ✓" : "Copy the whole file"}
    </button>
  );
}
