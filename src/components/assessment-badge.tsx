import { Badge } from "@/components/ui/badge";
import type { Status } from "@/policy/engine";
import { STATUS_DESCRIPTIONS, STATUS_LABELS, STATUS_TONES, type StatusTone } from "@/policy/labels";

const TONE_CLASSES: Record<StatusTone, string> = {
  good: "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  pending: "border-transparent bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  conditional: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  neutral: "border-transparent bg-muted text-muted-foreground",
  rejected: "border-transparent bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
};

/** The qualification policy's status, coloured by what it means for the team. */
export function AssessmentBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={TONE_CLASSES[STATUS_TONES[status]]} title={STATUS_DESCRIPTIONS[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
