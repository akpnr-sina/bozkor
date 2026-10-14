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

Sadece ürün (mal alımı) ihaleleri (ekip kararı, 14 Ekim 2026). Hizmet, danışmanlık, yazılım ve yapım işi ihaleleri sisteme alınmaz (`src/sources/scope.ts`):

- Sözleşmenin beyan edilen ana türü esastır (FaT `mainProcurementCategory`, TED `contract-nature-main-proc`). Tür belirtilmemişse ana CPV'nin bölümüne bakılır: 45 yapım, 50 ve üstü hizmet, diğerleri mal. Tür de CPV de yoksa kapsam dışı sayılır (bir günlük FaT verisinde bu durumdaki 4 ilanın hepsi, asıl ilanı elimizde olmayan UK12 iptal bildirimiydi).
- Ana CPV'si 48 (yazılım paketleri) olan ihale, mal alımı diye beyan edilse de kapsam dışıdır.
- TED'de hizmet ve yapım ilanları sunucu tarafında elenir, hiç çekilmez. FaT API'si türe göre filtrelemediği için FaT ilanlarının hepsi ham olarak saklanır (değişmez kural 2), ama kapsam dışı prosedürden ihale oluşturulmaz.
- Kural sonradan değiştiği ya da bir düzeltme türü değiştirdiği için kapsam dışına düşen ihale silinir (lotları, linkleri ve eşleşmeleriyle). Kararı, AI analizi ya da indirilmiş dokümanı olan ihale silinmez: güncellenmeye devam eder, "Kapsam dışı" işareti taşır, eşleşmeleri biter ve hiçbir profille yeniden eşleşmez. Son kararı GO, REVIEW ya da WATCH ise gelen kutusunda kalır.
- Silmeden önce ihale satırı kilitlenir ve koşul ayrı bir sorguyla kontrol edilir; bu sırada kaydedilen bir karar görülür ve ihale kalır. Prosedürün okunamayan bir ilanı varsa kapsam dışı diye silinmez (türü belirten ilan o olabilir).
- `pnpm renormalize --source=uk_fat --dry-run` gerçek çalıştırmadan önce kaç ihalenin silineceğini, kaçının kalacağını ve kaçının eşleşmesinin biteceğini yazar.

## 2. Bilinen kısıtlar

1. Dokümanların önemli bir kısmı alıcının e-ihale portalındadır (UK'de Proactis, Delta, In-Tend, Jaggaer, Atamis gibi; AB'de ulusal portallar) ve tedarikçi kaydı ister. Platform sadece herkese açık doğrudan dosya linklerini otomatik indirir. Diğerleri `needs_manual` durumuna düşer, portal linki gösterilir ve kullanıcı dosyaları elle yükler.
2. Find a Tender API'si rate limit uygular. Senkronizasyon artımlı olmalı; ilk geriye dönük yükleme yavaş ilerler.
3. TED ilanları ve dokümanları birçok dilde. Profillerde ilan dili filtresi var; analiz çok dilli çalışır, özet Türkçe üretilir.
4. Claude API PDF'leri doğrudan okur: istek başına 32 MB ve 100 sayfa sınırı. DOCX ve XLSX önce metne çevrilir. Sınırı aşan paketler belge belge analiz edilip birleştirilir.
5. Derin analiz ihale başına anlamlı maliyet çıkarır. Varsayılan tetik manuel; profil bazında otomatik açılabilir; aylık bütçe sınırı vardır.
6. Bu belgedeki API alan adları ve parametreler örnektir. Faz 1'in ve TED fazının (Faz 3) ilk adımı gerçek yanıtları çekip fixture olarak kaydetmek ve eşlemeyi gerçek veriye göre yapmaktır. Bulunan gerçek eşleme bu belgeye işlenir.

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
- Hacim: iş günü ~450 ilan, bunun ~%60'ı sonuç ve sözleşme bildirimi. Çağrı ve planlama ilanlarının ~%20'si mal alımı; gerisi kapsam dışı (bölüm 1). Tüm ilanlar `raw_notices`'e yazılır (değişmez kural 2). Sonuç ve sözleşme bildirimleri (`tag` değeri `award` ya da `contract` ile başlayanlar) sadece mevcut bir ihalenin durumunu günceller: başarısız sonuç cancelled, diğerleri awarded. İhale oluşturmazlar; ihalenin kimliğini (external_id, notice_url, published_at) değiştirmezler ve değişiklik sayılmazlar.
- Yedek kaynak: data.gov.uk üzerindeki günlük XML zip dosyaları (kullanılmıyor).

