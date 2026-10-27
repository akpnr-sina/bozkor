"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toggleProfileActive } from "./actions";

/** A profile's switch in the list: saved at once; on a failure it goes back and says why. */
export function ProfileActiveSwitch({ profileId, name, active }: { profileId: string; name: string; active: boolean }) {
  // Shows the new position while it is saved; the refreshed list then brings the stored one.
  const [checked, setChecked] = useOptimistic(active);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-1">
      <Switch
        checked={checked}
        disabled={pending}
        aria-label={`${name} profili aktif`}
        onCheckedChange={(next) =>
          startTransition(async () => {
            setChecked(next);
            setMessage(null);
            const result = await toggleProfileActive(profileId, next);
            setMessage({ ok: result.status === "saved", text: result.message });
          })
        }
      />
      {message && (
        <span role="status" className={cn("max-w-56 text-xs whitespace-normal", message.ok ? "text-ink-500" : "text-err")}>
          {message.text}
        </span>
      )}
    </div>
  );
}
