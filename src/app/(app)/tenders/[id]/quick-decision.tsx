"use client";

import { useActionState } from "react";
import type { ReviewDecision } from "@/lib/format";
import { cn } from "@/lib/utils";
import { saveDecision, type DecisionState } from "./actions";

// The header's two shortcuts to a decision (WATCH, NO_GO) in one bordered
// group, through the decision form's own action: the current one shows
// pressed in its decision's colour (DECISION_TONE), and pressing it again
// takes the decision back.

const SHORTCUTS: readonly { decision: Extract<ReviewDecision, "WATCH" | "NO_GO">; label: string; pressed: string; idle: string }[] = [
  { decision: "WATCH", label: "İzlemeye al", pressed: "bg-info-soft text-info", idle: "text-ink-900 hover:bg-canvas" },
  { decision: "NO_GO", label: "Ele", pressed: "bg-err-soft text-err", idle: "text-ink-600 hover:bg-err-soft hover:text-err" },
];

const initialState: DecisionState = { status: "idle" };

export function QuickDecision({ tenderId, current }: { tenderId: string; current: ReviewDecision | null }) {
  const [state, formAction, pending] = useActionState(saveDecision, initialState);
  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction} className="flex h-9 divide-x divide-line-strong border border-line-strong bg-surface">
        <input type="hidden" name="tenderId" value={tenderId} />
        <input type="hidden" name="note" value="" />
        {SHORTCUTS.map(({ decision, label, pressed, idle }) => {
          const isCurrent = current === decision;
          return (
            <button
              key={decision}
              type="submit"
              formAction={(formData) => {
                // Pressed again: the decision is taken back, as "Kararı geri al" does.
                formData.set("intent", isCurrent ? "clear" : "save");
                formData.set("decision", decision);
                formAction(formData);
              }}
              disabled={pending}
              aria-pressed={isCurrent}
              title={isCurrent ? "Kararı geri al" : undefined}
              className={cn(
                "px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-900 disabled:text-ink-400",
                isCurrent ? pressed : idle,
              )}
            >
              {label}
            </button>
          );
        })}
      </form>
      {state.status === "error" && (
        <span role="alert" className="text-xs text-err">
          {state.message}
        </span>
      )}
    </div>
  );
}
