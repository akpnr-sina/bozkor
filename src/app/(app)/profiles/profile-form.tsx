"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatNumber, NOTICE_TYPE_LABELS, REGIME_LABELS, SOURCE_LABELS } from "@/lib/format";
import { describeReason, REJECTION_LABELS } from "@/matching/describe";
import { formatNumberInput, noticeTypes, sourceIds, type ProfileRules, type ProfileRulesInput } from "@/matching/rules";
import type { RuleKey } from "@/matching/types";
import { previewProfile, saveProfile, type PreviewState, type SaveProfileState } from "./actions";

type Category = { id: string; name: string; cpvPrefixes: string[] };

const REGIMES = Object.keys(REGIME_LABELS) as ProfileRules["regimes"];

/** Text-field state; converted to rules on every change. */
type FormState = {
  name: string;
  active: boolean;
  description: string;
  sources: string[];
  noticeTypes: string[];
  categoryIds: string[];
  cpvInclude: string;
  cpvExclude: string;
  keywordsAny: string;
  keywordsAll: string;
  keywordsNone: string;
  countries: string;
  valueMinEur: string;
  valueMaxEur: string;
  includeUnknownValue: boolean;
  minDaysToDeadline: string;
  regimes: string[];
  noticeLanguages: string;
  triageThreshold: string;
  autoAnalyze: boolean;
  notify: boolean;
  analysisQuestions: string;
};

const splitWords = (text: string) => text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
const splitLines = (text: string) => text.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean);
// Questions contain commas, so only line breaks separate them.
const splitQuestions = (text: string) => text.split(/[\r\n]+/).map((t) => t.trim()).filter(Boolean);

function toState(name: string, active: boolean, rules: ProfileRules): FormState {
  return {
    name,
    active,
    description: rules.description,
    sources: rules.sources,
    noticeTypes: rules.noticeTypes,
    categoryIds: rules.categoryIds,
    cpvInclude: rules.cpvInclude.join(", "),
    cpvExclude: rules.cpvExclude.join(", "),
    keywordsAny: rules.keywordsAny.join("\n"),
    keywordsAll: rules.keywordsAll.join("\n"),
    keywordsNone: rules.keywordsNone.join("\n"),
    countries: rules.countries.join(", "),
    valueMinEur: formatNumberInput(rules.valueMinEur),
    valueMaxEur: formatNumberInput(rules.valueMaxEur),
    includeUnknownValue: rules.includeUnknownValue,
    minDaysToDeadline: rules.minDaysToDeadline?.toString() ?? "",
    regimes: rules.regimes,
    noticeLanguages: rules.noticeLanguages.join(", "),
    triageThreshold: rules.triageThreshold.toString(),
    autoAnalyze: rules.autoAnalyze,
    notify: rules.notify,
    analysisQuestions: rules.analysisQuestions.join("\n"),
  };
}

/** Number fields stay text: the schema parses them, so unreadable input is rejected rather than dropped. */
function toRules(s: FormState): ProfileRulesInput {
  return {
    description: s.description,
    sources: s.sources as ProfileRulesInput["sources"],
    noticeTypes: s.noticeTypes as ProfileRulesInput["noticeTypes"],
    categoryIds: s.categoryIds,
    cpvInclude: splitWords(s.cpvInclude),
    cpvExclude: splitWords(s.cpvExclude),
    keywordsAny: splitLines(s.keywordsAny),
    keywordsAll: splitLines(s.keywordsAll),
    keywordsNone: splitLines(s.keywordsNone),
    countries: splitWords(s.countries),
    valueMinEur: s.valueMinEur,
    valueMaxEur: s.valueMaxEur,
    includeUnknownValue: s.includeUnknownValue,
    minDaysToDeadline: s.minDaysToDeadline,
    regimes: s.regimes as ProfileRulesInput["regimes"],
    noticeLanguages: splitWords(s.noticeLanguages),
    triageThreshold: s.triageThreshold,
    autoAnalyze: s.autoAnalyze,
    notify: s.notify,
    analysisQuestions: splitQuestions(s.analysisQuestions),
  };
}

const initialSave: SaveProfileState = { status: "idle" };

