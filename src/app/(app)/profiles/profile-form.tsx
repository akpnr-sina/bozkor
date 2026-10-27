"use client";

import Link from "next/link";
import { cloneElement, useActionState, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Notice } from "@/components/notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatNumber, NOTICE_TYPE_LABELS, REGIME_LABELS, SOURCE_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CpvItem } from "@/matching/cpv/catalog";
import { saveProfile, type SaveProfileState } from "./actions";
import { CategoryCodes, CpvPicker } from "./cpv-picker";
import { toRules, type FormState } from "./form-state";
import { createLatest, fetchJson, requestError } from "./latest";
import type { PreviewAnswer, PreviewView } from "./preview";

// The browser's side of the profile form. Nothing here imports the rules or
// the matching modules at run time (Zod, the database schema): the page builds
// the fields and the choices (form-initial.ts), and the preview's words come
// from /api/profiles/preview.

type Category = { id: string; name: string; cpvPrefixes: string[] };

/** What a profile may name: the rules' sources and notice types (src/matching/rules.ts), passed by the page. */
export type ProfileChoices = { sources: readonly string[]; noticeTypes: readonly string[] };

const REGIMES = Object.keys(REGIME_LABELS) as (keyof typeof REGIME_LABELS)[];
/** The live preview is asked for this long after the last change. */
const PREVIEW_DELAY_MS = 400;

const initialSave: SaveProfileState = { status: "idle" };

type PreviewState = { answer: PreviewAnswer | null; loading: boolean; error: string | null };