Alan eşlemesi (`normalize.ts`):

| Platform alanı | Find a Tender alanı |
| --- | --- |
| external_id | `id` (ilan numarası, örn. 096253-2026) |
| procedure_key | `ocid` (aynı prosedürün tüm ilanları) |
| contract_nature | `tender.mainProcurementCategory` (goods, services, works) |
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
- `pnpm renormalize --source=uk_fat` tüm ihaleleri saklanan ham ilanlardan yeniden hesaplar (API çağırmaz, changed_at basmaz). `--dry-run` hiçbir şey yazmadan kapsam kuralının kaç ihaleyi sileceğini ve kaçını tutacağını raporlar.

### 4.2 TED (AB)

14 Ekim 2026'da gerçek yanıtlarla doğrulandı. Örnekler: `tests/fixtures/eu-ted/`. Kod: `src/sources/eu-ted/` (istemci `client.ts`, sorgu ve alan listesi `fields.ts`); ülke ve dil dönüşümleri `src/lib/countries.ts`, `src/lib/languages.ts`.

- Endpoint: `POST https://api.ted.europa.eu/v3/notices/search`. Arama için anahtar gerekmiyor. Belgeler: https://api.ted.europa.eu/swagger-ui/index.html (OpenAPI: `https://api.ted.europa.eu/api-v3.yaml`).
- Gövde: `query`, `fields`, `limit`, `scope: "ALL"`, `paginationMode: "ITERATION"`; ikinci istekten itibaren önceki yanıtın `iterationNextToken`'ı. `query` = `TED_BASE_QUERY AND publication-date>=YYYYMMDD AND publication-date<=YYYYMMDD`, `fields` = `TED_FIELDS`.
- Kapsam sunucu tarafında: `TED_BASE_QUERY` = `form-type IN (competition planning) AND contract-nature-main-proc=supplies`. Sadece mal alımı çağrı ve planlama ilanları gelir; hizmet ve yapım ilanları hiç çekilmez, saklanmaz.
- Yazılım (CPV 48) mal alımı sayıldığı için sunucuda elenmez (13 Ekim'de supplies ilanlarının ~%7'si). Ham kaydı saklanır ama ana CPV'si 48 ile başlayan prosedürden ihale oluşturulmaz. Kapsam kuralının ayrıntısı bölüm 1'de.
- Sonuç ilanları (`form-type` result) şimdilik çekilmiyor. Bu yüzden TED ihaleleri awarded olmaz; son tarih geçince kapalı görünür (kapanış son tarihten türetilir).
- Sayfalama kaydırma (ITERATION) moduyla. Sunucu bir point in time tutar: sayfalar arasında ilan kaçmaz ya da tekrarlanmaz, sonuç sayısında üst sınır yoktur (sayfa numaralı modda 15.000). Token her sayfada değişir ve hiç null gelmez; son sayfa `notices: []` ve dolu bir tokenla gelir. Kaydırma boş `notices` ile biter (tokensız sayfa da bitirir). Aynı token tekrar gelirse döngü hatası; en fazla 2.000 sayfa.
- Sayfa boyutu: en fazla 250 ilan ve 10.000 alan. API alanı `limit × (alan sayısı + 1)` olarak sayar, çünkü her ilana `links` ekler. İstemci `limit` = min(250, floor(10.000 / (alan sayısı + 1))) kullanır: 44 alanla 222 (14 Ekim'de 45 alanla 217 geçti, 222 HTTP 400 `SEARCH_FIELDS_PER_PAGE_EXCEEDS_MAX_LIMIT` aldı). `fields.ts`'e alan eklenince limit kendiliğinden küçülür.
- Yanıt: `notices`, `totalNoticeCount`, `iterationNextToken`, `timedOut` (Zod ile doğrulanır). `timedOut: true` gelirse sayfa eksik olabilir; istemci hata fırlatır, çalıştırma düşer ve sonraki çalıştırma aynı günleri yeniden çeker.
- Tarihler: TED yayın tarihi gündür. Senkron penceresinin başı ve sonu Brüksel takvimine göre güne çevrilir (`tedDay`; yaz saatinde 22:00 UTC, kışın 23:00 UTC ertesi gündür).
- Tamamlanan günler: aynı istemci örneği, hatasız biten bir kaydırmanın bugünden önceki günlerini tamamlandı sayar. Sonraki pencerede baştaki tamamlanmış günler atlanır, hepsi tamamsa istek atılmaz. Bugün hiç işaretlenmez, çünkü günün baskısı henüz yayımlanmamış olabilir. Hata, `timedOut` ya da sayfa işlenirken düşen bir senkron hiçbir günü işaretlemez. Backfill pencereleri günün herhangi bir saatinde başladığından, her gün böylece bir kez çekilir.
- İstemci: istekler arası en az 1 sn, 120 sn zaman aşımı, 429'da `Retry-After`, 429 / 5xx / ağ hatasında üstel bekleme (en fazla 6 deneme). Arama POST ama salt okunur, tekrar denemek güvenli.
- Ham payload: arama yanıtındaki ilan nesnesi, `links` alanı silinmiş olarak. `links` ilanın 24 dilde PDF, HTML ve XML adresleridir ve ilan numarasından türetilebilir; eForms XML'i ayrıca indirilmez. Linksiz bir ilan ortalama ~5 KB (13 Ekim'in 658 ilanında ölçüldü); kısa ilanlar 1-2 KB, uzun açıklamalılar 10 KB üstü.
- Yanıt biçimi: alanların çoğu dizidir (`buyer-country: ["MLT"]`, `official-language: ["ENG"]`). Metinler küçük harf dil anahtarlı nesnedir (`title-proc: { "eng": "..." }`). Tarihler ofsetli gün olarak gelir (`2026-10-13+02:00`), saatler ayrı alanlardadır (örn. `deadline-receipt-tender-time-lot`).
- Hacim: 5-9 Ekim 2026 haftasında 3.685 ilan, iş günü ~740 (217'lik ~4 sayfa). Ham veri günde ~3,3 MB, ayda ~70 MB (sıkıştırmasız; Postgres büyük JSON değerlerini sıkıştırarak saklar). 13 Ekim'de 658 ilanın %5'i İngilizce; profilde ilan dili EN seçilirse TED'in çoğu elenir.
- Ülke kodları: TED ISO 3166-1 alpha-3 gönderir (DEU, MLT). `alpha3ToAlpha2` ISO 3166-1'in tamamını (249 kod) alpha-2'ye çevirir. Kosova için AB'nin kullandığı XKX ve AB ülke tablosundaki 1A0, XK olur. Bilinmeyen kod null.
- Dil kodları: `official-language` ISO 639-2 üç harflidir; TED terminoloji biçimini kullanır (DEU, FRA, NLD, ELL, RON, CES, SLK, ISL), bibliyografik biçim de (GER, FRE, DUT, GRE, RUM, CZE, SLO, ICE) kabul edilir. `languageToAlpha2` profil dil filtresinin kullandığı iki harfli koda çevirir (ENG -> EN); Norveççe yazımlar (NOR, NOB, NNO) NO olur. MUL ve bilinmeyenler null.

Eşleme (`src/sources/eu-ted/normalize.ts`):

| Platform alanı | TED alanı |
| --- | --- |
| external_id | `publication-number` (örn. 704935-2026) |
| procedure_key | `procedure-identifier`: çağrı ve tüm değişiklik ilanları aynı kimliği taşır. Planlama ilanlarında yoktur: bir planlama ilanının değişikliği `change-notice-version-identifier`'daki asıl ilan kimliğiyle (`<uuid>-<sürüm>` biçiminde) gruplanır, diğerleri kendi `notice-identifier`'ıyla tek başına durur |
| notice_type | `form-type`: competition ise tender, planning ise planning. Yeterlilik sistemleri (`notice-type` qu-sy) ihale oluşturmaz: belirli bir alım değil, kamu hizmeti kuruluşlarının yıllarca açık kalan tedarikçi listesidir (30 günde ~80 ilan; ham kaydı saklanır) |
| ilan kodu (saklanmaz) | `notice-type` (cn-standard, pin-only...) |
| regime | `legal-basis` (CELEX): 32014L0024 ve 32014L0023 covered, 32014L0025 utilities, 32009L0081 defence, 32018R1046 ve 32024R2509 (AB kurumları, Mali Tüzük) covered. `other` ve tanınmayanlar unknown |
| contract_nature | `contract-nature-main-proc`: supplies ise goods (sorgu zaten sadece supplies getirir) |
| status | `change-reason-code` (BT-140) cancel ya da cancel-intent ise cancelled, aksi halde open (susp-review şikâyet nedeniyle askıya almadır, iptal değil). TED'de iptali geri alan kod olmadığından iptal kalıcıdır: iptalden sonra gelen bir düzeltme ihaleyi yeniden açmaz (`fold.ts`). `closed` saklanmaz, sorguda son tarihten türetilir |
| title, description | `title-proc`, `description-proc`. İngilizcesi varsa o, yoksa ilanın resmi dili, yoksa ilk dil. Çeviri yapılmaz (`notice-title` alanındaki "İngilizce" başlık sadece "Ülke, CPV adı, orijinal başlık" şablonudur, alınmaz) |
| buyer_name | `buyer-name` (aynı dil sırası), ilk alıcı |
| buyer_country | `buyer-country`'nin ilk değeri, alpha-3'ten alpha-2'ye |
| nuts_code | `place-of-performance-subdiv-proc`, yoksa `place-of-performance-subdiv-lot`, yoksa `buyer-country-sub` |
| cpv_main | `main-classification-proc` |
| cpv_additional | `additional-classification-proc`, lotların ana ve ek kodları ve `classification-cpv`'deki diğer tüm kodlar |
| value_amount, value_currency | `estimated-value-proc` ve `estimated-value-cur-proc`; "0" açıklanmamış demek (null). Yoksa lot değerlerinin toplamı (her lotun değeri varsa ve para birimi tekse) |
| submission_deadline | lotların en erken `deadline-receipt-tender-date-lot` + `deadline-receipt-tender-time-lot` değeri. Yoksa en erken katılım talebi son tarihi (`deadline-receipt-request-*`; belli istekliler arası ve pazarlıklı usullerde tedarikçinin ilk son tarihi). Saat yoksa günün sonu |
| clarification_deadline | en erken `deadline-receipt-answers-date-lot` + `deadline-receipt-answers-time-lot` |
| procedure_type | `procedure-type` kodunun İngilizce adı: open "Open procedure", restricted "Restricted procedure", neg-w-call, neg-wo-call, comp-dial, innovation, oth-single, oth-mult, comp-tend ve exp-int-rail (1370/2007 yolcu taşımacılığı); tanınmayan kod olduğu gibi. İlanların ~%3'ünde alan yok (null) |
| notice_language | `official-language` içinde ENG varsa EN (dil filtresi "İngilizce okunabilir mi" sorusuna cevap verir), yoksa ilk resmi dil, iki harfe çevrilmiş |
| notice_url | `https://ted.europa.eu/en/notice/-/detail/{publication-number}` |
| documents_portal_url | ilk `document-url-lot`, yoksa ilk `submission-url-lot` |
| published_at | `publication-date` gününün başlangıcı, ofsetiyle (`2026-10-13+02:00`, 2026-10-12T22:00Z olur). ECB kuru da bu günün (Frankfurt takvimi) kurudur |
| lots | `identifier-lot` sırasıyla. Başlık, açıklama, ana CPV, değer ve para birimi aynı sıradaki elemandan alınır, ama sadece alanın lot sayısı kadar elemanı varsa. Tek elemanlı lot para birimi tüm lotlara uygulanır. Lot ek CPV'leri düz liste geldiği için lota bağlanmaz (ihalenin CPV'lerine girer) |
| documents | `document-url-lot` içindeki tekil http(s) linkler (`procurementDocuments` türüyle). Çoğu ulusal e-ihale portalının sayfası, doğrudan dosya değil |

