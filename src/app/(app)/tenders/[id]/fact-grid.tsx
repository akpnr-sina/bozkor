import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The pieces the tender page's evidence is laid out with, shared by the
// assessment's facts and the deep analysis: boxes split by 1px lines, each a
// label, a value and where its quote was found (CLAUDE.md rule 5), and the
// square marks of a check that holds, fails or is not known.

/** Boxes side by side split by 1px lines (each box draws its own); a row the boxes do not fill stays white. */
export function FactGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-px border border-line bg-surface sm:grid-cols-2 2xl:grid-cols-3", className)}>{children}</div>;
}

/** A value's colour: red when it decides against the tender, amber when it is not known, grey when its quote was not found. */
export type FactTone = "err" | "warn" | "muted" | null;

const VALUE_TONE: Record<NonNullable<FactTone>, string> = { err: "text-err", warn: "text-warn", muted: "text-ink-500" };
const TONE_WORDS: Record<NonNullable<FactTone>, string> = { err: "kararı belirleyen olgu", warn: "bilinmiyor", muted: "alıntı doğrulanmadı" };

/** One box of a FactGrid: the label, the value in its tone, then what is said of it. */
export function FactCell({ label, value, tone = null, children }: { label: string; value: React.ReactNode; tone?: FactTone; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3.5 outline outline-line">
      <span className="eyebrow">{label}</span>
      <FactValue value={value} tone={tone} />
      {children}
    </div>
  );
}

export function FactValue({ value, tone = null, className }: { value: React.ReactNode; tone?: FactTone; className?: string }) {
  return (
    <span className={cn("text-sm font-medium text-ink-900 wrap-anywhere", tone && VALUE_TONE[tone], className)}>
      {value}
      {tone && <span className="sr-only"> ({TONE_WORDS[tone]})</span>}
    </span>
  );
}

/** Past this many characters a text shows its start and opens in place. */
const LONG_TEXT = 220;

const start = (text: string) => text.slice(0, 160).replace(/\s+\S*$/, "");

/** A text that may be long (a quote, the model's detail): it stays inside its box and opens on a click. */
export function LongText({ text, quote = false, className }: { text: string; quote?: boolean; className?: string }) {
  const body = (shown: string, cut: boolean) =>
    quote ? (
      <q className="italic">
        {shown}
        {cut ? "…" : ""}
      </q>
    ) : (
      `${shown}${cut ? "…" : ""}`
    );
  if (text.length <= LONG_TEXT) return <span className={cn("wrap-anywhere", className)}>{body(text, false)}</span>;
  return (
    <details className={cn("group wrap-anywhere", className)}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">
          {body(start(text), true)} <span className="text-ink-900 underline underline-offset-2">devamı</span>
        </span>
        <span className="hidden group-open:inline">{body(text, false)}</span>
      </summary>
    </details>
  );
}

/**
 * A claim's quote, in the language it was written in, and where it was found
 * ("kaynak: ..."); when it was not found, the badge that says so. A value
 * from the notice's structured fields has a source and no quote.
 */
export function Evidence({ quote, source, unverified }: { quote?: string; source: string | null; unverified?: { label: string; why: string } | null }) {
  if (!quote && !source && !unverified) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-ink-500">
      {quote && <LongText text={quote} quote className="text-ink-600" />}
      {source ? (
        <span className="wrap-anywhere">kaynak: {source}</span>
      ) : (
        unverified && (
          <span>
            <Badge variant="warn" title={unverified.why}>
              {unverified.label}
            </Badge>
          </span>
        )
      )}
    </div>
  );
}

/** A check's state: it holds, it does not, it is not known, or it does not apply. */
export type MarkState = "held" | "failed" | "unknown" | "off";

const MARK: Record<MarkState, string> = {
  held: "border-ink-900 bg-ink-900",
  failed: "border-err",
  unknown: "border-warn",
  off: "border-ink-400",
};

export const MARK_WORDS: Record<MarkState, string> = { held: "tutuyor", failed: "tutmuyor", unknown: "bilinmiyor", off: "geçerli değil" };

/** The square of a check: filled when it holds; hollow when it does not (red), is not known (amber) or does not apply (grey). */
export function Mark({ state, className }: { state: MarkState; className?: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 border", MARK[state], className)} />;
}

/** What the marks mean, under a list of them. */
export function MarkLegend({ states }: { states: readonly MarkState[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
      {states.map((state) => (
        <span key={state} className="inline-flex items-center gap-1.5">
          <Mark state={state} />
          {MARK_WORDS[state]}
        </span>
      ))}
    </p>
  );
}
