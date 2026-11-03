import Link from "next/link";
import { FactCell, FactGrid, LongText } from "@/app/(app)/tenders/[id]/fact-grid";
import { EmptyState } from "@/components/empty-state";
import { FormattedText } from "@/components/formatted-text";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Manufacturer, ManufacturerCertification, ManufacturerSource } from "@/db/schema";
import { countryName, formatDate } from "@/lib/format";
import { pageIndex } from "@/lib/nav";
import { FAMILIES, isFamilyCode } from "@/manufacturers/families";
import {
  ADDRESS_KIND_LABELS,
  AQAP_LABELS,
  CERTIFICATION_KIND_LABELS,
  CONTACT_STATE_LABELS,
  FIT_LEVEL_LABELS,
  MANUFACTURER_KIND_LABELS,
  PROVINCE_BASIS_LABELS,
  TRI_LABELS,
} from "@/manufacturers/labels";
import type { ManufacturerDetail } from "@/manufacturers/queries";
import { PRODUCT_CATEGORIES } from "@/policy/categories";

// One manufacturer of the pool (SPEC 10, 8.1): identity, production, certificates, defence and export,
// contacts, the production evidence and where every value came from (rule 5). Read only: the pool is
// changed by importing its next version.

export function ManufacturerView({ detail }: { detail: ManufacturerDetail }) {
  const { manufacturer: m, certifications, sources } = detail;
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        index={pageIndex("/manufacturers")}
        title={m.legalName}
        description={[MANUFACTURER_KIND_LABELS[m.kind], m.province].filter(Boolean).join(" · ")}
        actions={
          <>
            <Link href="/manufacturers" className={buttonVariants({ variant: "outline" })}>
              Üreticilere dön
            </Link>
            {isUrl(m.website) && (
              <a href={m.website} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: "outline" })}>
                Web sitesini aç
              </a>
            )}
          </>
        }
      />
      {!m.active && (
        <Notice tone="warn" title="Bu firma son havuz sürümünde yok.">
          Kayıt pasif; gösterilen bilgiler havuzun {m.poolVersion} sürümünden.
        </Notice>
      )}
      <div className="grid gap-[18px] xl:grid-cols-2">
        <IdentityCard m={m} />
        <LocationCard m={m} />
      </div>
      <ProductionCard m={m} />
      <CertificatesCard m={m} certifications={certifications} />
      <div className="grid gap-[18px] xl:grid-cols-2">
        <DefenseExportCard m={m} />
        <ContactCard m={m} />
      </div>
      <EvidenceCard m={m} />
      <ResearcherCard m={m} />
      <SourcesCard sources={sources} />
      <p className="font-mono text-xs text-ink-500">
        {m.id} · havuz sürümü {m.poolVersion} · kontrol tarihi {day(m.checkedOn)}
      </p>
    </div>
  );
}

// --- Pieces ----------------------------------------------------------------------------------------

const isUrl = (value: string | null | undefined): value is string => !!value && /^https?:\/\//i.test(value);

/** A "YYYY-MM-DD" date the way the app writes dates. */
const day = (iso: string | null) => (iso ? formatDate(new Date(`${iso}T12:00:00Z`)) : "Belirtilmemiş");

const Unknown = ({ children = "Bilinmiyor" }: { children?: React.ReactNode }) => <span className="font-normal text-ink-400">{children}</span>;

const orUnknown = (value: string | null | undefined) => (value ? value : <Unknown />);

/** The links in a pool field, which may hold several separated by ";". */
function Links({ value }: { value: string | null }) {
  if (!value) return <Unknown>Yok</Unknown>;
  const parts = value
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <span className="flex flex-col gap-0.5">
      {parts.map((part) =>
        isUrl(part) ? (
          <a key={part} href={part} target="_blank" rel="noreferrer noopener" className="font-normal break-all text-ink-900 underline underline-offset-4 hover:text-ink-600">
            {part.replace(/^https?:\/\/(www\.)?/i, "")}
          </a>
        ) : (
          <span key={part} className="font-normal">
            {part}
          </span>
        ),
      )}
    </span>
  );
}

