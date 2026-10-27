import { Badge, type BadgeVariant } from "@/components/ui/badge";
import type { Status } from "@/policy/engine";
import { STATUS_DESCRIPTIONS, STATUS_LABELS, STATUS_TONES, type StatusTone } from "@/policy/labels";

/** Colour says the status only: green promising, blue waiting for documents, amber conditional, red rejected. */
const TONE_VARIANT: Record<StatusTone, BadgeVariant> = {
  good: "ok",
  pending: "info",
  conditional: "warn",
  neutral: "default",
  rejected: "err",
};

/** The qualification policy's status, coloured by what it means for the team. */
export function AssessmentBadge({ status }: { status: Status }) {
  return (
    <Badge variant={TONE_VARIANT[STATUS_TONES[status]]} dot title={STATUS_DESCRIPTIONS[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
