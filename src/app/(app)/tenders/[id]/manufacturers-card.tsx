"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { lotLabel } from "@/lib/format";
import { FAMILIES } from "@/manufacturers/families";
import type { ManufacturersAnswer } from "@/manufacturers/match";
import type { LotMatch, MatchCandidate } from "@/manufacturers/types";
import { FactCell, FactGrid, Mark } from "./fact-grid";

// The overview's "Üreticiler" card (SPEC 10, 8.2): on a click it asks GET /api/tenders/[id]/manufacturers
// and lays out the candidates lot by lot, the best three first. The page itself reads nothing of the pool
// and is not refreshed. Every name is a candidate: the firm has not confirmed it can make the product.

const NO_POOL_MATCH = "Havuzda bu ürün için üretici yok.";

type State = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; answer: ManufacturersAnswer };

export function ManufacturersCard({ tenderId }: { tenderId: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function find() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ status: "loading" });
    try {
      const response = await fetch(`/api/tenders/${tenderId}/manufacturers`, { signal: controller.signal, cache: "no-store" });
      const body = (await response.json()) as ManufacturersAnswer | { error?: string };
      if (!response.ok || !("pool" in body)) {
        setState({ status: "error", message: ("error" in body && body.error) || "Üreticiler okunamadı; yeniden deneyin." });
        return;
      }
      setState({ status: "done", answer: body });
    } catch {
      if (!controller.signal.aborted) setState({ status: "error", message: "Bağlantı kurulamadı; yeniden deneyin." });
    }
  }

  const done = state.status === "done" ? state.answer : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Üreticiler</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={find} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Aranıyor..." : done ? "Yeniden bul" : "Uygun üreticileri bul"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5" aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "idle" && (
          <p className="text-[13px] leading-relaxed text-ink-600">
            Havuzdaki üreticiler ilanın ürünüyle kurallarla eşleştirilir: ürün adı, ürün ailesi, güç ve ölçü, belgeler. Yapay zekâ kullanılmaz, sonuç kaydedilmez.
          </p>
        )}
        {state.status === "loading" && <p className="text-[13px] text-ink-500">Havuz taranıyor...</p>}
        {state.status === "error" && <Notice tone="err" title="Üreticiler okunamadı">{state.message}</Notice>}
        {done && (done.pool === null ? <EmptyState>Üretici havuzu henüz yüklenmedi.</EmptyState> : <ManufacturerLots lots={done.result.lots} />)}
      </CardContent>
      {done?.pool && (
        <CardFooter className="text-xs text-ink-500">
          <p>Hepsi aday: üretim kapasitesi firmayla teyit edilmedi. Havuz sürümü {done.pool}.</p>
        </CardFooter>
      )}
    </Card>
  );
}

/** The answer, lot by lot: the best three as boxes, the rest folded, the empty states. */
export function ManufacturerLots({ lots }: { lots: readonly LotMatch[] }) {
  if (!lots.length) return <EmptyState>İlanda eşleştirilecek lot yok.</EmptyState>;
  const several = lots.length > 1;
  return (
    <>
      {lots.map((lot) => (
        <section key={lot.lotNumber || "tender"} className="flex flex-col gap-3">
          {(several || lot.families.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {several && <h3 className="text-sm font-medium text-ink-900">{lotLabel(lot.lotNumber)}</h3>}
              {lot.families.map((f) => (
                <span key={f} className="border border-line px-1.5 py-0.5 text-xs text-ink-600">
                  {FAMILIES[f].label}
                </span>
              ))}
            </div>
          )}
          {lot.status === "not_goods" ? (
            <EmptyState>{lot.notes.join(" ")}</EmptyState>
          ) : (
            <>
              {lot.notes.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-ink-500">
                  {lot.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              {lot.status === "no_pool_match" ? (
                <EmptyState>{NO_POOL_MATCH}</EmptyState>
              ) : (
                <>
                  <FactGrid>
                    {lot.top.map((c) => (
                      <Candidate key={c.manufacturerId} candidate={c} />
                    ))}
                  </FactGrid>
                  {lot.others.length > 0 && <Others candidates={lot.others} />}
                </>
              )}
            </>
          )}
        </section>
      ))}
    </>
  );
}

const nameLink = (c: MatchCandidate) => (
  <Link href={`/manufacturers/${c.manufacturerId}`} className="underline-offset-4 hover:underline">
    {c.legalName}
  </Link>
);

function Candidate({ candidate: c }: { candidate: MatchCandidate }) {
  return (
    <FactCell label={`${c.rank}. aday`} value={nameLink(c)}>
      <ul className="flex flex-col gap-1 text-[13px] text-ink-700">
        {c.reasons.map((r, i) => (
          <li key={`${r.rule}-${i}`} className="flex items-start gap-2">
            <Mark state="held" className="mt-1.5" />
            <span className="wrap-anywhere">{r.text}</span>
          </li>
        ))}
        {c.missing.map((m) => (
          <li key={m} className="flex items-start gap-2 text-ink-600">
            <Mark state="unknown" className="mt-1.5" />
            <span className="wrap-anywhere">
              <span className="sr-only">Eksik: </span>
              {m}
            </span>
          </li>
        ))}
      </ul>
      {c.warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-warn">
          {c.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </FactCell>
  );
}

function Others({ candidates }: { candidates: readonly MatchCandidate[] }) {
  return (
    <details className="group text-[13px]">
      <summary className="cursor-pointer text-ink-600 hover:text-ink-900">{candidates.length} aday daha</summary>
      <ol className="mt-2 flex flex-col border-t border-line-soft">
        {candidates.map((c) => (
          <li key={c.manufacturerId} className="flex flex-col gap-0.5 border-b border-line-soft py-2">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-ink-500">{c.rank}.</span>
              <span className="font-medium text-ink-900">{nameLink(c)}</span>
              {c.warnings.length > 0 && <span className="text-xs text-warn">{c.warnings.join("; ")}</span>}
            </span>
            {c.reasons[0] && <span className="text-xs text-ink-600 wrap-anywhere">{c.reasons[0].text}</span>}
            {c.missing.length > 0 && <span className="text-xs text-ink-500 wrap-anywhere">Eksik: {c.missing.join("; ")}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