Bilinen veri tuhaflıkları:

- Değişiklik ilanı tam ilandır: tüm alanları yeniden verir, kendi `notice-identifier`'ı ve `publication-number`'ı vardır. Zincir halinde gelebilir (her değişiklik bir öncekini gösterir, örn. Polonya 617868 -> 677176 -> 699928 -> 706847). Gruplama `procedure-identifier` ile olduğundan zincir tek ihalede toplanır, en son yayınlanan geçerlidir.
- Lot dizileri her zaman hizalı değil: `estimated-value-lot` 6 lotluk ilanda tek eleman gelebilir, `estimated-value-cur-lot` çoğunlukla tek eleman, `additional-classification-lot` düz liste. Hizalı olmayan alan lotlara dağıtılmaz.
- Tutarlar metin gelir ("109758.12", "0", "0.00").
- Aynı değer lotlarda tekrar edebilir (Malta 706732-2026: iki lotun ikisinde de prosedür toplamı). Yayınlandığı gibi saklanır; ihale değeri prosedür toplamından gelir.
- Tarih ve saat ayrı alanlardadır; ofsetsiz gelirse Brüksel saati kabul edilir.
- Nadiren son tarihi hiç olmayan çağrı ilanı gelir (13 Ekim'de 1/642); son tarihi bilinmediği için açık görünür.
- MDL (Moldova) gibi ECB'nin yayınlamadığı para birimlerinde value_eur boş kalır.
- `competition-termination-proc` (BT-756) eForms'a göre sadece sonuç ilanlarında bulunur, çekilmez.

Bilinen eksikler:

- Planlama ilanı (PIN) ile sonraki çağrı ilanı bağlanmaz (çağrıların ~%3'ü `previous-planning-identifier-lot` ile bir PIN'i gösterir); ikisi de varsa gelen kutusunda ayrı kayıt olurlar.
- Bir planlama ilanının ikinci değişikliği birinci değişikliğe işaret ettiğinden ayrı ihale olur (2 haftada 11 PIN değişikliği, zincir yok).
- Profil anahtar kelimeleri ilanın dilinde aranır; TED ilanlarının ~%95'i İngilizce değil, orada eşleşme fiilen CPV'ye dayanır.

Birleştirme ve senkron:

- Birleştirme FaT ile aynı kurallarla (`fold.ts`). TED yayın tarihi gün olduğundan aynı gün yayınlanan iki ilan ilan numarasına göre sıralanır; bir değişiklik ancak asıl ilan yayınlandıktan sonra gönderilebildiği için pratikte aynı güne düşmezler.
- Artımlı: günde 2 kez (pg-boss `sync-eu-ted`, `30 11,17 * * *`, İstanbul). Sabah baskısını öğlen, geciken baskıyı akşam alır. İlk çalışmada son 24 saat.
- Backfill: `pnpm backfill --source=eu_ted --days=30`. `pnpm renormalize --source=eu_ted` FaT'deki gibi.

### 4.3 Kurlar

ECB günlük referans kurları. `value_eur` hesaplanır; orijinal tutar ve para birimi korunur. Kod: `src/fx/`, `src/sources/value-eur.ts`. Örnekler: `tests/fixtures/ecb/`.

- Kaynak: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` (son gün) ve `eurofxref-hist-90d.xml` (son 90 gün). Anahtar gerekmez. Tabloda kur yoksa ya da en yeni kur 5 günden eskiyse 90 günlük dosya, aksi halde günlük dosya çekilir. `fx_rates` (date, currency) ile upsert edilir; aynı kur tekrar yazılmaz.
- Worker işi `fx-ecb`: her gün 18:30 İstanbul (ECB ~16:00 CET'te yayımlar) ve worker açılışında. Ardından `value_eur` doldurulur ve eşleştirme yeniden çalışır.
- Dönüşüm: ihalenin yayın gününün (Frankfurt takvimi) kuru, yoksa en fazla 10 gün önceki en yakın iş gününün kuru; tutar / 1 EUR karşılığı birim, 2 ondalık. EUR olduğu gibi kalır. Saklanan kur aralığından eski ilanlarda aralığın en eski kuru kullanılır. ECB'nin yayımlamadığı para birimleri (örneğin AED) için `value_eur` boş kalır.
- `value_eur` her senkronda yeni ya da güncellenen ihaleler ve hâlâ değeri olmayanlar için hesaplanır; `updated_at` değişmez.

## 5. Veri modeli

- `sources`: id (`uk_fat`, `eu_ted`), cursor, last_synced_at, last_error
- `raw_notices`: id, source, external_id, procedure_key, payload (jsonb) ya da payload_xml (text), sha256, fetched_at, applied_at. (source, external_id, sha256) tekil: aynı payload tekrar yazılmaz, değişen payload yeni satır olur. procedure_key ile bir prosedür ham veriden yeniden hesaplanabilir.
- `tenders`: id, source, external_id, procedure_key (tekilleştirme), notice_type, regime (`covered` | `below_threshold` | `utilities` | `defence` | `unknown`), contract_nature (`goods` | `services` | `works`, belirtilmemişse null), status (`open` | `closed` | `awarded` | `cancelled`), title, description, buyer_name, buyer_country, nuts_code, cpv_main, cpv_additional[], value_amount, value_currency, value_eur, published_at, submission_deadline, clarification_deadline, procedure_type, notice_language, notice_url, documents_portal_url, changed_at, created_at, updated_at
- `lots`: id, tender_id, lot_number, title, description, cpv, value_amount, value_currency, quantity_text
- `documents`: id, tender_id, origin (`auto` | `manual`), source_url, title, document_type, filename, mime, size_bytes, sha256, storage_path, page_count, text_content (DOCX / XLSX için), fetch_status (`pending` | `fetched` | `needs_manual` | `failed` | `unsupported`), fetch_error. Otomatik dokümanlarda (tender_id, source_url) tekil.
- `categories`: id, name, cpv_prefixes[], description. Profiller ve ileride üreticiler bu ortak taksonomiyi kullanır.
- `criteria_profiles`: id, name, active, rules (jsonb, şema bölüm 6), created_at, updated_at
- `profile_matches`: profile_id, tender_id, matched_at, filter_reasons (jsonb), triage_score, triage_analysis_id, state (`new` | `seen` | `dismissed`), unmatched_at (profil artık istemiyorsa; satır silinmez)
- `analyses`: id, tender_id, profile_id (opsiyonel), kind (`triage` | `deep`), model, prompt_version, document_ids[], output (jsonb), valid, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, created_at
- `tender_reviews`: id, tender_id, decision (`GO` | `REVIEW` | `NO_GO` | `WATCH` ya da boş), note, decided_by, decided_at. Append-only; son kayıt geçerli karardır, geçmiş görünür. Kararı geri almak, kararı boş yeni bir kayıt eklemektir.
- `fx_rates`: date, currency, rate_per_eur (1 EUR karşılığı birim), fetched_at. ECB referans kurları.

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

Eşleştirme kuralları (`src/matching/`):

- Motor saf fonksiyondur: `matchTender(tender, rules, { categories, now }) => { matched, reasons } | { matched: false, rejectedBy }`. Kurallar `profileRulesSchema` (Zod) ile doğrulanır.
- İlk kural kapsamdır: kapsam dışı ihale (bölüm 1) hiçbir profille eşleşmez, önizlemede "Kapsam dışı" sebebiyle sayılır, mevcut eşleşmesi `unmatched_at` ile biter.
- Boş liste filtre yok demektir (sources, noticeTypes, regimes, countries, noticeLanguages). Profil ayarlamadığı kural sebep eklemez.
- Sadece durumu `open` olan ihale eşleşir. Son tarihi geçmiş ihale eşleşmez; `minDaysToDeadline` doluysa kalan gün en az bu kadar olmalı. Son tarihi bilinmeyen ihale (planlama ilanları) bu kuraldan geçer.
- Tutar kuralı `valueMinEur` ya da `valueMaxEur` doluysa çalışır, sınırlar dahildir. Değer bilinmiyorsa `includeUnknownValue` belirler.
- `keywordsNone` eşleşirse ilan elenir.
- Konu kuralı: CPV eşleşmesi önek bazlıdır; ana CPV, ek CPV'ler ve lot CPV'leri birlikte kontrol edilir. `categoryIds` seçilirse kategorinin önekleri `cpvInclude`'a eklenir. `cpvExclude`'a uyan kodlar dahil etmede yok sayılır. CPV önekleri ve `keywordsAny` arasında VEYA vardır: biri tutması yeterli. İkisi de boşsa konu filtresi yoktur; yalnızca ihalenin bütün kodları hariç tutuluyorsa elenir.
- `keywordsAll`'daki kelimelerin hepsi geçmelidir.
- Anahtar kelimeler başlık, açıklama ve lot metinlerinde büyük/küçük harf ve aksan duyarsız, kelime sınırlarında aranır; son kelime çoğul ekiyle (s, es) de eşleşir ("hire", "Hampshire"ı tutmaz).
- Her eşleşme hangi kuralların tuttuğunu `filter_reasons` içinde saklar ve UI bunu gösterir.
- Eşleşme kayıtları hiç silinmez. İhale kapanınca, iptal edilince ya da sonuçlanınca eşleşme olduğu gibi kalır (gelen kutusunda varsayılan olarak gizlenir). Profil değişip ihale kriterlere artık uymuyorsa `unmatched_at` ile işaretlenir; durum, triage ve karar bağlantısı korunur, ihale yeniden eşleşirse işaret kalkar.
- Senkron sonrası eşleştirme sadece açık ihalelere bakar; bir profil kaydedilince o profilin mevcut eşleşmeleri (kapanmışlar dahil) yeniden değerlendirilir. Kapsam dışına düşen ihalenin eşleşmeleri ihale saklanırken biter (bölüm 1). Eşleştirme çalışmaları bir veritabanı kilidiyle sırayla yürür.
- Gelen kutusu aktif profillerin güncel eşleşmelerini ve son kararı GO, REVIEW ya da WATCH olan ihaleleri (eşleşmesi bitmiş ya da profili duraklatılmış olsa da) gösterir; profil filtresi seçilince sadece o profilin güncel eşleşmeleri. Belirli bir karar (GO, REVIEW, NO_GO, WATCH) filtrelenince o kararı taşıyan her ihale listelenir; karar verilmiş ihale kaybolmaz. "Değişti" etiketi, değişiklik son karardan yeniyse görünür.
- Canlı önizleme son 30 günde yayımlanan ihaleleri yayımlandıkları andaki durumlarıyla değerlendirir ("o gün bu profil olsaydı kaç ilan eşleşirdi") ve bunlardan bugün hâlâ teklif verilebilir olanların sayısını ayrıca gösterir; gelen kutusunda görünecek olan bu ikinci sayıdır.

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

### Faz 2: Profiller, eşleştirme, gelen kutusu

13 Ekim 2026'da kullanıcı kararıyla TED fazının önüne alındı: eşleştirme mevcut UK verisiyle denenir, TED sonra aynı gelen kutusuna akar.

- `categories` tablosuna bölüm 6'daki dört başlangıç kategorisi seed edilir.
- ECB günlük kurları (bölüm 4.3) çekilir ve `value_eur` hesaplanır (TED fazından öne alındı; tutar filtresi buna bağlı).
- Profil oluşturma ve düzenleme formu (Zod doğrulamalı) ve canlı önizleme.
- Eşleştirme motoru saf fonksiyon; her kural için en az bir pozitif ve bir negatif birim testi.
- Yeni ilan geldiğinde ve profil değiştiğinde yeniden eşleştirme.
- Gelen kutusu ve ihale detay sayfası (analiz alanları boş olsa da iskelet hazır).
- İnsan kararı ve not, geçmişiyle.
- Kabul: kullanıcı profil oluşturuyor, gelen kutusunda her eşleşmenin nedeni görünüyor, karar verip geri alabiliyor.

### Faz 3: AB veri hattı

- Faz 1'in aynısı TED için (`tests/fixtures/eu-ted/`, bölüm 4.2'ye gerçek eşleme).
- Prosedür bazında gruplama, alpha-3'ten alpha-2'ye ülke çevirisi; `value_eur` Faz 2'deki kur modülüyle hesaplanır.
- Kabul: Faz 1 ile aynı; ayrıca düzeltme ilanı gelen bir prosedür tek tender olarak kalıyor ve son tarih güncelleniyor.

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

- Her sabah 08:00 (İstanbul): yeni eşleşmeler (skora göre), son tarihine 7 gün kalan GO ve REVIEW ihaleler (eşleşmeden bağımsız, `tender_reviews`'taki son karara göre), "değişti" etiketli ihaleler.
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
