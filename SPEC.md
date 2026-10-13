# Bozkor İhale İstihbarat Platformu: Spesifikasyon

Sürüm 0.1, 12 Ekim 2026

## 1. Amaç ve kapsam

Kullanıcının tanımladığı kriterlere göre UK ve AB kamu ihale ilanlarını otomatik çeken, eşleşenlerin dokümanlarını indirip AI ile analiz eden ve sonuçları tek bir gelen kutusunda sunan iç platform. Sonraki aşamada Türk üretici veritabanı eklenir ve analiz edilmiş ihalelere uygun üretici önerilir.

Bu sürümde kapsam içi:

- Veri kaynakları: Find a Tender (UK) ve TED (AB)
- Kriter profilleri ve eşleştirme
- AI triage (ilan metni üzerinden hızlı uygunluk skoru)
- Doküman indirme ve manuel yükleme
- Derin doküman analizi
- İnsan kararı (GO / REVIEW / NO_GO / WATCH) ve notlar
- Günlük özet e-postası

Şimdilik kapsam dışı: teklif hazırlama, RFQ yönetimi, maliyet hesabı, sözleşme yönetimi, NSPA / DLA / Körfez kaynakları, çok kiracılı yapı.

## 2. Bilinen kısıtlar

1. Dokümanların önemli bir kısmı alıcının e-ihale portalındadır (UK'de Proactis, Delta, In-Tend, Jaggaer, Atamis gibi; AB'de ulusal portallar) ve tedarikçi kaydı ister. Platform sadece herkese açık doğrudan dosya linklerini otomatik indirir. Diğerleri `needs_manual` durumuna düşer, portal linki gösterilir ve kullanıcı dosyaları elle yükler.
2. Find a Tender API'si rate limit uygular. Senkronizasyon artımlı olmalı; ilk geriye dönük yükleme yavaş ilerler.
3. TED ilanları ve dokümanları birçok dilde. Profillerde ilan dili filtresi var; analiz çok dilli çalışır, özet Türkçe üretilir.
4. Claude API PDF'leri doğrudan okur: istek başına 32 MB ve 100 sayfa sınırı. DOCX ve XLSX önce metne çevrilir. Sınırı aşan paketler belge belge analiz edilip birleştirilir.
5. Derin analiz ihale başına anlamlı maliyet çıkarır. Varsayılan tetik manuel; profil bazında otomatik açılabilir; aylık bütçe sınırı vardır.
6. Bu belgedeki API alan adları ve parametreler örnektir. Faz 1 ve Faz 2'nin ilk adımı gerçek yanıtları çekip fixture olarak kaydetmek ve eşlemeyi gerçek veriye göre yapmaktır. Bulunan gerçek eşleme bu belgeye işlenir.

## 3. Mimari akış

```
Zamanlayıcı (pg-boss)
  -> ingest: FaT her 2 saatte, TED günde 2 kez
  -> raw_notices (ham JSON / XML)
  -> normalize -> tenders, lots, documents (sadece URL)
  -> match: her aktif profil, deterministik
  -> triage job (triage modeli, sadece ilan metni)
  -> skor >= profil eşiği ise: fetch_documents job
  -> profil autoAnalyze açıksa ya da kullanıcı "Analiz et" derse: deep_analysis job
  -> günlük özet e-postası (08:00 İstanbul)
```

İlan güncellenirse (düzeltme ilanı, son tarih değişikliği, iptal) tender kaydı güncellenir, `changed_at` set edilir, eşleşme tekrar hesaplanır ve UI'da "değişti" etiketi gösterilir.

## 4. Veri kaynakları

### 4.1 Find a Tender (UK)

13 Ekim 2026'da gerçek yanıtlarla doğrulandı. Örnekler: `tests/fixtures/uk-fat/`. Kod: `src/sources/uk-fat/`.