export function ProfileForm({
  profileId,
  initialName,
  initialActive,
  initialRules,
  categories,
  savedNotice,
}: {
  profileId?: string;
  initialName: string;
  initialActive: boolean;
  initialRules: ProfileRules;
  categories: Category[];
  savedNotice?: string;
}) {
  const [state, setState] = useState<FormState>(() => toState(initialName, initialActive, initialRules));
  const [saveState, saveAction, saving] = useActionState(saveProfile, initialSave);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, startPreview] = useTransition();
  const rules = useMemo(() => toRules(state), [state]);
  const rulesKey = JSON.stringify(rules);
  const latestPreview = useRef(0);
  const errors = saveState.status === "error" ? saveState.fieldErrors : {};

  // Debounced live preview. Keyed on the rules text so renaming the profile
  // sends nothing; a slower earlier answer never replaces a newer one.
  useEffect(() => {
    const request = ++latestPreview.current;
    const timer = setTimeout(() => {
      startPreview(async () => {
        const result = await previewProfile(JSON.parse(rulesKey));
        if (request === latestPreview.current) setPreview(result);
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [rulesKey]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const toggle = (key: "sources" | "noticeTypes" | "categoryIds" | "regimes", value: string) =>
    setState((s) => ({ ...s, [key]: s[key].includes(value) ? s[key].filter((v) => v !== value) : [...s[key], value] }));

  const payload = JSON.stringify({ id: profileId, name: state.name, active: state.active, rules });

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <form action={saveAction} className="flex min-w-0 flex-col gap-8">
        <input type="hidden" name="payload" value={payload} />

        <Group title="Profil">
          <Field label="Profil adı" error={errors.name}>
            <Input value={state.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} />
          </Field>
          <Check label="Aktif (yeni ihaleler bu profille eşleştirilir)" checked={state.active} onChange={(v) => set("active", v)} />
          <Field label="Ne arıyoruz?" hint="Serbest metin. AI ön değerlendirmesi bunu kullanacak." error={errors.description}>
            <Textarea value={state.description} onChange={(e) => set("description", e.target.value)} rows={3} />
          </Field>
        </Group>

        <Group title="Konu" hint="CPV önekleri ve anahtar kelimelerden biri tutması yeterli.">
          <Field label="Kategoriler" error={errors.categoryIds}>
            <div className="flex flex-col gap-1.5">
              {categories.map((c) => (
                <Check
                  key={c.id}
                  label={`${c.name} (${c.cpvPrefixes.join(", ")})`}
                  checked={state.categoryIds.includes(c.id)}
                  onChange={() => toggle("categoryIds", c.id)}
                />
              ))}
            </div>
          </Field>
          <Field label="Ek CPV önekleri" hint="Virgülle ayırın, örn. 3112, 312, 313" error={errors.cpvInclude}>
            <Input value={state.cpvInclude} onChange={(e) => set("cpvInclude", e.target.value)} />
          </Field>
          <Field label="Hariç tutulan CPV önekleri" hint="Bu kodlar eşleşmede sayılmaz" error={errors.cpvExclude}>
            <Input value={state.cpvExclude} onChange={(e) => set("cpvExclude", e.target.value)} />
          </Field>
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
        </Group>

        <Group title="Filtreler" hint="Boş bırakılan filtre uygulanmaz.">
          <Field label="Kaynaklar">
            <div className="flex flex-wrap gap-4">
              {sourceIds.map((id) => (
                <Check key={id} label={SOURCE_LABELS[id]} checked={state.sources.includes(id)} onChange={() => toggle("sources", id)} />
              ))}
            </div>
          </Field>
          <Field label="İlan türleri" error={errors.noticeTypes}>
            <div className="flex flex-wrap gap-4">
              {noticeTypes.map((t) => (
                <Check key={t} label={NOTICE_TYPE_LABELS[t] ?? t} checked={state.noticeTypes.includes(t)} onChange={() => toggle("noticeTypes", t)} />
              ))}
            </div>
          </Field>
          <Field label="Ülkeler" hint="İki harfli kodlar, örn. GB, IE, NL, BE" error={errors.countries}>
            <Input value={state.countries} onChange={(e) => set("countries", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="En düşük tutar (EUR)" hint="örn. 20.000" error={errors.valueMinEur}>
              <Input inputMode="decimal" value={state.valueMinEur} onChange={(e) => set("valueMinEur", e.target.value)} />
            </Field>
            <Field label="En yüksek tutar (EUR)" hint="örn. 500.000" error={errors.valueMaxEur}>
              <Input inputMode="decimal" value={state.valueMaxEur} onChange={(e) => set("valueMaxEur", e.target.value)} />
            </Field>
          </div>
          <Check label="Tutarı belirtilmemiş ihaleleri de dahil et" checked={state.includeUnknownValue} onChange={(v) => set("includeUnknownValue", v)} />
          <Field label="Son tarihe en az kaç gün kalmalı" hint="Tam sayı, örn. 10" error={errors.minDaysToDeadline}>
            <Input inputMode="numeric" value={state.minDaysToDeadline} onChange={(e) => set("minDaysToDeadline", e.target.value)} />
          </Field>
          <Field label="Rejimler">
            <div className="flex flex-wrap gap-4">
              {REGIMES.map((r) => (
                <Check key={r} label={REGIME_LABELS[r]} checked={state.regimes.includes(r)} onChange={() => toggle("regimes", r)} />
              ))}
            </div>
          </Field>
          <Field label="İlan dilleri" hint="İki harfli kodlar, örn. EN" error={errors.noticeLanguages}>
            <Input value={state.noticeLanguages} onChange={(e) => set("noticeLanguages", e.target.value)} />
          </Field>
        </Group>

        <Group title="AI ve bildirim" hint="Bu ayarlar ilerleyen aşamalarda devreye girecek.">
          <Field label="Triage eşiği (0-100)" error={errors.triageThreshold}>
            <Input inputMode="numeric" value={state.triageThreshold} onChange={(e) => set("triageThreshold", e.target.value)} />
          </Field>
          <Check label="Eşiği geçenleri otomatik derin analize gönder" checked={state.autoAnalyze} onChange={(v) => set("autoAnalyze", v)} />
          <Check label="Günlük özet e-postasına dahil et" checked={state.notify} onChange={(v) => set("notify", v)} />
          <Field label="Analiz soruları" hint="Her satıra bir soru" error={errors.analysisQuestions}>
            <Textarea value={state.analysisQuestions} onChange={(e) => set("analysisQuestions", e.target.value)} rows={3} />
          </Field>
        </Group>

        {saveState.status !== "idle" && (
          <p role="status" className={saveState.status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {saveState.message}
          </p>
        )}
        {saveState.status === "idle" && savedNotice && <p className="text-sm text-muted-foreground">{savedNotice}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Kaydediliyor..." : "Profili kaydet"}
          </Button>
          <Link href="/profiles" className={buttonVariants({ variant: "outline" })}>
            Profillere dön
          </Link>
        </div>
      </form>

      <aside className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <h2 className="text-base font-semibold">Canlı önizleme</h2>
        <PreviewPanel preview={preview} loading={previewing} />
      </aside>
    </div>
  );
}

function PreviewPanel({ preview, loading }: { preview: PreviewState | null; loading: boolean }) {
  if (!preview) return <p className="text-sm text-muted-foreground">Hesaplanıyor...</p>;
  if (preview.status === "invalid") return <p className="text-sm text-destructive">{preview.message}</p>;
  const { result } = preview;
  const topRejections = (Object.entries(result.rejections) as [RuleKey, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <div className={loading ? "flex flex-col gap-4 opacity-60" : "flex flex-col gap-4"}>
      <p className="text-sm">
        Son 30 günde yayımlanan {formatNumber(result.scanned)} ihaleden{" "}
        <span className="font-semibold">{formatNumber(result.matched)}</span> tanesi bu kurallarla eşleşirdi.
      </p>
      {result.matched > 0 && (
        <p className="text-sm text-muted-foreground">
          Bunların <span className="font-semibold text-foreground">{formatNumber(result.openNow)}</span> tanesine şu an
          teklif verilebilir.
        </p>
      )}
      {topRejections.length > 0 && (
        <div className="text-sm">
          <p className="text-muted-foreground">En sık elenme nedenleri:</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {topRejections.map(([rule, n]) => (
              <li key={rule}>
                {REJECTION_LABELS[rule]}: {formatNumber(n)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.examples.length > 0 && (
        <ol className="flex flex-col gap-3 text-sm">
          {result.examples.map((ex) => (
            <li key={ex.id} className="flex flex-col gap-0.5">
              <Link href={`/tenders/${ex.id}`} className="font-medium hover:underline">
                {ex.title}
              </Link>
              <span className="text-xs text-muted-foreground">
                {formatDate(ex.publishedAt)} · {ex.reasons.slice(0, 2).map(describeReason).join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 flex flex-col gap-0.5">
        <span className="text-base font-semibold">{title}</span>
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && !error && <span className="text-xs text-muted-foreground">{hint}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
      {label}
    </label>
  );
}
