"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_MEANINGS, DECISION_SHORT, type ReviewDecision } from "@/lib/format";
import { cn } from "@/lib/utils";
import { saveDecision, type DecisionState } from "./actions";

const initialState: DecisionState = { status: "idle" };

// The chosen row takes its decision's colour (DECISION_TONE). Tailwind only
// sees classes written out in full, so each decision spells its own.
const CHOICES: readonly { decision: ReviewDecision; row: string; box: string; mark: string; code: string }[] = [
  { decision: "GO", row: "has-checked:bg-ok-soft", box: "group-has-checked:border-ok", mark: "group-has-checked:bg-ok", code: "group-has-checked:text-ok-ink" },
  { decision: "REVIEW", row: "has-checked:bg-warn-soft", box: "group-has-checked:border-warn", mark: "group-has-checked:bg-warn", code: "group-has-checked:text-warn-ink" },
  { decision: "NO_GO", row: "has-checked:bg-err-soft", box: "group-has-checked:border-err", mark: "group-has-checked:bg-err", code: "group-has-checked:text-err-ink" },
  { decision: "WATCH", row: "has-checked:bg-info-soft", box: "group-has-checked:border-info", mark: "group-has-checked:bg-info", code: "group-has-checked:text-info-ink" },
];

/**
 * The team's decision with a note. The choices are radio buttons drawn as one
 * list, the Turkish meaning first and the code at the end; the chosen row fills
 * its square and takes its decision's colour. Saving is an outline button:
 * opening the notice is the page's one primary action.
 */
export function DecisionForm({ tenderId, current }: { tenderId: string; current: ReviewDecision | null }) {
  const [state, formAction, pending] = useActionState(saveDecision, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="tenderId" value={tenderId} />
      <fieldset>
        <legend className="sr-only">Karar</legend>
        <div className="flex flex-col divide-y divide-line border border-line-strong">
          {CHOICES.map(({ decision, row, box, mark, code }) => (
            <label
              key={decision}
              className={cn(
                "group flex h-10 cursor-pointer items-center gap-3 px-3 text-sm text-ink-900 transition-colors not-has-checked:hover:bg-surface-hover has-checked:font-medium has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ink-900",
                row,
              )}
            >
              <input type="radio" name="decision" value={decision} defaultChecked={current === decision} className="sr-only" />
              <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center border border-line-strong bg-surface", box)}>
                <span className={cn("size-1.5", mark)} />
              </span>
              <span className="min-w-0 flex-1 truncate">{DECISION_MEANINGS[decision]}</span>
              <span className={cn("font-mono text-[11px] font-normal tracking-[0.06em] text-ink-500", code)}>{DECISION_SHORT[decision]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Not</Label>
        <Textarea id="note" name="note" rows={3} maxLength={2000} placeholder="Kararın gerekçesi (isteğe bağlı)" />
      </div>
      {state.status !== "idle" && (
        <p role="status" className={state.status === "error" ? "text-[13px] text-err" : "text-[13px] text-ink-600"}>
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={pending}>
          {pending ? "Kaydediliyor..." : "Kararı kaydet"}
        </Button>
        {current && (
          <Button type="submit" name="intent" value="clear" variant="ghost" disabled={pending}>
            Kararı geri al
          </Button>
        )}
      </div>
    </form>
  );
}