function List({ items, empty = "Yok" }: { items: readonly string[]; empty?: string }) {
  if (!items.length) return <Unknown>{empty}</Unknown>;
  return <span className="font-normal">{items.join(", ")}</span>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

const soleProprietorText = (value: boolean | null) => (value === null ? <Unknown /> : value ? "Evet" : "Hayır");

// --- Cards -----------------------------------------------------------------------------------------

function IdentityCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="Kimlik">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="Tüzel kişi unvanı" value={m.legalName} />
        <FactCell label="Şube ya da tesis" value={orUnknown(m.branchName)} />
        <FactCell label="Şahıs işletmesi" value={soleProprietorText(m.soleProprietor)} />
        <FactCell label="Tür" value={MANUFACTURER_KIND_LABELS[m.kind]} />
        <FactCell label="VKN" value={m.vkn ? <span className="font-mono">{m.vkn}</span> : <Unknown>Yok</Unknown>} />
        <FactCell label="MERSİS no" value={m.mersis ? <span className="font-mono">{m.mersis}</span> : <Unknown>Yok</Unknown>} />
        <FactCell label="Kimlik kaynağı" value={<Links value={m.identityUrl} />} />
        <FactCell label="Şirket ve kaynak eşleşmesi" value={m.identityMatch ? <LongText text={m.identityMatch} className="font-normal" /> : <Unknown>Yok</Unknown>} />
      </FactGrid>
    </Section>
  );
}

function LocationCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="Konum" description="İlin neye dayandığı ayrıca yazılır: teyitli fabrika, firmanın kendi beyanı ya da bir rehberin kaydı.">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="İl" value={orUnknown(m.province)} />
        <FactCell label="İlçe" value={orUnknown(m.district)} />
        <FactCell label="İlin dayanağı" value={PROVINCE_BASIS_LABELS[m.provinceBasis]} tone={m.provinceBasis === "unknown" ? "warn" : null} />
        <FactCell label="Adres türü" value={ADDRESS_KIND_LABELS[m.addressKind]} />
        <FactCell label="Adres" value={orUnknown(m.address)} />
        <FactCell label="OSB ya da bölge" value={<List items={m.osbZones} />} />
      </FactGrid>
    </Section>
  );
}