export function ProfileForm({
  profileId,
  initialState,
  choices,
  categories,
  cpvNames,
  savedNotice,
}: {
  profileId?: string;
  /** The fields as the page filled them from the stored rules (toState). */
  initialState: FormState;
  choices: ProfileChoices;
  categories: Category[];
  /** The CPV codes of the stored prefixes and the categories' ones, by prefix (src/matching/cpv). */
  cpvNames: Record<string, CpvItem | null>;
  savedNotice?: string;
}) {
  const [state, setState] = useState<FormState>(initialState);
  const [saveState, saveAction, saving] = useActionState(saveProfile, initialSave);
  const [preview, setPreview] = useState<PreviewState>({ answer: null, loading: true, error: null });
  const [previews] = useState(() => createLatest<PreviewAnswer>());
  const rules = useMemo(() => toRules(state), [state]);
  const rulesKey = JSON.stringify(rules);
  const errors = saveState.status === "error" ? saveState.fieldErrors : {};

  /** Asks for the preview of these rules; a newer request aborts it, and the shown answer stays until a new one comes. */
  const askPreview = useCallback(
    async (body: string) => {
      setPreview((current) => ({ ...current, loading: true, error: null }));
      const outcome = await previews.run((signal) =>
        fetchJson<PreviewAnswer>("/api/profiles/preview", { method: "POST", body, headers: { "Content-Type": "application/json" }, signal }),
      );
      if (outcome.status === "done") setPreview({ answer: outcome.value, loading: false, error: null });
      else if (outcome.status === "failed") setPreview((current) => ({ ...current, loading: false, error: requestError(outcome.error) }));
    },
    [previews],
  );

  // A moment after the last change, keyed on the rules text, so renaming the profile asks nothing.
  useEffect(() => {
    const timer = setTimeout(() => void askPreview(rulesKey), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rulesKey, askPreview]);
  useEffect(() => () => previews.abort(), [previews]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const toggle = (key: "sources" | "noticeTypes" | "categoryIds" | "regimes", value: string) =>
    setState((s) => ({ ...s, [key]: s[key].includes(value) ? s[key].filter((v) => v !== value) : [...s[key], value] }));

  const payload = JSON.stringify({ id: profileId, name: state.name, active: state.active, rules });
  const categoryPrefixes = categories
    .filter((c) => state.categoryIds.includes(c.id))
    .flatMap((c) => c.cpvPrefixes.map((prefix) => ({ prefix, category: c.name })));

  return (
    <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form action={saveAction} className="flex min-w-0 flex-col gap-[18px]">
        <input type="hidden" name="payload" value={payload} />

        <Section title="Profil">
          <Field label="Profil adı" error={errors.name}>
            <Input value={state.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} />
          </Field>
          <label className="flex w-fit items-center gap-2.5 text-sm">
            <Switch checked={state.active} onCheckedChange={(v) => set("active", v)} />
            Aktif: yeni ihaleler bu profille eşleştirilir
          </label>
          <Field
            label="Ne arıyoruz?"
            hint="Serbest metin. Derin analiz bunu kullanır; ilan değerlendirmesi profilden bağımsız, Bozkor'un yeterlilik politikasıyla yapılır."
            error={errors.description}
          >
            <Textarea value={state.description} onChange={(e) => set("description", e.target.value)} rows={3} />
          </Field>
        </Section>

        <Section
          title="Konu"
          hint="CPV kodlarından ya da anahtar kelimelerden biri tutması yeterli. Kelimeler ilanın kendi dilinde aranır; TED ilanlarının çoğu İngilizce olmadığından orada kategori ve CPV daha güvenilir."
        >
          <Choices label="Hazır kategoriler" error={errors.categoryIds}>
            {categories.map((c) => (
              <Check
                key={c.id}
                label={c.name}
                detail={c.cpvPrefixes.join(", ")}
                checked={state.categoryIds.includes(c.id)}
                onChange={() => toggle("categoryIds", c.id)}
              />
            ))}
          </Choices>
          <CategoryCodes categories={categoryPrefixes} names={cpvNames} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] leading-none font-medium text-ink-900">Ürün kodları (CPV)</legend>
            <CpvPicker
              lists={{ include: state.cpvInclude, exclude: state.cpvExclude }}
              onChange={(lists) => setState((s) => ({ ...s, cpvInclude: lists.include, cpvExclude: lists.exclude }))}
              names={cpvNames}
              categories={categoryPrefixes}
              errors={{ include: errors.cpvInclude, exclude: errors.cpvExclude }}
            />
          </fieldset>
          <Field
            label="Anahtar kelimeler (herhangi biri)"
            hint="Her satıra bir ya da virgülle ayırın. İngilizce çoğul -s/-es kendiliğinden tutar; battery ve batteries gibi düzensizleri ikisini de yazın."
            error={errors.keywordsAny}
          >
            <Textarea value={state.keywordsAny} onChange={(e) => set("keywordsAny", e.target.value)} rows={4} />
          </Field>
          <Field label="Zorunlu kelimeler (hepsi geçmeli)" hint="Her satıra bir ya da virgülle ayırın." error={errors.keywordsAll}>
            <Textarea value={state.keywordsAll} onChange={(e) => set("keywordsAll", e.target.value)} rows={2} />
          </Field>
          <Field
            label="İstenmeyen kelimeler"
            hint="Biri geçerse ihale elenir. Her satıra bir ya da virgülle ayırın, örn. hire, maintenance services"
            error={errors.keywordsNone}
          >
            <Textarea value={state.keywordsNone} onChange={(e) => set("keywordsNone", e.target.value)} rows={2} />
          </Field>
        </Section>

        <Section title="Filtreler" hint="Boş bırakılan filtre uygulanmaz.">
          <Choices label="Kaynaklar" inline>
            {choices.sources.map((id) => (
              <Check
                key={id}
                label={SOURCE_LABELS[id as keyof typeof SOURCE_LABELS] ?? id}
                checked={state.sources.includes(id)}
                onChange={() => toggle("sources", id)}
              />
            ))}
          </Choices>
          <Choices label="İlan türleri" error={errors.noticeTypes} inline>
            {choices.noticeTypes.map((t) => (
              <Check key={t} label={NOTICE_TYPE_LABELS[t] ?? t} checked={state.noticeTypes.includes(t)} onChange={() => toggle("noticeTypes", t)} />
            ))}
          </Choices>
          <Field label="Ülkeler" hint="İki harfli kodlar, örn. GB, IE, NL, BE" error={errors.countries}>
            <Input value={state.countries} onChange={(e) => set("countries", e.target.value)} className="font-mono" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="En düşük tutar (EUR)" hint="örn. 20.000" error={errors.valueMinEur}>
              <Input inputMode="decimal" value={state.valueMinEur} onChange={(e) => set("valueMinEur", e.target.value)} className="font-mono" />
            </Field>
            <Field label="En yüksek tutar (EUR)" hint="örn. 500.000" error={errors.valueMaxEur}>
              <Input inputMode="decimal" value={state.valueMaxEur} onChange={(e) => set("valueMaxEur", e.target.value)} className="font-mono" />
            </Field>
          </div>
          <Check label="Tutarı belirtilmemiş ihaleleri de dahil et" checked={state.includeUnknownValue} onChange={(v) => set("includeUnknownValue", v)} />
          <Field label="Son tarihe en az kaç gün kalmalı" hint="Tam sayı, örn. 10" error={errors.minDaysToDeadline}>
            <Input
              inputMode="numeric"
              value={state.minDaysToDeadline}
              onChange={(e) => set("minDaysToDeadline", e.target.value)}
              className="max-w-40 font-mono"
            />
          </Field>
          <Choices label="Rejimler" inline>
            {REGIMES.map((r) => (
              <Check key={r} label={REGIME_LABELS[r]} checked={state.regimes.includes(r)} onChange={() => toggle("regimes", r)} />
            ))}
          </Choices>
          <Field label="İlan dilleri" hint="İki harfli kodlar, örn. EN" error={errors.noticeLanguages}>
            <Input value={state.noticeLanguages} onChange={(e) => set("noticeLanguages", e.target.value)} className="font-mono" />
          </Field>
        </Section>

        <Section title="Derin analiz" hint="Analiz soruları her derin analizde yanıtlanır.">
          <Check
            label="Eşleşen ihaleleri, dosyaları okununca otomatik derin analize gönder"
            checked={state.autoAnalyze}
            onChange={(v) => set("autoAnalyze", v)}
          />
          <Field label="Analiz soruları" hint="Her satıra bir soru. Derin analiz her birini yanıtlar." error={errors.analysisQuestions}>
            <Textarea value={state.analysisQuestions} onChange={(e) => set("analysisQuestions", e.target.value)} rows={3} />
          </Field>
        </Section>

        {saveState.status === "error" && <Notice tone="err" role="alert" title={saveState.message} />}
        {saveState.status === "saved" && <Notice tone="ok" role="status" title={saveState.message} />}
        {saveState.status === "idle" && savedNotice && <Notice tone="ok" role="status" title={savedNotice} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving} className="chamfer">
            {saving ? "Kaydediliyor..." : "Kaydet"}
          </Button>
          <Link href="/profiles" className={buttonVariants({ variant: "outline" })}>
            Vazgeç
          </Link>
        </div>
      </form>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Canlı önizleme
            </CardTitle>
            <CardDescription>Bu kurallar son 30 günün ilanlarında ne yakalardı; kaydetmeden hesaplanır.</CardDescription>
          </CardHeader>
          <CardContent>
            <PreviewPanel preview={preview} onRetry={() => void askPreview(rulesKey)} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function PreviewPanel({ preview, onRetry }: { preview: PreviewState; onRetry: () => void }) {
  const { answer, loading, error } = preview;
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Notice
          tone="err"
          role="alert"
          title="Önizleme alınamadı"
          action={
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Yeniden dene
            </Button>
          }
        >
          {error}
        </Notice>
      )}
      {answer && loading && (
        <p role="status" className="text-xs text-ink-500">
          Güncelleniyor...
        </p>
      )}
      {!answer ? (
        !error && <p className="text-[13px] text-ink-500">Hesaplanıyor...</p>
      ) : (
        // The last answer stays, faded, until the new one comes.
        <div className={cn("transition-opacity", loading && "opacity-50")}>
          {answer.status === "invalid" ? <p className="text-[13px] text-err">{answer.message}</p> : <PreviewResult result={answer.result} />}
        </div>
      )}
    </div>
  );
}

