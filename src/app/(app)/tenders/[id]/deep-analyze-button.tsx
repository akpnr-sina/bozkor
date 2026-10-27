"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { requestDeep } from "./deep-actions";

/**
 * Asks for the tender's deep analysis; the card then shows it queued and the
 * page refreshes itself. An outline button: opening the notice is the page's
 * one primary action.
 */
export function DeepAnalyzeButton({ tenderId, label }: { tenderId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function ask() {
    startTransition(async () => {
      const result = await requestDeep(tenderId);
      if (!result.ok) setMessage({ text: result.error, error: true });
      else setMessage(result.queued ? null : { text: "Bu ihale için açık bir analiz isteği zaten var.", error: false });
    });
  }

  return (
    <>
      <Button type="button" variant="outline" disabled={pending} onClick={ask}>
        {pending ? "İsteniyor..." : label}
      </Button>
      {message && (
        <span role={message.error ? "alert" : "status"} className={message.error ? "text-xs text-err" : "text-xs text-ink-500"}>
          {message.text}
        </span>
      )}
    </>
  );
}
