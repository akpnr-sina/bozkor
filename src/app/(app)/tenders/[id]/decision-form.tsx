"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_LABELS, type ReviewDecision } from "@/lib/format";
import { saveDecision, type DecisionState } from "./actions";

const initialState: DecisionState = { status: "idle" };
const DECISIONS = Object.keys(DECISION_LABELS) as ReviewDecision[];

/**
 * The team's decision with a note. The choices are radio buttons drawn as
 * boxes; the chosen one has a black edge and a filled square. Saving is an
 * outline button: opening the notice is the page's one primary action.
 */
export function DecisionForm({ tenderId, current }: { tenderId: string; current: ReviewDecision | null }) {
  const [state, formAction, pending] = useActionState(saveDecision, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="tenderId" value={tenderId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Karar</legend>
        <div className="grid grid-cols-2 gap-2">
          {DECISIONS.map((decision) => (
            <label
              key={decision}
              className="group flex h-9 cursor-pointer items-center gap-2 border border-line-strong bg-surface px-3 text-sm text-ink-900 transition-colors hover:border-ink-900 has-checked:border-ink-900 has-checked:bg-canvas has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink-900"
            >
              <input type="radio" name="decision" value={decision} defaultChecked={current === decision} className="sr-only" />
              <span aria-hidden className="size-2 shrink-0 border border-ink-400 group-has-checked:border-ink-900 group-has-checked:bg-ink-900" />
              {DECISION_LABELS[decision]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Not</Label>
        <Textarea id="note" name="note" rows={3} maxLength={2000} placeholder="İsteğe bağlı" />
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
