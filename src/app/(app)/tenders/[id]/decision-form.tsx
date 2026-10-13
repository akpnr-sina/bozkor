"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_LABELS, type ReviewDecision } from "@/lib/format";
import { saveDecision, type DecisionState } from "./actions";

const initialState: DecisionState = { status: "idle" };
const DECISIONS = Object.keys(DECISION_LABELS) as ReviewDecision[];

export function DecisionForm({ tenderId, current }: { tenderId: string; current: ReviewDecision | null }) {
  const [state, formAction, pending] = useActionState(saveDecision, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="tenderId" value={tenderId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Karar</legend>
        {DECISIONS.map((decision) => (
          <label key={decision} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="decision"
              value={decision}
              defaultChecked={current === decision}
              className="size-4 accent-primary"
            />
            {DECISION_LABELS[decision]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Not</Label>
        <Textarea id="note" name="note" rows={3} maxLength={2000} placeholder="İsteğe bağlı" />
      </div>
      {state.status !== "idle" && (
        <p role="status" className={state.status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="save" disabled={pending}>
          {pending ? "Kaydediliyor..." : "Kararı kaydet"}
        </Button>
        {current && (
          <Button type="submit" name="intent" value="clear" variant="outline" disabled={pending}>
            Kararı geri al
          </Button>
        )}
      </div>
    </form>
  );
}