function ProductionCard({ m }: { m: Manufacturer }) {
  const families = m.families.filter(isFamilyCode);
  return (
    <Section title="Üretim">
      <FactGrid>
        <FactCell
          label="Bozkor kategorileri"
          value={<List items={m.categories.map((c) => (Object.hasOwn(PRODUCT_CATEGORIES, c) ? PRODUCT_CATEGORIES[c as keyof typeof PRODUCT_CATEGORIES].label : c))} />}
        />
        <FactCell label="Ürün aileleri" value={<List items={families.map((f) => `${f} ${FAMILIES[f].label}`)} empty="Aile kodu yok" />} />
        <FactCell label="Üretim biçimi" value={orUnknown(m.productionMethod)} />
        <FactCell label="Ölçü ya da güç aralığı" value={orUnknown(m.sizeRange)} />
        <FactCell label="Malzemeler" value={<List items={m.materials} empty="Bilinmiyor" />} />
        <FactCell label="Uyguladığı standartlar" value={<List items={m.standards} empty="Bilinmiyor" />} />
      </FactGrid>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Kendi üretimi ürünler</span>
        {m.products.length ? (
          <ul className="grid gap-x-6 gap-y-1 text-sm text-ink-900 sm:grid-cols-2">
            {m.products.map((p) => (
              <li key={p} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1 shrink-0 bg-ink-400" />
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>Havuzda ürün yazılmamış.</EmptyState>
        )}
      </div>
    </Section>
  );
}

function CertificatesCard({ m, certifications }: { m: Manufacturer; certifications: ManufacturerCertification[] }) {
  return (
    <Section title="Belgeler" description="Havuzdaki beyana göre; geçerlilik ve kapsam teklif öncesi belgenin kendisinden teyit edilmeli.">
      <FactGrid className="2xl:grid-cols-4">
        <FactCell label="AQAP" value={AQAP_LABELS[m.aqap]} tone={m.aqap === "unknown" ? "warn" : null} />
        <FactCell label="AS9100" value={TRI_LABELS[m.as9100]} tone={m.as9100 === "unknown" ? "warn" : null} />
        <FactCell label="Tesis güvenlik belgesi" value={TRI_LABELS[m.facilitySecurity]} />
        <FactCell label="NCAGE kodu" value={m.ncage ? <span className="font-mono">{m.ncage}</span> : <Unknown>Yok</Unknown>}>
          {m.ncageUrl && <Links value={m.ncageUrl} />}
        </FactCell>
      </FactGrid>
      {certifications.length ? (
        <div className="border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Belge</TableHead>
                <TableHead>Tür</TableHead>
                <TableHead>Geçerlilik</TableHead>
                <TableHead>Kaynak</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certifications.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{CERTIFICATION_KIND_LABELS[c.kind]}</Badge>
                  </TableCell>
                  <TableCell className="max-w-72 text-[13px] whitespace-normal">
                    {c.validUntil ? <span className="font-mono">{day(c.validUntil)}</span> : <Unknown>Bitiş tarihi bilinmiyor</Unknown>}
                    {c.note && <div className="text-xs text-ink-500">{c.note}</div>}
                  </TableCell>
                  <TableCell className="max-w-72 text-[13px] whitespace-normal">
                    {/* Several links in the pool belong to no one certificate; the firm's are shown. */}
                    <Links value={c.sourceUrl ?? m.certificationsUrl} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState>Havuzda belge yazılmamış.</EmptyState>
      )}
    </Section>
  );
}

function DefenseExportCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="Savunma ve ihracat">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="Savunma deneyimi" value={m.defenseExperience ? <LongText text={m.defenseExperience} className="font-normal" /> : <Unknown>Yok</Unknown>}>
          {m.defenseUrl && <Links value={m.defenseUrl} />}
        </FactCell>
        <FactCell label="İhracat" value={TRI_LABELS[m.exports]} tone={m.exports === "unknown" ? "warn" : null}>
          {m.exportUrl && <Links value={m.exportUrl} />}
        </FactCell>
        <FactCell label="İhracat ülkeleri" value={<List items={m.exportCountries.map((c) => countryName(c))} empty="Belirtilmemiş" />} />
      </FactGrid>
    </Section>
  );
}

function ContactCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="İletişim" description="Yalnız firma düzeyinde iletişim tutulur (KVKK); kişi adı ve cep telefonu yoktur.">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="İletişim durumu" value={CONTACT_STATE_LABELS[m.contactState]} />
        <FactCell
          label="Genel e-posta"
          value={
            m.emails.length ? (
              <span className="flex flex-col gap-0.5 font-normal">
                {m.emails.map((e) => (
                  <a key={e} href={`mailto:${e}`} className="underline underline-offset-4 hover:text-ink-600">
                    {e}
                  </a>
                ))}
              </span>
            ) : (
              <Unknown>Yok</Unknown>
            )
          }
        />
        <FactCell
          label="Genel telefon"
          value={
            m.phones.length ? (
              <span className="flex flex-col gap-0.5 font-mono font-normal">
                {m.phones.map((p) => (
                  <a key={p} href={`tel:${p.replace(/[^\d+]/g, "")}`} className="underline underline-offset-4 hover:text-ink-600">
                    {p}
                  </a>
                ))}
              </span>
            ) : (
              <Unknown>Yok</Unknown>
            )
          }
        />
        <FactCell label="Web sitesi" value={<Links value={m.website} />} />
        <FactCell label="En az sipariş" value={orUnknown(m.moq)} />
        <FactCell label="Termin" value={m.leadTimeDays === null ? <Unknown /> : `${m.leadTimeDays} gün`} />
      </FactGrid>
    </Section>
  );
}

function EvidenceCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="Üretim kanıtı" description="Firmanın bu ürünleri kendisinin ürettiğini gösteren kaynak ve oradan birebir alıntı.">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="Kaynak türü" value={orUnknown(m.evidenceKind)} />
        <FactCell label="Bağlantı" value={<Links value={m.evidenceUrl} />} />
        <FactCell label="Sayfadaki yeri" value={orUnknown(m.evidenceLocation)} />
        <FactCell label="İlk kayıt kaynakları" value={<Links value={m.firstSources} />} />
      </FactGrid>
      {m.evidenceQuote ? (
        <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-ink-900 italic">{m.evidenceQuote}</blockquote>
      ) : (
        <Notice tone="warn" title="Üretim alıntısı yok.">
          Bu firmanın üretimi havuzda bir alıntıyla gösterilmemiş.
        </Notice>
      )}
    </Section>
  );
}

function ResearcherCard({ m }: { m: Manufacturer }) {
  return (
    <Section title="Araştırmacı notu" description="Havuzu hazırlayanın değerlendirmesi; puan değildir, eşleştirmede yalnız uyarı olarak kullanılır.">
      <FactGrid className="2xl:grid-cols-2">
        <FactCell label="İhale uygunluğu" value={m.fitLevel ? FIT_LEVEL_LABELS[m.fitLevel] : <Unknown />} tone={m.fitLevel === "low" ? "warn" : null} />
        <FactCell label="Uygunluk notu" value={m.fitNote ? <LongText text={m.fitNote} className="font-normal" /> : <Unknown>Yok</Unknown>} />
      </FactGrid>
      {m.notes && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Notlar</span>
          <Notes text={m.notes} />
        </div>
      )}
    </Section>
  );
}

/** The pool's notes are items separated by ";"; one item reads as a paragraph. */
function Notes({ text }: { text: string }) {
  const items = text
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length <= 1) return <FormattedText text={text} className="text-sm leading-relaxed text-ink-900" />;
  return (
    <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-ink-900">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-2 size-1 shrink-0 bg-ink-400" />
          {item}
        </li>
      ))}
    </ul>
  );
}

function SourcesCard({ sources }: { sources: ManufacturerSource[] }) {
  return (
    <Section title="Alan kaynakları" description="Her değerin nereden geldiği ve nasıl doğrulandığı, havuzun alan kaynakları dosyasından.">
      {sources.length ? (
        <div className="border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alan</TableHead>
                <TableHead>Değer</TableHead>
                <TableHead>Kaynak</TableHead>
                <TableHead>Doğrulama</TableHead>
                <TableHead className="hidden lg:table-cell">Kontrol</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.field}>
                  <TableCell className="max-w-48 text-[13px] font-medium whitespace-normal">{s.field}</TableCell>
                  <TableCell className="max-w-80 text-[13px] whitespace-normal">
                    {s.value ? <LongText text={s.value} /> : <Unknown>Boş</Unknown>}
                    {s.note && <div className="mt-1 text-xs text-ink-500">{s.note}</div>}
                  </TableCell>
                  <TableCell className="max-w-72 text-[13px] whitespace-normal">
                    <Links value={s.sourceUrl} />
                    {s.previousSources && (
                      <details className="mt-1 text-xs text-ink-500">
                        <summary className="cursor-pointer select-none">Önceki kaynaklar</summary>
                        <Links value={s.previousSources} />
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="text-[13px]">
                    <Badge variant="outline">{s.verification}</Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-ink-600 lg:table-cell">{day(s.checkedOn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState>Bu firma için alan kaynağı yok.</EmptyState>
      )}
    </Section>
  );
}