- Endpoint: `GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`
- Parametreler: `updatedFrom`, `updatedTo`, `limit` (en fazla 100). API saatleri İngiltere yerel saati olarak okur, `Z` ya da `+01:00` gibi ofsetleri yok sayar. İstemci bu yüzden Europe/London saatini `YYYY-MM-DDTHH:mm:ss` biçiminde gönderir.
- Sonuçlar yeniden eskiye gelir. Sonraki sayfa `links.next` ile alınır; link tarih aralığını ve `cursor`'ı korur, son sayfada yoktur.
- `stages` parametresi güvenilir değil: aynı aralıkta 26 ihale ilanı varken `stages=tender` 6, `stages=planning,tender` 0 sonuç döndürdü. Kullanılmıyor; aşama filtresi kodda `tag` ile yapılıyor.
- Tek ilan: `/ocdsReleasePackages/{noticeId}`. Bir prosedürün tüm ilanları: `/ocdsRecordPackages/{ocid}` (şimdilik kullanılmıyor).
- Format: OCDS 1.1 ve uzantılar (`ocds_uk_extension` dahil); Open Government Licence.
- Okuma için anahtar gerekmiyor; başarılı yanıtlarda rate limit başlığı yok. Tam sayfa (~1 MB) bazen 20-45 sn sürüyor. İstemci: 120 sn zaman aşımı, istekler arası en az 1,5 sn, 429'da `Retry-After`, 429 / 5xx / ağ hatasında üstel bekleme.
- Procurement Act 2023 (`legalBasis` UKPGA 2023/54) ve eski rejim (`legalBasis` CELEX, AB direktifleri) ilanları aynı akışta gelir.
- Hacim: iş günü ~450 ilan, bunun ~%60'ı sonuç ve sözleşme bildirimi. Tüm ilanlar `raw_notices`'e yazılır (değişmez kural 2). Sonuç ve sözleşme bildirimleri (`tag` değeri `award` ya da `contract` ile başlayanlar) sadece mevcut bir ihalenin durumunu günceller: başarısız sonuç cancelled, diğerleri awarded. İhale oluşturmazlar; ihalenin kimliğini (external_id, notice_url, published_at) değiştirmezler ve değişiklik sayılmazlar.
- Yedek kaynak: data.gov.uk üzerindeki günlük XML zip dosyaları (kullanılmıyor).

Alan eşlemesi (`normalize.ts`):

