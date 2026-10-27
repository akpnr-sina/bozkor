import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AssessmentBadge } from "@/components/assessment-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { Tender } from "@/db/schema";
import {
  CONTRACT_NATURE_LABELS,
  formatDate,
  NOTICE_TYPE_LABELS,
  REGIME_LABELS,
  type ReviewDecision,
  SOURCE_LABELS,
  STATUS_LABELS,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Status } from "@/policy/engine";
import { isProductScope } from "@/sources/scope";
import { QuickDecision } from "./quick-decision";
import { STATUS_VARIANT } from "./tender-view";

// The head of a tender's page: back to the inbox, the notice's number and
// badges, the title (Turkish when translated, the original under it), who
// buys and when it was published; on the right the decision shortcuts and the
// page's one primary action, opening the notice.

type Props = {
  tender: Tender;
  title: string;
  /** The original title, when the title shown is its translation. */
  originalTitle: string | null;
  /** The translation was made of an earlier version of the notice. */
  translationOutdated: boolean;
  assessment: Status | null;
  /** The tender changed after the team's latest decision. */
  changedSinceDecision: boolean;
  decision: ReviewDecision | null;
};

export function TenderHeader({ tender, title, originalTitle, translationOutdated, assessment, changedSinceDecision, decision }: Props) {
  const subline = [tender.buyerName, tender.publishedAt ? `${formatDate(tender.publishedAt)} tarihinde yayımlandı` : null].filter(Boolean).join(" · ");
  return (
    <header className="flex flex-col gap-4">
      <Link href="/inbox" className="inline-flex w-fit items-center gap-1.5 text-[13px] text-ink-500 hover:text-ink-900">
        <ArrowLeft aria-hidden className="size-3.5" />
        Gelen kutusu
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-ink-500">{tender.externalId}</span>
            <Badge variant={STATUS_VARIANT[tender.status]} dot>
              {STATUS_LABELS[tender.status]}
            </Badge>
            {assessment && <AssessmentBadge status={assessment} />}
            <Badge variant="outline">{SOURCE_LABELS[tender.source as keyof typeof SOURCE_LABELS] ?? tender.source}</Badge>
            {tender.noticeType && <Badge>{NOTICE_TYPE_LABELS[tender.noticeType] ?? tender.noticeType}</Badge>}
            <Badge>{REGIME_LABELS[tender.regime]}</Badge>
            {tender.contractNature && <Badge>{CONTRACT_NATURE_LABELS[tender.contractNature]}</Badge>}
            {changedSinceDecision && tender.changedAt && (
              <Badge variant="warn" dot>
                Değişti: {formatDate(tender.changedAt)}
              </Badge>
            )}
            {!isProductScope(tender.contractNature, tender.cpvMain) && (
              <Badge title="Sadece mal alımları takip ediliyor. Bu ihale kararınız olduğu için duruyor, profillerle eşleşmez.">Kapsam dışı</Badge>
            )}
          </div>
          <h1 className="font-heading text-[30px] leading-[1.1] font-semibold tracking-[0.005em] text-ink-900">{title}</h1>
          {originalTitle && (
            <p className="text-sm text-ink-600">
              {originalTitle} <span className="text-xs text-ink-500">(orijinal başlık; Türkçesi AI çevirisi)</span>
            </p>
          )}
          {translationOutdated && <p className="text-xs text-ink-500">Çeviri ilanın önceki hâline ait; yenisi sırada.</p>}
          {subline && <p className="text-[13px] text-ink-600">{subline}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <QuickDecision tenderId={tender.id} current={decision} />
          {tender.noticeUrl && (
            <a href={tender.noticeUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "lg" }), "chamfer")}>
              İlanı aç
              <ArrowUpRight aria-hidden className="size-4" />
              <span className="sr-only"> (yeni sekmede açılır)</span>
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