function PreviewResult({ result }: { result: PreviewView }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="font-heading text-[30px] leading-none font-medium">{formatNumber(result.matched)}</span>
        <span className="text-[13px] text-ink-600">
          Son 30 günde yayımlanan {formatNumber(result.scanned)} ihaleden bu kurallarla eşleşirdi.
          {result.matched > 0 && (
            <>
              {" "}
              Bunların <span className="font-mono text-ink-900">{formatNumber(result.openNow)}</span> tanesine şu an teklif verilebilir.
            </>
          )}
        </span>
      </div>
      {result.rejections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">En sık elenme nedenleri</span>
          <ul className="flex flex-col gap-1 text-[13px] text-ink-600">
            {result.rejections.slice(0, 3).map((rejection) => (
              <li key={rejection.rule} className="flex justify-between gap-3">
                <span>{rejection.label}</span>
                <span className="font-mono">{formatNumber(rejection.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.examples.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Örnekler</span>
          <ol className="flex flex-col divide-y divide-line">
            {result.examples.map((example) => (
              <li key={example.id} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
                <Link href={`/tenders/${example.id}`} className="text-[13px] font-medium underline-offset-4 hover:underline">
                  {example.title}
                </Link>
                <span className="text-xs text-ink-500">
                  <span className="font-mono">{formatDate(example.publishedAt ? new Date(example.publishedAt) : null)}</span>
                  {example.reasons.length > 0 && ` · ${example.reasons.join(" · ")}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** A part of the form: a panel with its label and what the part is for. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {title}
        </CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

type FieldControl = React.ReactElement<{ id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string }>;

/** One field: its label tied to the control, then the hint, or the error in its place. */
function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: FieldControl }) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": note ? `${id}-note` : undefined })}
      {note && (
        <span id={`${id}-note`} className={cn("text-xs", error ? "text-err" : "text-ink-500")}>
          {note}
        </span>
      )}
    </div>
  );
}

/** Checkboxes under one label. */
function Choices({ label, error, inline = false, children }: { label: string; error?: string; inline?: boolean; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] leading-none font-medium text-ink-900">{label}</legend>
      <div className={inline ? "flex flex-wrap gap-x-5 gap-y-2" : "flex flex-col gap-2"}>{children}</div>
      {error && <span className="text-xs text-err">{error}</span>}
    </fieldset>
  );
}

function Check({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex w-fit items-center gap-2 text-sm text-ink-900">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 accent-ink-900" />
      <span>
        {label}
        {detail && <span className="ml-1.5 font-mono text-xs text-ink-500">{detail}</span>}
      </span>
    </label>
  );
}