| Platform alanı | Find a Tender alanı |
| --- | --- |
| external_id | `id` (ilan numarası, örn. 096253-2026) |
| procedure_key | `ocid` (aynı prosedürün tüm ilanları) |
| notice_type | `tag`: `tender*` ise tender, `planning*` ise planning |
| ilan kodu (saklanmaz) | ilanın kendi dokümanındaki `noticeType` (UK1-UK4, UK12...) |
| regime | `specialRegime` defenceSecurity: defence, utilities: utilities. `legalBasis` CELEX: covered (32009L0081 defence, 32014L0025 utilities; eski rejim ilanları FaT'ye sadece eşik üstünde gelirdi). `aboveThreshold` true: covered, false: below_threshold. Aksi halde unknown. lightTouch ve concession eşiğe göre covered ya da below_threshold |
| status | `tag` *Cancellation: `tender.status` active ise sadece bazı lotlar sonlanmıştır, durum değişmez; cancelled ya da complete ise ihale iptal (bu ilanlarda sonuçlar da cancelled). Diğer ilanlarda `tender.status` cancelled / withdrawn / unsuccessful: cancelled, complete: awarded, active / planning / planned: open. `closed` saklanmaz, sorguda son tarihten türetilir |
| title, description | `tender.title`, `tender.description` (yoksa `planning.milestones[].description`) |
| buyer_name | `buyer.name` (yoksa `parties[roles=buyer].name`) |
| buyer_country | alıcının `address.country` (alpha-2) ya da `countryName`; yoksa GB |
| nuts_code | ilk `items[].deliveryAddresses[].region`, yoksa alıcı adresindeki `region` |
| cpv_main | `tender.classification` (eski rejim); yoksa kalemlerdeki ilk CPV. PA2023 ilanlarında ana CPV yok, kodlar `items[].additionalClassifications` içinde |
| cpv_additional | tender ve kalemlerdeki diğer tüm CPV'ler |
| value_amount, value_currency | `tender.value.amount` (KDV hariç), yoksa `amountGross`; 0 açıklanmamış demek (null). `tender.value` yoksa lot değerlerinin toplamı |
| submission_deadline | `tender.tenderPeriod.endDate`; yoksa `tender.expressionOfInterestDeadline` (rekabetçi esnek usulde katılım talebi son tarihi) |
| clarification_deadline | `tender.enquiryPeriod.endDate` |
| procedure_type | `tender.procurementMethodDetails` (yoksa `procurementMethod`) |
| notice_language | `language` (büyük harf) |
| notice_url | ilanın kendi dokümanının linki (`https://www.find-tender.service.gov.uk/Notice/{id}`) |
| documents_portal_url | `tender.submissionMethodDetails` içindeki ilk URL (çıplak alan adına https eklenir); yoksa ilk `biddingDocuments` linki |
| lots | `tender.lots[]`: `id` lot_number olur; CPV'ler `items[relatedLot]`'tan, değer `lot.value`'dan |
| documents | `planning.documents` ve `tender.documents` içinde linki olanlar; ilan sayfaları (`noticeType` olan ya da türü `...Notice` ile biten) hariç. Bir kısmı doğrudan dosya (`/Notice/Attachment/...`), bir kısmı portal giriş sayfası |

Bilinen veri tuhaflıkları:

- Lot para birimi formda varsayılan olarak AED kalıyor (lot tutarı GBP ihale tutarıyla aynı). Lot AED ve ihale başka para birimindeyse ihalenin para birimi kullanılır. İhale düzeyinde AED görülürse (nadir) yayınlandığı gibi saklanır; ECB kurlarında AED olmadığından value_eur boş kalır.
- Eski rejim düzeltme ilanları (`amendments` dolu, `tender.status` yok) değişiklikleri serbest metin olarak verir (`amendments[].unstructuredChanges`) ve ilanın sadece parçalarını tekrarlar; açıklaması düzeltme metninin kendisidir. Kısmi ilan sayılır: açıklama, CPV, lot ve değer alınmaz, son tarih metinden çıkarılmaz. İhale yine "değişti" olarak işaretlenir.
- Sonlandırma ilanları (UK12) lotları sadece numara ve durumla listeler. Böyle bir liste hangi lotların var olduğunu değiştirmez.
- Kimliği olmayan lot atlanır.
- Tarihler ofsetli gelir (`Z`, `+00:00`, `+01:00`); ofsetsiz gelirse Europe/London kabul edilir.

Birleştirme (`src/sources/fold.ts`): Aynı `ocid`'in tüm ilanları yayın tarihine göre sıralanır ve her alanda o alanı belirten en son ilan geçerli olur. CPV kümesi CPV içeren son ilandan gelir. Lot listesi lot içeren son ilandan gelir, boş lot alanları önceki ilanlardan tamamlanır (iptal ilanları lotları sadece numarayla listeler). Doküman linkleri birikir. published_at ilk ihale ilanının tarihidir, ihale ilanı yoksa ilk ilanın. Önceki bir senkronda var olan ihaleye yeni bir planlama ya da ihale ilanı gelirse (düzeltme, iptal, planlamadan ihaleye geçiş) changed_at set edilir. Bir prosedürde durumu belli en az bir planlama ya da ihale ilanı yoksa ihale oluşturulmaz (sadece sonuç bildirimi olanlar, tek başına eski rejim düzeltmesi); backfill çıktısında "atlanan" olarak sayılır.

Senkron (`src/sources/sync.ts`):

- Artımlı: 2 saatte bir (pg-boss `sync-uk-fat`, `0 */2 * * *`, İstanbul). `sources.cursor`'dan 1 saat geriden başlar (geç indekslenen ilanlar ve yaz saati geçişi için). İlk çalışmada son 24 saat.
- Backfill: `pnpm backfill --source=uk_fat --days=30`. Günlük pencereler, eskiden yeniye, 1 dakika örtüşmeyle. Tekrar çalıştırmak güvenli.
- Aynı içerikteki ham ilan (anahtar sırasından bağımsız sha256) tekrar yazılmaz. Sadece yeni ham kayıt alan prosedürler yeniden hesaplanır.
- Ham satır, ihaleye işlendiğinde ya da atlandığında `applied_at` alır (ihale ile aynı transaction'da, okunan satır kimlikleriyle). Her senkron ve backfill başında `applied_at` boş satırların prosedürleri işlenir; yarıda kesilen bir çalıştırma böylece kendiliğinden tamamlanır.
- `pnpm renormalize --source=uk_fat` tüm ihaleleri saklanan ham ilanlardan yeniden hesaplar (API çağırmaz, changed_at basmaz).

### 4.2 TED (AB)

- Endpoint: `POST https://api.ted.europa.eu/v3/notices/search`; arama için anahtar gerekmez
- Gövde: `query` (expert query), `fields`, `limit`, sayfalama (`page` ya da `paginationMode: "ITERATION"` ile `iterationNextToken`)
- Swagger: https://api.ted.europa.eu/swagger-ui/index.html
- Örnek sorgu (alan adlarını Swagger'dan doğrula): `classification-cpv IN (31120000 31121000) AND publication-date >= 20261001 AND buyer-country IN (IRL NLD BEL)`
- eForms ülke kodları ISO 3166 alpha-3; platform içinde alpha-2'ye çevrilir
- Yanıttaki bildirim linklerinden XML indirilir ve ham olarak saklanır
- Doküman linki eForms'taki "procurement documents URL" alanında (BT-15)
- Aynı prosedüre ait ilanlar (çağrı, düzeltme, sonuç) prosedür kimliğiyle tek tender altında toplanır

### 4.3 Kurlar

ECB günlük referans kurları. `value_eur` hesaplanır; orijinal tutar ve para birimi korunur.

## 5. Veri modeli

- `sources`: id (`uk_fat`, `eu_ted`), cursor, last_synced_at, last_error
- `raw_notices`: id, source, external_id, procedure_key, payload (jsonb) ya da payload_xml (text), sha256, fetched_at, applied_at. (source, external_id, sha256) tekil: aynı payload tekrar yazılmaz, değişen payload yeni satır olur. procedure_key ile bir prosedür ham veriden yeniden hesaplanabilir.
- `tenders`: id, source, external_id, procedure_key (tekilleştirme), notice_type, regime (`covered` | `below_threshold` | `utilities` | `defence` | `unknown`), status (`open` | `closed` | `awarded` | `cancelled`), title, description, buyer_name, buyer_country, nuts_code, cpv_main, cpv_additional[], value_amount, value_currency, value_eur, published_at, submission_deadline, clarification_deadline, procedure_type, notice_language, notice_url, documents_portal_url, changed_at, created_at, updated_at
- `lots`: id, tender_id, lot_number, title, description, cpv, value_amount, value_currency, quantity_text
- `documents`: id, tender_id, origin (`auto` | `manual`), source_url, title, document_type, filename, mime, size_bytes, sha256, storage_path, page_count, text_content (DOCX / XLSX için), fetch_status (`pending` | `fetched` | `needs_manual` | `failed` | `unsupported`), fetch_error. Otomatik dokümanlarda (tender_id, source_url) tekil.
- `categories`: id, name, cpv_prefixes[], description. Profiller ve ileride üreticiler bu ortak taksonomiyi kullanır.
- `criteria_profiles`: id, name, active, rules (jsonb, şema bölüm 6), created_at, updated_at
- `profile_matches`: profile_id, tender_id, matched_at, filter_reasons (jsonb), triage_score, triage_analysis_id, state (`new` | `seen` | `dismissed`)
- `analyses`: id, tender_id, profile_id (opsiyonel), kind (`triage` | `deep`), model, prompt_version, document_ids[], output (jsonb), valid, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, created_at
- `tender_reviews`: id, tender_id, decision (`GO` | `REVIEW` | `NO_GO` | `WATCH`), note, decided_by, decided_at. Append-only; son kayıt geçerli karardır, geçmiş görünür.

Tüm tablolarda RLS açık ve politikasızdır; uygulama Postgres'e doğrudan bağlanır, Supabase Data API bu tablolara erişemez.

## 6. Kriter profili

`rules` alanı Zod ile doğrulanır. Örnek:

```json
{
  "description": "Jeneratör seti, güç dağıtım ekipmanı ve kablo tedariki. Kurulum veya kiralama hizmeti istemiyoruz.",
  "sources": ["uk_fat", "eu_ted"],
  "noticeTypes": ["tender", "planning"],
  "categoryIds": ["guc"],
  "cpvInclude": ["3112", "312", "313"],
  "cpvExclude": [],
  "keywordsAny": ["generator", "generating set", "genset", "power distribution", "cable"],
  "keywordsAll": [],
  "keywordsNone": ["hire", "maintenance services"],
  "countries": ["GB", "IE", "NL", "BE"],
  "valueMinEur": 20000,
  "valueMaxEur": 500000,
  "includeUnknownValue": true,
  "minDaysToDeadline": 10,
  "regimes": ["below_threshold", "covered"],
  "noticeLanguages": ["EN"],
  "triageThreshold": 60,
  "autoAnalyze": false,
  "notify": true,
  "analysisQuestions": [
    "Asgari ciro şartı var mı, varsa ne kadar?",
    "Ürün menşei ya da tedarikçinin yerleşik olduğu ülkeye kısıt var mı?",
    "Kurulum, bakım ya da yerinde servis yükümlülüğü var mı?"
  ]
}
```

Eşleştirme kuralları:

- CPV eşleşmesi önek bazlıdır; ana CPV, ek CPV'ler ve lot CPV'leri birlikte kontrol edilir. `categoryIds` seçilirse kategorinin önekleri `cpvInclude`'a eklenir.
- Anahtar kelimeler başlık, açıklama ve lot metinlerinde büyük/küçük harf ve aksan duyarsız aranır.
- `keywordsNone` eşleşirse ilan elenir.
- Değer bilinmiyorsa `includeUnknownValue` belirler.
- Her eşleşme hangi kuralların tuttuğunu `filter_reasons` içinde saklar ve UI bunu gösterir.
- Motor saf fonksiyondur: `matchTender(tender, lots, rules) => { matched, reasons }`.

Başlangıç kategorileri (seed; CPV önekleri başlangıç önerisidir, kullanıcı düzenler):

- Giyim ve teçhizat: `181`, `3581`, `351134`
- Araç parçaları: `343`
- Shelter ve prefabrik yapılar: `44211`, `39522530`
- Güç (jeneratör, dağıtım, kablo): `3112`, `312`, `313`

## 7. AI analizi

### 7.1 Triage

Model: `LLM_TRIAGE_MODEL`. Girdi: ilan metni, lotlar, profil açıklaması ve profil soruları. Doküman okunmaz. Çıktı:

```json
{
  "relevance": 72,
  "reasons": ["..."],
  "productSummary": "...",
  "quantityHint": "...",
  "noticeRedFlags": ["..."]
}
```

### 7.2 Derin analiz

Model: `LLM_ANALYSIS_MODEL`. Girdi: ilan, indirilen dokümanlar (PDF'ler Files API ile doğrudan, DOCX / XLSX metin olarak) ve profil soruları. Doküman sırası: teknik şartname, teklif talimatları, sözleşme şartları, fiyat cetveli, diğerleri. Toplam 100 sayfayı aşarsa önce belge başına analiz, sonra birleştirme adımı.

Çıktı şeması (özet):

```json
{
  "summaryTr": "",
  "items": [{ "lot": "", "description": "", "quantity": "", "unit": "", "specs": [], "standards": [], "certifications": [], "source": {} }],
  "delivery": { "location": "", "country": "", "incoterm": "", "leadTime": "", "schedule": "", "sources": [] },
  "eligibility": {
    "supplierLocation": "", "productOrigin": "", "minTurnover": "", "references": "",
    "qualityCerts": [], "insurance": [], "securityRequirements": "", "localPresence": "", "sources": []
  },
  "commercial": { "contractType": "", "duration": "", "pricingBasis": "", "paymentTerms": "", "bonds": "", "penalties": "", "warranty": "", "sources": [] },
  "servicesScope": { "installation": "", "maintenance": "", "training": "", "sources": [] },
  "evaluation": [{ "criterion": "", "weight": "", "source": {} }],
  "timeline": { "clarificationDeadline": "", "submissionDeadline": "", "siteVisit": "", "sources": [] },
  "redFlags": [{ "issue": "", "severity": "high", "source": {} }],
  "profileAnswers": [{ "question": "", "answer": "", "source": {} }],
  "missingInfo": [],
  "suggestedDecision": { "decision": "REVIEW", "reasons": [] }
}
```

`source` biçimi: `{ "documentId": "...", "page": 12, "quote": "kısa alıntı, orijinal dilde" }` ya da `{ "noticeField": "tender.tenderPeriod.endDate" }`.

Kurallar:

- Belirlenemeyen alan boş bırakılır ve `missingInfo`'ya yazılır; tahmin yapılmaz.
- Alıntılar PDF metninde (pdfjs-dist, boşluk ve harf normalizasyonuyla) aranır; bulunamayanlar `unverified` işaretlenir.
- Promptlar `prompts/` altında versiyonlu dosyalardır; versiyon `analyses.prompt_version`'a yazılır.
- Aynı ihalenin dokümanları tekrar analizde prompt caching ile cache'lenir.
- AI çıktılarında em dash karakteri (U+2014) yasaktır; prompt bunu açıkça söyler.

## 8. Ekranlar

- Gelen kutusu `/inbox`: eşleşen ihaleler. Filtreler: profil, kaynak, durum, karar. Kolonlar: başlık, alıcı, ülke, değer (EUR), kalan gün, triage skoru, doküman durumu, karar, "değişti" etiketi. Varsayılan sıralama: son tarihe göre, kapanmışlar gizli.
- İhale detayı `/tenders/[id]`: ilan bilgileri ve orijinal ilan linki, lotlar, eşleşme nedenleri, triage sonucu, doküman listesi (durumlar, portal linki, sürükle bırak yükleme), "Analiz et" düğmesi, bölüm bölüm derin analiz (her iddianın yanında kaynak, doğrulanmamış alıntılar işaretli, eksik bilgi listesi), karar ve not alanı, karar geçmişi.
- Profiller `/profiles`: liste ve form. Formda canlı önizleme: "son 30 günde bu kurallarla kaç ilan eşleşirdi" ve ilk 10 örnek.
- Ayarlar `/settings`: kaynak bazında son senkron zamanı ve son hata, aylık LLM harcaması ve sınır, kategori yönetimi.

## 9. Fazlar ve kabul kriterleri

Her faz kendi kabul kriterleri sağlanınca kapanır. Faz bitince CLAUDE.md'deki "Mevcut durum" güncellenir.

### Faz 0: Kurulum

- Next.js 16, TypeScript strict, Tailwind, shadcn/ui kurulu; `pnpm dev` açılıyor.
- Bölüm 5'teki tablolar Drizzle şemasında; migration Supabase'de çalışıyor.
- Supabase Auth magic link; sadece `ALLOWED_EMAILS` içindeki adresler girebiliyor.
- `pnpm worker` pg-boss'a bağlanıyor, örnek bir zamanlanmış job log yazıyor.
- `.env.example` tüm değişkenlerle; Vitest çalışıyor; README'de kurulum adımları var.

### Faz 1: UK veri hattı

- İlk adım: gerçek yanıtları çek, `tests/fixtures/uk-fat/` altına farklı ilan tiplerinden en az 5 örnek kaydet, gerçek alan eşlemesini bölüm 4.1'e işle.
- İstemci: sayfalama, timeout, 429 ve backoff yönetimi.
- Artımlı senkron (`sources.cursor`), 2 saatte bir.
- `pnpm backfill --source=uk_fat --days=30`.
- Normalizer: rejim, durum, CPV'ler, değer, son tarihler, doküman URL'leri, lotlar.
- Kabul: backfill iki kez çalıştırılınca kopya kayıt oluşmuyor; normalizer testleri fixture'larla geçiyor; `sources` tablosunda son senkron zamanı ve hata görünüyor.

### Faz 2: AB veri hattı

- Faz 1'in aynısı TED için (`tests/fixtures/eu-ted/`, bölüm 4.2'ye gerçek eşleme).
- Prosedür bazında gruplama, alpha-3'ten alpha-2'ye ülke çevirisi, ECB kurlarıyla `value_eur`.
- Kabul: Faz 1 ile aynı; ayrıca düzeltme ilanı gelen bir prosedür tek tender olarak kalıyor ve son tarih güncelleniyor.

### Faz 3: Profiller, eşleştirme, gelen kutusu

- `categories` tablosuna bölüm 6'daki dört başlangıç kategorisi seed edilir.
- Profil oluşturma ve düzenleme formu (Zod doğrulamalı) ve canlı önizleme.
- Eşleştirme motoru saf fonksiyon; her kural için en az bir pozitif ve bir negatif birim testi.
- Yeni ilan geldiğinde ve profil değiştiğinde yeniden eşleştirme.
- Gelen kutusu ve ihale detay sayfası (analiz alanları boş olsa da iskelet hazır).
- İnsan kararı ve not, geçmişiyle.
- Kabul: kullanıcı profil oluşturuyor, gelen kutusunda her eşleşmenin nedeni görünüyor, karar verip geri alabiliyor.

### Faz 4: Triage

- `prompts/triage.v1.md`, Zod şeması, yeni eşleşmelerde otomatik job.
- Maliyet kaydı ve aylık bütçe kontrolü.
- Gelen kutusunda skor ve kısa gerekçe.
- Kabul: 50 gerçek eşleşmede triage çalışıyor; geçersiz çıktılar kayıtlı ve oranı ayarlar sayfasında görünüyor.

### Faz 5: Dokümanlar

- Triage eşiğini geçen ihalelerde doküman linklerini çöz; Content-Type ve boyuta göre PDF, DOCX, XLSX, ZIP indir. HTML ya da giriş sayfası dönen link `needs_manual`.
- Supabase Storage'a kaydet; sha256 ile aynı dosyayı tekrar indirme.
- ZIP içeriğini aç; DOCX ve XLSX'i metne çevir; PDF sayfa sayısını kaydet.
- İhale detayında sürükle bırak manuel yükleme.
- Kabul: 20 gerçek ihalede indirme durumları doğru sınıflanıyor; manuel yüklenen dosya analiz girdisi olarak görünüyor.

### Faz 6: Derin analiz

- "Analiz et" düğmesi; profilde `autoAnalyze` açıksa otomatik.
- `prompts/deep.v1.md`, bölüm 7.2 şeması, 100 sayfa üstü için belge başına analiz ve birleştirme.
- Alıntı doğrulama ve UI'da kaynak gösterimi.
- Kabul: 10 gerçek ihalede tüm çıktılar şemaya uygun; kullanıcı spot kontrolünde ciro şartı, menşe kısıtı ve son tarihi en az 8 ihalede doğru buluyor.

### Faz 7: Günlük özet e-postası

- Her sabah 08:00 (İstanbul): yeni eşleşmeler (skora göre), son tarihine 7 gün kalan GO ve REVIEW ihaleler, "değişti" etiketli ihaleler.
- Profilde `notify` kapalıysa o profilin eşleşmeleri gönderilmez.

## 10. Sonraki aşama: üretici modülü (Faz 8)

Bu sürümde inşa edilmez; şema ve kategori taksonomisi buna hazır kurulur.

- Tablolar: `manufacturers` (unvan, şehir, iletişim, üretici / distribütör), `manufacturer_categories` (`categories` ile ilişki), `manufacturer_capabilities` (serbest metin, üretim yöntemleri, malzemeler), `manufacturer_certifications` (ad, standart, geçerlilik bitişi, belge), `manufacturer_documents` (katalog, test raporu), operasyonel alanlar (MOQ, standart termin, ihracat deneyimi, hedef ülkeler)
- CSV içe aktarma ve form
- Eşleştirme: derin analizi yapılmış ihalenin `items` listesi için önce kategori ve zorunlu sertifika filtresi, sonra kalan kısa liste için LLM sıralaması. Çıktı: ihale başına en fazla 3 üretici, gerekçe ve eksik listesi (örnek: "EN ISO 20471 sertifikası yok").
- Üretici sayısı birkaç yüzü geçerse embedding tabanlı ön eleme eklenir.

## 11. Varsayımlar (değiştirilebilir)

- Barındırma: web Vercel, worker Railway, veritabanı ve storage Supabase (EU bölgesi)
- E-posta: Resend, alıcı rfq@bozkor.com
- Saat dilimi: Europe/Istanbul
- Arayüz: Türkçe, tek dil
