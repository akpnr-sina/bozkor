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

1. Dokümanların önemli bir kısmı alıcının e-ihale portalındadır (UK'de Proactis, Delta, In-Tend, Jaggaer, Atamis gibi; AB'de ulusal portallar) ve tedarikçi kaydı ister. Platform sadece herkese açık doğrudan dosya linklerini otomatik indirir. Diğerleri `needs_manual` durumuna düşer, portal linki gösterilir ve kullanıcı dosyaları elle yükler. 16 Ekim 2026 taramasında linklerin yalnız %2'si doğrudan dosya döndürdü; ana yol elle yüklemedir (bölüm 4.4).
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
  -> facts job (triage modeli, ilan metni): olgular, alıntılı (bölüm 7.0)
  -> assess (kod): yeterlilik politikası, lot bazında durum, puan aralıkları ve gerekçe
  -> translate job: ekibin gördüğü ilanların Türkçesi (bölüm 7.1a)
  -> teklif verilebilecek ihalelerde: fetch-documents job, saatte iki kez (bölüm 4.4);
     portal linkleri elle yüklenir; process-documents dosyaları okur (dakikada bir)
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
| details | Sözleşme detayları (`NoticeDetails`, ortak yardımcılar `src/sources/details.ts`). Süre: `tender.contractPeriod` ve `lots[].contractPeriod` (`durationInDays`, yoksa `startDate` ile `endDate` arası), en uzunu, ay olarak, uzatmalar hariç. framework `tender.techniques.hasFrameworkAgreement`, electronicOrdering `tender.contractTerms.hasElectronicOrdering`, gpaCovered `tender.coveredBy` içinde GPA (alan yoksa null). Ödül kriterleri `lots[].awardCriteria.criteria[]`: tür (price, quality, cost), ad, açıklama; ağırlık `numbers[].weight` koduna göre yüzdeye çevrilir, eski rejimde ağırlık açıklamadaki sayıdır. `weightingDescription` (örn. geçme puanı) türsüz son kriter olur. Lotlar aynı listeyi veriyorsa tek liste, yoksa lotların farklı kriterleri. Seçim kriterleri `tender.selectionCriteria` ve `lots[].selectionCriteria` (tür suitability, economic, technical); `otherRequirements.requiresStaffNamesAndQualifications` staffNamesAndQualifications kriteri olur. performanceTerms `tender.contractTerms.performanceTerms`, submissionLanguages `tender.submissionTerms.languages`. FaT teminat şartını vermez, guaranteeRequired hep null. Sonuç ilanlarında ve kısmi eski rejim düzeltmelerinde null |

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
- Sayfa boyutu: en fazla 250 ilan ve 10.000 alan. API alanı `limit × (alan sayısı + 1)` olarak sayar, çünkü her ilana `links` ekler. İstemci `limit` = min(250, floor(10.000 / (alan sayısı + 1))) kullanır: 62 alanla 158 (14 Ekim'de 45 alanla 217 geçti, 222 HTTP 400 `SEARCH_FIELDS_PER_PAGE_EXCEEDS_MAX_LIMIT` aldı). `fields.ts`'e alan eklenince limit kendiliğinden küçülür.
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
| documents | `document-url-lot` içindeki tekil http(s) linkler (`procurementDocuments` türüyle). Çoğu ulusal e-ihale portalının sayfası, doğrudan dosya değil. TED linkleri HTML-kaçışlı verir (`&amp;`, bazen iki kez); normalizer çözer, 17 Ekim 2026 öncesi kayıtları migration 0014 düzeltti |
| details | Sözleşme detayları (`NoticeDetails`). Süre: `duration-period-value-lot` ve `duration-period-unit-lot` (BT-36; DAY, WEEK, MONTH, YEAR) ya da `contract-duration-start-date-lot` ile `contract-duration-end-date-lot` arası (BT-536, BT-537); en uzun lot, ay olarak, uzatmalar hariç. framework: `framework-agreement-lot` (BT-765) içinde none dışında bir kod (fa-wo-rc, fa-w-rc, fa-mix). electronicOrdering `electronic-ordering-lot`, gpaCovered `gpa-lot` (BT-115), guaranteeRequired `guarantee-required-lot` (BT-751): herhangi bir lot evetse true. Ödül kriterleri: `award-criterion-type-lot` (BT-539), `award-criterion-name-lot` (BT-734), `award-criterion-description-lot` (BT-540), `award-criterion-number-lot` (BT-541) ve `award-criterion-number-weight-lot` (BT-5421: per-exa / per-mid yüzde, dec-exa / dec-mid ondalık, poi-exa / poi-mid puan, ord-imp önem sırası). Ağırlık yüzdeye çevrilir: ondalık ×100, puan lotun toplam puanına oranla, önem sırası null. Seçim kriterleri: `selection-criterion-lot` (BT-747 kodu, örn. slc-abil-ref-supply), açıklama `selection-criterion-name-lot` ve `selection-criterion-description-lot`. performanceTerms `term-performance-lot` (BT-70), HTML'den düz metne. submissionLanguages `submission-language`, iki harfe çevrilmiş. Bu alanların hiçbiri yoksa null |

Bilinen veri tuhaflıkları:

- Değişiklik ilanı tam ilandır: tüm alanları yeniden verir, kendi `notice-identifier`'ı ve `publication-number`'ı vardır. Zincir halinde gelebilir (her değişiklik bir öncekini gösterir, örn. Polonya 617868 -> 677176 -> 699928 -> 706847). Gruplama `procedure-identifier` ile olduğundan zincir tek ihalede toplanır, en son yayınlanan geçerlidir.
- Lot dizileri her zaman hizalı değil: `estimated-value-lot` 6 lotluk ilanda tek eleman gelebilir, `estimated-value-cur-lot` çoğunlukla tek eleman, `additional-classification-lot` düz liste. Hizalı olmayan alan lotlara dağıtılmaz.
- Tutarlar metin gelir ("109758.12", "0", "0.00").
- Aynı değer lotlarda tekrar edebilir (Malta 706732-2026: iki lotun ikisinde de prosedür toplamı). Yayınlandığı gibi saklanır; ihale değeri prosedür toplamından gelir.
- Tarih ve saat ayrı alanlardadır; ofsetsiz gelirse Brüksel saati kabul edilir.
- Nadiren son tarihi hiç olmayan çağrı ilanı gelir (13 Ekim'de 1/642); son tarihi bilinmediği için açık görünür.
- MDL (Moldova) gibi ECB'nin yayınlamadığı para birimlerinde value_eur boş kalır.
- `competition-termination-proc` (BT-756) eForms'a göre sadece sonuç ilanlarında bulunur, çekilmez.
- Ödül ve seçim kriterleri tüm lotlar için tek düz liste gelir, lota bağlanamaz. Her lot aynı listeyi tekrar ediyorsa (çok lotlu ilanlarda sık) tek liste kalır ve puanlar oranlanır; lotların listeleri farklıysa tekrarlar atılır, puanlar null kalır. Ad ve açıklama sadece kriter sayısı kadar eleman varsa eşlenir.
- Evet/hayır alanları (`electronic-ordering-lot`, `gpa-lot`, `guarantee-required-lot`) bazen boolean, bazen "true" / "false" metni olarak gelir. `term-performance-lot` bazı ilanlarda (Hırvatistan) HTML etiketleriyle gelir.
- 15 Ekim'de 250 ilanlık örnekte `contract-conditions-description-lot` hiç, `quantity-lot` 5 kez geçti; ikisi de çekilmez. `contract-duration-period-oth-lot` (UNKNOWN, UNLIMITED) da çekilmez, süre null kalır.

Bilinen eksikler:

- Planlama ilanı (PIN) ile sonraki çağrı ilanı bağlanmaz (çağrıların ~%3'ü `previous-planning-identifier-lot` ile bir PIN'i gösterir); ikisi de varsa gelen kutusunda ayrı kayıt olurlar.
- Bir planlama ilanının ikinci değişikliği birinci değişikliğe işaret ettiğinden ayrı ihale olur (2 haftada 11 PIN değişikliği, zincir yok).
- Profil anahtar kelimeleri ilanın dilinde aranır; TED ilanlarının ~%95'i İngilizce değil, orada eşleşme fiilen CPV'ye dayanır.

Birleştirme ve senkron:

- Birleştirme FaT ile aynı kurallarla (`fold.ts`). TED yayın tarihi gün olduğundan aynı gün yayınlanan iki ilan ilan numarasına göre sıralanır; bir değişiklik ancak asıl ilan yayınlandıktan sonra gönderilebildiği için pratikte aynı güne düşmezler.
- Artımlı: günde 2 kez (pg-boss `sync-eu-ted`, `30 11,17 * * *`, İstanbul). Sabah baskısını öğlen, geciken baskıyı akşam alır. İlk çalışmada son 24 saat.
- Backfill: `pnpm backfill --source=eu_ted --days=30`. `pnpm renormalize --source=eu_ted` FaT'deki gibi.
- `pnpm enrich-ted`: `TED_FIELDS`'e sonradan eklenen alanlar (örn. sözleşme detayları) eski ham kayıtlarda yoktur ve renormalize bunları getiremez. Komut, güncel eşleşmesi (unmatched_at boş) ya da kararı olan TED ihalelerinin tüm ilanlarını `publication-number IN (...)` sorgusuyla 100'erli gruplar halinde yeniden çeker (15 Ekim'de 100 numara tek sayfada geldi), yeni payload'ları ham kayıt olarak ekler ve bu prosedürleri yeniden hesaplar. Birleştirme her ilanın en son çekilen payload'ını okur. changed_at basmaz; tekrar çalıştırınca bir şey yazmaz. Tüm ham kayıtları yeniden çekmek yerine sadece ekibin gördüğü ihaleler zenginleştirilir.

### 4.4 Dokümanlar (Faz 5)

16 Ekim 2026 taraması: eşleşen ihalelerin 191 doküman linki 129 siteye gidiyor; yalnız 4'ü (FaT ve enarocanje.si) doğrudan dosya döndürüyor, kalanı e-ihale portalı sayfası, çoğu girişli. 17 Ekim 2026 ekip kararı: kurumların girişsiz indirilebilir koyduğu dokümanlar da otomatik çekilir; herkese açık bir portal sayfasının listelediği doküman linkleri izlenir. Giriş, form doldurma, captcha ve JS challenge yoktur; robots.txt'e ve portalın kullanım şartlarına uyulur (kural 1). robots.txt kullanım şartlarını söylemediği için sayfa izleme, şartları elle okunup izin verdiği görülen portallarla sınırlıdır (`src/documents/hosts.ts`, `FOLLOW_LINKS_HOSTS`). Şartları otomatik erişimi yasaklayan portallara hiç istek gitmez (`NO_AUTOMATION_HOSTS`). Diğer linklere ilanın davet ettiği tek istek gider. Giriş isteyen portallar için yol elle yüklemedir.

Kullanım şartları incelemesi (17 Ekim 2026):

| Portal | Karar | Dayanak |
| --- | --- | --- |
| ausschreibungen.giz.de (cosinex) | sayfa izlenir | AGB §2(1) "Vergabeunterlagen registrierungsfrei herunterladen"; §4(1) yalnız kendi bilgilenme ve katılım, §7(3) iç kullanım. Otomatik erişimden söz yok |
| platformazakupowa.pl | hiç istek yok | OWŚUW (8 Mayıs 2026) §3 ust. 7 otomatik içerik çekme, scraping ve crawling yasak (API hariç); §5 ust. 4 eklerin sistematik indirilmesi yasak; §7 ust. 8 otomatik erişim araçları yasak |
| evergabe-online.de (Bund) | yalnız ilan linki | Nutzungsbedingungen (22.05.2020): otomatik erişimden söz yok; §(IX) dokümanları yetkisiz üçüncü kişilere vermek yasak. Ama 18 Ekim denemesinde oturum her istekte sıfırlandı ve indirme linkleri yalnız tarayıcının gönderdiği bilgileri istedi (önde bir güvenlik duvarı, Wicket denetimleri); tarayıcı taklidi kural 1'in dışında olduğundan sayfa izlenmez |
| evergabe.nrw.de (cosinex) | sayfa izlenir | Nutzungsbedingungen VMP NRW: ücretsiz, kayıt gönüllü (§(I)); §(X) dokümanları üçüncü kişilere vermek yasak |
| deutsche-evergabe.de | hiç istek yok | Kayıtsız kullanıcı şartları (Nisan 2016) §4(a): yalnız kendi aramasında kullanım; ticari değerlendirme, bilgi dizini, çoğaltma ve işleme yasak |
| dtvp.de | yalnız ilan linki | AGB (Nisan 2026) §(III): kendi bilgilenme ve katılım serbest; kendi ticari hizmetini sunmak ya da zenginleştirmek için sistematik çekme yasak. Belirsiz, sayfa izlenmez |
| vergabemarktplatz.brandenburg.de | robots.txt kapalı | `User-agent: * Disallow: /` |
| enarocanje.si | yalnız ilan linki | Splošni pogoji (v7, 10.01.2026) 12. madde: içeriği MJU'nun yazılı izni olmadan çoğaltmak ya da başka şekilde kullanmak yasak; kayıtsız inceleme serbest. Kullanıcı kararı (18 Ekim 2026): ilanın kendi doğrudan dosya linki, yalnız kendi teklif kararımız için otomatik indirilmeye devam eder; sayfa izlenmez |

Araştırma (TED'in 200 mal ilanı): otomatik açılabilen portallar ilanların ~%10'u; robots.txt'in yasakladıkları (ekr.gov.hu, uvo.gov.sk, eojn.hr, achatpublic, contrataciondelestado) ~%11; JS uygulaması olup resmi API adayı olanlar (e-licitatie.ro, ezamowienia.gov.pl, app.eop.bg, tenderned.nl, publicprocurement.be, vortal) ~%18. Resmi API'ler kural 1'e açıkça uygun olduğundan sonraki adım adaptörlerdir (kullanıcı kararı, 18 Ekim 2026: Faz 5 kabulünden sonra).

- İndirme (`src/documents/fetch.ts`, `fetch-job.ts`; worker işi `fetch-documents`, saatte iki kez, çalıştırma başına 30 link):
  - Hangi linkler: açık ihalelerden ya aktif bir profilin güncel eşleşmesi olan, değerlendirmesi "Ticari olarak uygun değil", "Teklif verilemez", "Kesin ret", "Süresi doldu" ya da "İzle" olmayan ve son kararı NO_GO olmayanlar, ya da son kararı GO, REVIEW veya WATCH olanlar. Son tarihi en yakın olan önce. Kapsam dışı ihalenin linki için kart "otomatik indirme kapsamında değil" der.
  - İstek: GET; kimliğini ve iletişim adresini söyleyen User-Agent; giriş yok. Sitelerin anonim ziyaretçiye verdiği çerezler bir çalıştırma boyunca tutulur (çerezle kendine yönlendiren portallar için). Yönlendirmeler elle izlenir (en fazla 10). Yerel ağ adresleri ve kullanıcı adı ya da parola içeren linkler istenmez. Aynı siteye istekler en az 2 sn arayla; yönlendirmeler ve gövde dahil tek zaman aşımı 60 sn.
  - Bekçi: her istekten önce (ilk adres ve her yönlendirme hedefi) sorulur. Kullanım şartları otomatik erişimi yasaklayan portala, robots.txt'in kapattığı adrese ve robots.txt'i o an okunamayan siteye istek gitmez; izin verilen istek de sitenin sırasını bekler. Böylece bir yönlendirme yasak listesini, robots.txt'i ya da hız sınırını atlatamaz.
  - robots.txt (`src/documents/portal.ts`): her istek, ilan linkleri dahil, sitenin robots.txt'ine uyar ("BozkorTenderBot", yoksa "*" grubu; en uzun eşleşme). Site başına bir kez okunur, 24 saat geçerli; 4xx izin sayılır. Okunamazsa (429, 5xx, zaman aşımı) link bir saat sonra yeniden denenir (deneme sayılır, en fazla 3), robots.txt'in kapattığı ilan linki "Site otomatik erişime kapalı (robots.txt)" notuyla elle yüklemeye kalır.
  - Portal sayfaları (izin listesindeki portallar; karar yönlendirme sonrası varılan adrese göre verilir, her link de izin listesindeki bir portalda olmalı): sayfanın listelediği doküman linkleri çıkarılır (uzantı, çok dilli indirme kelimeleri ve yol kalıpları; menü, üst ve alt bilgi hariç; aynı site; en fazla 30). Sayfa üst bilgisinde giriş formu olsa da linkler izlenir; birçok portal dosyaları yine herkese açık verir. Her link robots.txt ve host aralığına uyarak, sayfayla aynı çalıştırmada ve aynı çerezlerle istenir (bazı portalların linkleri oturumla yaşar); bir seviyeden derine inilmez. Okunan türde dosya sayfanın altına (`parent_document_id`) aynı içerik ve bütçe kurallarıyla depolanır; okunmayan tür "Okunmuyor" diye listelenir; sayfalar ve hatalar atlanır.
  - Bir çalıştırmada sayfa başına en fazla 20, toplam 60 dosya alınır. Sınır, dolu depo ya da okunamayan robots.txt bir sayfayı keserse sayfa "Portaldan alınıyor" olarak kalır ve sonraki çalıştırma kaldığı yerden devam eder (bilinen linkler atlanır). Sonuna kadar okunan sayfanın `processed_at`'i dolar ve "Portaldan alındı" (ya da dosya yoksa "Portalda") olur; sonradan eklenen dokümanlar için yeniden tarama yoktur. İzin listesinde olmayan portalların sayfaları okunmuş sayılmaz: portal ileride listeye eklenirse sayfaları o zaman okunur. Linklerinin hepsi dosya yerine sayfa ya da hata dönen sayfa (portalın geçici sorunu ya da izlemediğimiz bir akış) hemen kapanmaz: ertesi gün yeniden denenir, üç denemeden sonra elle yüklemeye kalır.
  - Sınıflama: tür önce ilk baytlardan (PDF; ZIP içinde DOCX ve XLSX parça adlarından, merkezi dizinden), sonra addan. Okunan türde dosya `fetched` olur ve depoya yazılır. Portal sayılan link `needs_manual` olur: HTML sayfası (giriş formu ayrıca belirtilir), çerezle kendine dönen ya da 10 adımı aşan yönlendirme, 401 ve 403 (giriş) ve tarayıcı dışı isteği reddeden diğer 4xx yanıtları. 404 ve 410 "Dosya bulunamadı" olarak `failed`. Başka türde dosya (resim, CAD, eski .doc, PowerPoint, OpenDocument) `unsupported`, 50 MB üstü `failed` olur. 17 Ekim'deki ilk canlı turda bu kurallardan önce `failed` sayılan linkler migration 0015 ile yeniden denendi. URL'den gelen ad türle uyuşmuyorsa uzantı düzeltilir ("FileDownload.aspx" olan bir PDF "FileDownload.pdf" olur).
  - Yeniden deneme: zaman aşımı, ağ hatası, 408, 429 ve 5xx en fazla 3 deneme. Sonraki deneme (`retry_at`) en erken 6 saat ya da sunucunun Retry-After'ı kadar sonra, en çok 7 gün. 429 ya da 503 dönen sitenin bekleyen bütün linkleri aynı süre bekler (deneme sayılmadan, notla). Diğer hatalar doğrudan `failed`.
  - Sahiplenme: her doküman indirilmeden ya da okunmadan önce 15 dakikalığına atomik olarak sahiplenilir (`retry_at`, hata notu olmadan). Worker'ın yanında elle çalıştırılan `pnpm documents` aynı dosyayı ikinci kez işlemez; ölen bir çalıştırmanın sahiplendiği dosya 15 dakika sonra serbest kalır.
- Depolama: Supabase Storage, özel kova (`SUPABASE_STORAGE_BUCKET`, dosya başına 50 MB).
  - Yol `<tender_id>/<sha256>.<uzantı>`: aynı içerik ihale başına bir kez durur, tekrar indirilmez ya da yüklenmez.
  - Sınırlar: dosya 50 MB, ihale 200 MB, toplam 950 MB (ücretsiz plan 1 GB). Her dosya kalan yer kadarıyla istenir; sığmayan baştan reddedilir. İhalenin alanı dolduysa link başarısız sayılır; depo dolduysa link 24 saat sonra yeniden denenir ve yükleme de reddedilir. Depoda 5 MB'tan az yer varken portal sayfası taranmaya başlanmaz.
  - Kovaya yalnız gizli anahtarla (sunucu ve worker) erişilir. Tarayıcı tek kullanımlık imzalı linkle yükler, iki dakikalık imzalı linkle indirir (`/documents/[id]`).
- Okuma (`src/documents/extract.ts`, `process-job.ts`; worker işi `process-documents`, dakikada bir, önce elle yüklenenler):
  - İçerik kaydedilen SHA-256 ile karşılaştırılır; uyuşmazsa "yeniden yükleyin" denir.
  - PDF: sayfa sayısı ve sayfa sayfa metin (sayfalar `\f` ile ayrılır). DOCX: paragraflar. XLSX: her sayfa başlıkla, satırlar sekmeyle ayrılmış. Dosya başına en fazla 300.000 karakter (`text_truncated`).
  - ZIP: üyeler kendi doküman satırları olur (`parent_document_id`, ZIP'in kaynağıyla). Klasörler ve işletim sistemi artıkları sessizce, şifreli ya da sınırı aşan üyeler notla atlanır. ZIP içindeki ZIP bir kez daha açılır, daha derini açılmaz. Sınırlar açmadan önce dizinden kontrol edilir; boyutu yalan söyleyen üye açılmaz.
  - Parolalı ya da bozuk PDF ve metni olmayan (taranmış olabilecek) PDF notla işaretlenir. NUL ve diğer kontrol karakterleri metinden ve adlardan atılır (Postgres NUL kabul etmez). Kaydedilen boyut okunan dosyanınkidir.
  - Depo hataları ve beklenmeyen hatalar 10 dakika arayla 3 kez denenir, sonra dosya "Okunamadı" notuyla kapanır; hiçbir dosya sonsuza dek okunmaz. Okuma sürerken ihale sayfası 5 dakikaya kadar 20 saniyede bir kendini yeniler.
- Elle yükleme (ihale detayı): sürükle bırak ya da dosya seç; PDF, DOCX, XLSX ve ZIP, dosya başına 50 MB.
  - Tarayıcı SHA-256'yı hesaplar. Sunucu ihalede aynı içerik varsa "zaten var" der, yoksa tek kullanımlık yükleme linki verir; dosya doğrudan kovaya gider, sonra kaydedilir (`src/documents/manual.ts`). Ad reddedilmez, temizlenir (son yol parçası, en çok 200 karakter).
  - Sınırlar kayıt anında ihale başına kilit altında yeniden kontrol edilir: aynı anda planlanan iki bırakma son boşluğu birlikte alamaz; sığmayan dosya reddedilir ve nesnesi silinir.
  - Üst düzey yüklenen dosya ZIP'ten çıkanlarla birlikte silinebilir (üyeler tek tek silinmez). Başka satırın kullanmadığı depo nesnesi, silmeden hemen önce yeniden bakılarak silinir. İlan linki aynı ZIP'i döndürdüyse ZIP'ten çıkanlar ona geçer, silinmez. İlandan gelen satırlar silinmez. Depo ayarsızken silme yapılmaz.
- Derin analiz girdisi (Faz 6): depoda, okunmuş, PDF, DOCX ya da XLSX olan, sayfası ya da metni olan dosyalar; aynı içerik bir kez. ZIP'in kendisi girmez, üyeleri girer. Metinsiz PDF girer (model sayfaları görüntü olarak okur) ama alıntıları doğrulanamaz.
- Olgu aşaması (bölüm 7.0.1) yalnız ilanın verdiği linklerin açıklamalarını okur; yüklenen dosyalar ve ZIP üyeleri ilan girdisini ve değerlendirmenin "eskidi" kontrolünü değiştirmez.

### 4.3 Kurlar

ECB günlük referans kurları. `value_eur` hesaplanır; orijinal tutar ve para birimi korunur. Kod: `src/fx/`, `src/sources/value-eur.ts`. Örnekler: `tests/fixtures/ecb/`.

- Kaynak: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` (son gün) ve `eurofxref-hist-90d.xml` (son 90 gün). Anahtar gerekmez. Tabloda kur yoksa ya da en yeni kur 5 günden eskiyse 90 günlük dosya, aksi halde günlük dosya çekilir. `fx_rates` (date, currency) ile upsert edilir; aynı kur tekrar yazılmaz.
- Worker işi `fx-ecb`: her gün 18:30 İstanbul (ECB ~16:00 CET'te yayımlar) ve worker açılışında. Ardından `value_eur` doldurulur ve eşleştirme yeniden çalışır.
- Dönüşüm: ihalenin yayın gününün (Frankfurt takvimi) kuru, yoksa en fazla 10 gün önceki en yakın iş gününün kuru; tutar / 1 EUR karşılığı birim, 2 ondalık. EUR olduğu gibi kalır. Saklanan kur aralığından eski ilanlarda aralığın en eski kuru kullanılır. ECB'nin yayımlamadığı para birimleri (örneğin AED) için `value_eur` boş kalır.
- `value_eur` her senkronda yeni ya da güncellenen ihaleler ve hâlâ değeri olmayanlar için hesaplanır; `updated_at` değişmez.

## 5. Veri modeli

- `sources`: id (`uk_fat`, `eu_ted`), cursor, last_synced_at, last_error
- `raw_notices`: id, source, external_id, procedure_key, payload (jsonb) ya da payload_xml (text), sha256, fetched_at, applied_at. (source, external_id, sha256) tekil: aynı payload tekrar yazılmaz, değişen payload yeni satır olur. procedure_key ile bir prosedür ham veriden yeniden hesaplanabilir.
- `tenders`: id, source, external_id, procedure_key (tekilleştirme), notice_type, regime (`covered` | `below_threshold` | `utilities` | `defence` | `unknown`), contract_nature (`goods` | `services` | `works`, belirtilmemişse null), status (`open` | `closed` | `awarded` | `cancelled`), title, description, buyer_name, buyer_country, nuts_code, cpv_main, cpv_additional[], value_amount, value_currency, value_eur, published_at, submission_deadline, clarification_deadline, procedure_type, notice_language, notice_url, documents_portal_url, details (jsonb: süre, çerçeve anlaşma, elektronik sipariş, GPA, ödül ve seçim kriterleri, teminat, ifa şartları, teklif dilleri; ilanlar belirtmiyorsa null; eşleme bölüm 4.1 ve 4.2), changed_at, created_at, updated_at
- `lots`: id, tender_id, lot_number, title, description, cpv, value_amount, value_currency, quantity_text
- `documents`: id, tender_id, origin (`auto` | `manual`), source_url, title, document_type, filename, mime, size_bytes, sha256, storage_path, page_count, text_content (PDF sayfaları `\f` ile ayrılır; DOCX / XLSX metni), text_truncated, fetch_status (`pending` | `fetched` | `needs_manual` | `failed` | `unsupported`), fetch_error, fetch_attempts, retry_at, parent_document_id (ZIP üyesinin ZIP'i; ZIP silinince silinir), processed_at (dosya okununca ya da okunamaz bulununca). Otomatik dokümanlarda (tender_id, source_url) tekil. İlanın linki: origin `auto` ve source_url dolu; otomatik ZIP'in üyesi auto ama linksiz (bölüm 4.4).
- `categories`: id, name, cpv_prefixes[], description. Profiller ve ileride üreticiler bu ortak taksonomiyi kullanır.
- `criteria_profiles`: id, name, active, rules (jsonb, şema bölüm 6), triage_inputs_changed_at, created_at, updated_at
- `profile_matches`: profile_id, tender_id, matched_at, filter_reasons (jsonb), triage_score, triage_analysis_id, state (`new` | `seen` | `dismissed`), unmatched_at (profil artık istemiyorsa; satır silinmez)
- `analyses`: id, tender_id, profile_id (opsiyonel), kind (`triage` | `deep` | `translation` | `facts`), model, prompt_version, document_ids[], output (jsonb), valid, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, created_at
- `tender_reviews`: id, tender_id, decision (`GO` | `REVIEW` | `NO_GO` | `WATCH` ya da boş), note, decided_by, decided_at. Append-only; son kayıt geçerli karardır, geçmiş görünür. Kararı geri almak, kararı boş yeni bir kayıt eklemektir.
- `fx_rates`: date, currency, rate_per_eur (1 EUR karşılığı birim), fetched_at. ECB referans kurları.
- `tender_assessments`: tender_id (birincil anahtar), facts_analysis_id, policy_version, status (bölüm 7.0.2), best_lot, explanation, blocking[] (takılan kapılar), fit_low, fit_high, preliminary_low, preliminary_high, confidence, assessed_at, status_changed_at. İhale başına yeterlilik politikasının güncel kararı; elenen ihaleler de kalır.
- `assessment_history`: id, tender_id, facts_analysis_id, policy_version, status, best_lot, explanation, blocking[], created_at. Durum, lot ya da politika sürümü her değiştiğinde bir satır (kalibrasyon için).

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

### 7.0 Yeterlilik politikası

Değerlendirme çerçevesi Bozkor'un yeterlilik politikasıdır: `docs/qualification-policy-v1.md` (15 Ekim 2026). İlk deneme olan rubrik V2'de (`docs/scoring-rubric-v2.md`) ekip, yüksek puanlı ihalelerin elle kontrolde Bozkor'a uymadığını gördü; aynı gün bu politikaya geçildi.

Mimari (politika bölüm XII): olgu çıkarma ile puanlama ayrıdır.

- Olgular (AI): model ilanı okur ve ne yazdığını alıntıyla söyler. Puan ya da karar vermez; ilan bir konuda sessizse olgu UNKNOWN kalır ("sessizlik kanıt değildir").
- Politika motoru (kod, `src/policy/`): olgular, kodun bildiği değerler (EUR tutar, son tarih, ülke, ilanın yapılandırılmış alanları) ve yapılandırılabilir politika (`src/policy/policy.ts`, sürüm `policy.v1`) girer; her lot için puanlar, kapılar, durum, Türkçe gerekçe ve sonraki adımlar çıkar. Saf fonksiyon: `assessTender(input, policy)`.

#### 7.0.1 Olgular

Model `LLM_TRIAGE_MODEL`, prompt `prompts/facts.v5.md` (v1-v4 ilan metnine göreydi), şema `src/analysis/facts-schema.ts`, girdi `src/analysis/facts-input.ts`, iş `src/analysis/facts.ts`, alıntı kontrolü `src/analysis/facts-evidence.ts`.

- Girdi: triage ile aynı ilan düzeni (bilgiler, başlık, açıklama, lotlar), yapılandırılmış ayrıntı satırları (süre, çerçeve anlaşma, elektronik sipariş, GPA, teminat, teklif dilleri, değerlendirme kriterleri) ve alıntılanabilir bölümler: seçim kriterleri, ifa koşulları ve doküman açıklamaları (bazı alıcılar şartnameyi buraya yazar, ör. FaT 096535). Profil girmez; olgular ihale başına bir kez çıkarılır.
- Dosyalar (facts.v5, 17 Ekim 2026 ekip kararı): ihalenin analize giren dosyalarının metni de girer (bölüm 4.4: ZIP'ten çıkanlar, portaldan çekilenler, elle yüklenenler; aynı içerik bir kez). `selectFactsFiles` önce elle yüklenenleri, sonra doküman türünü (şartname önce), sonra addaki rolü (şartname, teklif talimatı, sözleşme, fiyat cetveli; çok dilli) sıralar. Sınırlar: en fazla 12 dosya, dosya başına 60.000, toplam 240.000 karakter (Kiril ve Yunan metin iki kat sayılır), PDF tam sayfalarla. Bölüm `</ilan>`'dan sonra `<dosyalar>`; PDF sayfaları `<sayfa no>` ile. Alıntı kaynağı `file:<n>:p<k>` (PDF sayfası) ya da `file:<n>`; okunan dosyaların kimlikleri sırasıyla `analyses.document_ids`'e yazılır ve detay sayfası kaynağı "dosya adı, sayfa k" olarak gösterir. Dosyasız girdi v4 ile bayt bayt aynıdır.
- Çıktı: her lot için ürün (Türkçe), Bozkor kategorisi (politika bölüm III, 16 kod), alınan şeyin türü (mal, hizmet, yapım, mal ve bağlı hizmet), ürün niteliği (standart, özel üretim, uzmanlık isteyen) ve miktar türü; ihale düzeyinde kurulum, sahada devreye alma ve eğitim, yerinde servis (her biri geçtiği lotların listesiyle; listede olmayan lot için bilinmiyor sayılır), garanti yılı (açıkça istenmiyorsa 0), teslimat düzeni ve noktaları, süre, çerçeve anlaşma, marka şartı, belgeler (istekli, üretici, ürün, projeye özel), referans ve ciro şartı, numune, saha ziyareti, kontrole tabi ürün, değerlendirme yöntemi ve bilinmeyenleri çözecek dokümanlar. Her olgu birebir alıntıyla.
- Alıntılar yanıt geldiği anda modelin okuduğu metinde aranır ve sonuç yanıtla saklanır (kural 5). Alıntısı bulunamayan olgu sayfada "doğrulanmadı, kararda kullanılmadı" görünür; motor onu bilinmiyor sayar. Yapılandırılmış alanlar (süre, çerçeve, değerlendirme kriterleri, teklif dili, GPA) motora doğrudan `tenders.details`'ten gelir ve modelin okumasına göre önceliklidir.
- Bekleyen ihaleler: aktif bir profilin güncel eşleşmesi olan açık ihaleler ve kararı verilmiş her ihale (kalibrasyon için); güncel prompt sürümünden yanıt yoksa ya da ihale, olgular için okunduktan sonra yeniden yazıldıysa (`updated_at`: yeni ilan, `renormalize`, `enrich-ted`) ya da dosyaları değiştiyse (`documents_changed_at`: metni olan bir dosya okundu ya da bir dosya silindi). Depoda okunmayı bekleyen dosyası olan ihale beklenir ve dosyalar değiştikten sonra 5 dakika geçmesi beklenir, böylece bir ZIP ya da portal partisi tek çağrıda okunur. Detay sayfasının "olgular yeniden çıkarılmak üzere sırada" notu aynı sorguyu kullanır. Okuma anı yanıtla birlikte `inputUpdatedAt` olarak saklanır, model yanıt verirken gelen yazma da kaçmaz. Hata sonrası bir saatlik bekleme, dosyaları son denemeden sonra değişen ihaleyi tutmaz: yeni yüklenen dosya birkaç dakikada değerlendirmeye yansır. Doküman açıklamaları önce şartname ve ihale dokümanları gelecek sırayla okunur. Kayıt `analyses`'e (kind `facts`, profil yok), maliyetiyle (kural 7). Geçersiz yanıt bir kez tekrar denenir (kural 6); lotlar girdiyle birebir ve aynı sırada olmalı. Efor "medium", sınır 16.000 token. Olgu şeması API'nin çıktı dilbilgisi için fazla büyük ("compiled grammar is too large", 16 Ekim 2026): istek çıktı biçimi göndermez, şema JSON Schema olarak sistem promptunun sonuna eklenir ve yanıt kodda Zod ile doğrulanır; kod bloğuna sarılı yanıt da okunur.
- Worker işi `facts` 10 dakikada bir en fazla 200 ihale işler, aylık bütçe dolunca durur; başarılı her turdan sonra değerlendirme çalışır. `pnpm facts [--limit=50] [--tender=<id>] [--notice=<ilan no>,...]` elle çalıştırır ve seçilen ihalelerin kararını yazdırır.
- Maliyet: Haiku 5.5 ile ihale başına yaklaşık 0,002 USD; dosyalarla yaklaşık 0,01 USD (en kötü girdi ~100k token).
- `tenders.details` zenginleştirmesi (`pnpm enrich-ted`, `renormalize`) `changed_at` basmaz ama ihaleyi yeniden yazar; olgular bir sonraki turda yeniden çıkarılır. Tüm ihaleleri `renormalize` etmek, eşleşen ihalelerin olgularını yeniden çıkartır (ihale başına ~0,002 USD). Worker işi `enrich-ted` her gün 05:45'te ayrıntısı eksik eşleşmiş TED ihalelerini zenginleştirir.
- `pnpm facts --notice` FaT ve TED aynı numara biçimini kullandığı için `fat:` ya da `ted:` öneki alır; iki kaynakta da olan öneksiz numara işlenmez.

#### 7.0.2 Politika motoru

- Lot bazında değerlendirme (bölüm XII.1): her lot kendi ürünü, kategorisi ve değeriyle değerlendirilir; ihale en umut verici lotunun durumunu alır.
- Sekiz boyut (bölüm V.2: A 15, B 15, C 15, D 20, E 15, F 10, G 5, H 5) ölçütlerden oluşur. Bilinmeyen ölçüt aralık verir: alt sınır en kötü, üst sınır en iyi durum. Üç puan: fırsat uyumu (A, C, F), teklif hazırlığı (B, G), ticari uygunluk (D, E); ayrıca 100 üzerinden ön puan ve güven (bilinen ağırlığın oranı). Üretici veritabanı (Faz 8), marj ve nakit planı henüz yok; bu ölçütler bilinmiyor sayılır.
- Kapılar (bölüm VI): H01-H05 kesin, C01-C09 koşullu; her biri PASS, FAIL, UNKNOWN ya da NOT_APPLICABLE. Bilinmeyen ne başarısız ne başarılı sayılır. H03 ve H05 yalnız doğrulanmış bir şart kalan sürede karşılanamıyorsa başarısız olur: örneğin zorunlu yerinde servis var, o ülkede ortak yok ve son tarihe 10 iş gününden az kaldı. H03 için doğrulanmış sayılan: Bozkor'un kendi referansı olmaması ve elinde olmayan istekli belgesi. Ciro şartı tutar karşılaştırılmadığı için yalnız yeterlilik incelemesine gönderir.
- Yerel yükümlülük: sahada kurulum ve yerinde servis; devreye alma ve eğitim yalnız bunlarla birlikte ya da uzmanlık isteyen üründe (tek başına uzaktan ya da üretici tesisinde verilebilir; puana ve sonraki adıma girer).
- Çıkarım karar vermez: teslimat düzeni yazmayan ama elektronik siparişli uzun sözleşme yalnız puana ve gerekçeye "tekrarlanan siparişlere işaret ediyor" olarak girer; durum doküman gerekli kalır.
- Yalnızca teslim (ekip kararı, 16 Ekim 2026; `supplyOnly`, policy.v2): sahada kurulum, yerinde servis ya da bakım, sahada devreye alma ya da eğitim isteyen lot, ortak ve süre ne olursa olsun "Ticari olarak uygun değil" olur; gerekçe "ürün teslimine ek olarak ... istiyor" der. Basit montaj (`MINOR`) da şimdilik eler (policy.v3, `allowMinorAssembly`). Anahtar kapatılırsa aşağıdaki ortak kuralları (yerel ortak gerekli, süre yetmiyorsa teklif verilemez) devreye girer.
- Durum sırası: süresi doldu (H01), kapsam dışı (lot hizmet ya da yapım alımı: "Kesin ret"; ilanın sözleşme türü mal dese de), yalnızca teslim kuralı, teklif verilemez (H03, H05), ticari olarak uygun değil (bölüm I örneklerinin kuralları: 12 aydan uzun, düşük tutarlı sözleşmede yerinde servis; 12 aydan uzun sözleşmede ilanda yazan tekrarlı küçük siparişler ya da garantisiz çerçeve, aylık ortalama 2.000 EUR altı; düşük tutarlı sözleşmede sahada kurulum, uzmanlık isteyen ekipman hariç), yeterlilik incelemesi (referans, ciro ya da Bozkor'da olmayan istekli belgesi şartı; kontrole tabi ürün), yerel ortak gerekli, izle (fırsat uyumu düşük), doküman gerekli (kurulum, servis, referans, garanti ya da teslimat düzeninden biri bilinmiyor), üretici bulunmalı. Kısa liste ve teklif incelemesi, üretici ve doküman doğrulaması geldiğinde (Faz 6, 8) ulaşılabilir olur; motor hiçbir zaman teklif onayı vermez (bölüm X).
- Her durumun somut Türkçe gerekçesi (tutar, süre, ülke, şart) ve final olmayan durumlarda sonraki adımları vardır (bölüm XII.4, XII.5).
- Yapılandırma: sermaye, değer segmentleri, düşük tutar sınırı (35.000 EUR), uzun sözleşme (12 aydan uzun), aylık asgari gelir, marj hedefi, asgari mutlak katkı, teklif hazırlama ve ortak bulma süreleri, servis ortağı olan ülkeler, Bozkor'un kendi referans ve belge durumu, çalışma dilleri, ağırlıklar ve bantlar. Bir değer değişince sürüm artar ve sonraki değerlendirmede tüm ihaleler yeniden değerlendirilir.
- Regresyon testleri politika bölüm I ve IX'un altı gerçek ilanıyla: `src/policy/engine.test.ts`, fixture'lar `tests/fixtures/eu-ted/ted-policy-*` ve `tests/fixtures/uk-fat/uk4-policy-*`.

#### 7.0.3 Saklama ve gösterim

- Worker işi `assess` 15 dakikada bir ve her olgu turundan sonra olgusu olan her ihaleyi değerlendirir: süre geçtikçe durum değişebilir, yeni politika sürümü her şeyi yeniden değerlendirir. LLM işleri turda en fazla 60 ihale işler; kuyruklarda 60 saniyelik kalp atışı var, durdurulan worker'ın yarım kalan işi bir dakikada serbest kalır. Anthropic kredisi bitince çalıştırma ilk hatada durur ve logda Türkçe uyarı çıkar. Yazanlar işlem düzeyinde danışma kilidiyle sıraya girer (worker ve komut satırı aynı anda çalışabilir); bir ihalede hata diğerlerini durdurmaz; en son olgusu okunamayan ihalenin kararı kaldırılır. `tender_assessments` ihale başına güncel kararı tutar ve yalnız değişince yazılır; durum, lot ya da politika sürümü değişince `assessment_history`'ye satır eklenir (bölüm XII.6). `pnpm assess [--dry-run]` elle çalıştırır.
- Puan gösterimi: tek sayı, aralığın ortası (beklenen puan); aralık detayda küçük, gelen kutusunda üzerine gelince görünür. Gerekçeler "fırsat uyumu yaklaşık N" der.
- Gelen kutusu: durum rozeti ve beklenen uyum puanı, gerekçe başlığın altında; "Değerlendirme" filtresi (umut verici, koşullu, izle, elenen, süresi dolan, henüz değerlendirilmemiş) ve "Değerlendirme" sıralaması. Kapsam dışı (kesin ret) ihaleler varsayılan listede görünmez (GO, REVIEW ya da WATCH kararı varsa görünür); "Elenen" filtresinde bulunur. Birden fazla ret nedeni varsa gerekçe hepsini yazar. `pnpm assess --report` kararların dağılımını, ret nedenlerini, ortak bulma süresine duyarlılığı ve örnek gerekçeleri yazar (hiçbir şey yazmaz).
- İhale detayı: lot bazında durum ve gerekçe, üç puan ve ön puan aralığı, güven, sonraki adımlar, kapılar, boyut puanlarının nedenleri ve olgular (alıntı ve kaynağı ya da "doğrulanmadı"). Tam değerlendirme sayfa açılınca aynı olgulardan yeniden hesaplanır.
- Bilinen sınırlar: yükümlülükler ihale düzeyinde tek değerle ve geçtiği lotların listesiyle çıkarılır; lotlar farklı yükümlülük taşıyorsa en ağırı yazılır, diğerleri bilinmiyor sayılır. Olgular ilan metninden ve okunabilen dosyalardan çıkar; giriş isteyen portallardaki dokümanlar ekip yükleyene kadar girmez. Gelen kutusundaki durum en fazla 15 dakika geriden gelebilir; detay sayfası anlık hesaplar. Finansman (C04) nakit modeli olmadan bilinmiyor kalır, "Finansman gerekli" durumu henüz üretilmez.

### 7.1 Ortak LLM kuralları ve emekli triage

Profil başına AI uygunluk puanı (triage, `prompts/triage.v1.md` ve `triage.v2.md`, rubrik V2'nin ilan aşaması) 15 Ekim 2026'da olgular ve yeterlilik politikasıyla değiştirildi: worker'da zamanlanmıyor, sayfada gösterilmiyor. Eski analizler `analyses`'te duruyor; kod ve `pnpm triage` şimdilik yerinde.

Olgu çıkarma ve çeviri aynı altyapıyı kullanır (`src/analysis/runner.ts`, `llm.ts`, `pricing.ts`, `budget.ts`, `quotes.ts`):

- Çıktı API'ye `output_config.format` ile JSON şeması olarak gönderilir (olgu çıkarmada şema promptta) ve her durumda Zod ile doğrulanır. Geçersiz yanıt (JSON değil, şemaya ya da işin kendi kontrollerine uymuyor, token sınırında kesildi) bir kez tekrar denenir; kesilen yanıt iki katı sınırla. Model reddettiyse tekrar denenmez. Başarısız denemeden sonra son geçerli sonuç kalır (kural 6).
- Her çağrı `analyses`'e yazılır: API'nin döndürdüğü model sürümü, prompt sürümü, token sayıları ve istenen modelin fiyatıyla maliyet (kural 7). API'ye ulaşamayan çağrı da yazılır (çıktı boş, maliyet 0) ve bir saat sonra yeniden denenir. Fiyatı tanımlı olmayan model hiç çağrılmaz.
- Alıntı eşleştirme büyük/küçük harf, boşluk, tırnak ve tire biçimlerini ve görünmez Unicode biçim karakterlerini (sıfır genişlikli boşluk, yumuşak tire) yok sayar; 8 karakterden kısa alıntı kanıt sayılmaz.
- Haiku 5.5 varsayılan olarak düşünür ve düşünme `max_tokens`'a sayılır; efor açıkça verilir. İstemci zaman aşımını SDK'ya bırakır, en fazla 2 tekrar.
- Otomatik işler 2 eşzamanlı çağrıyla çalışır, aylık bütçe dolunca durur; 401/403'te ya da art arda 5 API hatasında çalıştırma durur. Elle çalıştırma bütçe dolmuşsa uyarıp devam eder. Bütçe, çalıştırma başındaki harcama ve biten çağrılarla kontrol edilir; uçuştaki çağrılar kadar aşılabilir.
- Worker ile komut satırı aynı anda çalışırsa aynı ihale iki kez işlenebilir; kayıtlar tutarlı kalır.

### 7.1a Türkçe çeviri

Ekibin gördüğü her ilan Türkçe gösterilir (ekip kararı, 15 Ekim 2026): aktif bir profille güncel eşleşmesi olan ya da son kararı verilmiş (geri alınmamış) ihaleler. Diğer ihaleler çevrilmez (tümünü çevirmek ayda ~40 USD ve ~50 MB demekti).

- Model `LLM_TRIAGE_MODEL`, prompt `prompts/translate.v2.md`, kod `src/analysis/translate.ts` (yazma) ve `translations.ts` (okuma). Efor "medium", düşünme açık (16 Ekim 2026: v1'in Türkçesi bozuk ve açıklamaları tek blok bulundu).
- Çıktı: açıklayıcı Türkçe başlık (ne alınıyor, varsa miktar ya da çerçeve anlaşma; ref numarası ve kurum adı yok), açıklamanın ve her lotun (başlık, açıklama) tam çevirisi. Çeviri doğal Türkçe söz dizimiyle ve ihale terimleri sözlüğüyle yapılır; açıklama içerik değişmeden konu konu paragraflara (boş satırla) ve "- " maddelerine ayrılır. Sayfa bunları paragraf ve madde listesi olarak gösterir (`src/components/formatted-text.tsx`); lot açıklamaları lot tablosunda açılır. Sayılar, kodlar, standartlar, tutarlar ve özel adlar korunur. Lot numaraları girdiyle birebir ve aynı sırada olmalı, aksi geçersizdir (kural 6).
- Girdi sınırları: açıklama 8.000, en fazla 30 lot, lot açıklaması 1.500, toplam 30.000 karakter. Kısaltma olduysa bunu kod kaydeder ve sayfada not edilir; model kısaltılan kısmı uydurmaz.
- Kayıt: `analyses` (kind `translation`, profil yok), her çağrı maliyetiyle (kural 7). Saklanan çıktı, çevrilen metinlerin parmak izini taşır; ilan değiştiyse sayfa çevirinin eski olduğunu söyler ve yeniden çevrilir. Prompt sürümü değişince de yeniden çevrilir. Başarısız denemede son geçerli çeviri kalır.
- Worker işi `translate` 10 dakikada bir en fazla 200 ihale (önce açık ve son tarihi yakın olanlar), aynı aylık bütçeyle. `pnpm translate [--limit=50] [--tender=<id>]` elle çalıştırır.
- Gösterim: gelen kutusunda Türkçe başlık ana başlık, orijinali altında. İhale detayında Türkçe başlık (orijinali altında, "AI çevirisi" notuyla), Türkçe açıklama (orijinal metin açılır bölümde) ve Türkçe lot başlıkları (orijinali üzerine gelince). Alıntılar orijinal dilde kalır.
- Maliyet: ihale başına ~0,002-0,01 USD.
- Akışsız çağrı kullanıldığı için çıktı sınırı en fazla 21.000 token (SDK daha yükseğini reddeder); tekrar denemede sınır ikiye katlanırken bu eşiği aşmaz.

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

- Gelen kutusu `/inbox`: eşleşen ihaleler. Filtreler: profil, kaynak, durum, karar, değerlendirme. Kolonlar: başlık (Türkçe, orijinali altında) ve değerlendirme gerekçesi, alıcı, ülke, değer (EUR), kalan gün, değerlendirme (durum ve uyum aralığı), doküman durumu (analize girecek dosya sayısı, "Okunuyor", "Portal" ya da yok), karar, "değişti" etiketi. Varsayılan sıralama: son tarihe göre, kapanmışlar gizli; "Değerlendirme" sıralaması en umut verici durumu öne alır. Sayfa başına 100 ihale, filtreler sayfa linklerinde korunur.
- İhale detayı `/tenders/[id]`: ilan bilgileri ve orijinal ilan linki, lotlar, eşleşme nedenleri, değerlendirme (bölüm 7.0.3), doküman listesi (ilan linkleri, yüklenen dosyalar ve ZIP üyeleri; her birinin durumu ve nedeni, analize girip girmediği, aç, indir ve yüklenenler için sil; portal linki; sürükle bırak yükleme), "Analiz et" düğmesi, bölüm bölüm derin analiz (her iddianın yanında kaynak, doğrulanmamış alıntılar işaretli, eksik bilgi listesi), karar ve not alanı, karar geçmişi.
- Profiller `/profiles`: liste ve form. Formda canlı önizleme: "son 30 günde bu kurallarla kaç ilan eşleşirdi" ve ilk 10 örnek.
- Ayarlar `/settings`: kaynak bazında son senkron zamanı ve son hata, aylık LLM harcaması ve sınır, doküman durumları ve depo kullanımı, kategori yönetimi.

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

### Faz 4: İlan değerlendirmesi

15 Ekim 2026'da kapsam güncellendi: profil başına AI puanı yerine olgu çıkarma ve kodla yeterlilik politikası (bölüm 7.0).

- `prompts/facts.v1.md`, Zod şeması, alıntı doğrulama; yeni eşleşmelerde ve kararlı ihalelerde otomatik iş.
- Politika motoru, lot bazında; politika bölüm I ve IX'un altı gerçek ilanı regresyon testi.
- Eşleşen ve karar verilen ihalelerin Türkçe çevirisi (bölüm 7.1a).
- Maliyet kaydı ve aylık bütçe kontrolü.
- Gelen kutusunda durum, uyum aralığı ve gerekçe; ihale detayında lot bazında değerlendirme ve olgular.
- Kabul: 50 gerçek eşleşmede olgu çıkarma ve değerlendirme çalışıyor; geçersiz çıktılar kayıtlı ve oranı ayarlar sayfasında görünüyor; kullanıcı daha önce elle incelediği ihalelerden bir örneklemde durum ve gerekçeleri kontrol ediyor.

### Faz 5: Dokümanlar

- Teklif verilebilecek ihalelerin doküman linklerini dene (bölüm 4.4; olgu aşaması triage'ın yerini aldı); içerik ve boyuta göre PDF, DOCX, XLSX, ZIP indir. HTML ya da giriş sayfası dönen link `needs_manual`.
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

Kısıt (17 Ekim 2026 kullanım şartları incelemesi): evergabe-online, Vergabemarktplatz NRW, DTVP ve Deutsche eVergabe ihale dokümanlarının üçüncü kişilere verilmesini yasaklıyor. Üreticilere dokümanın kendisi değil, analiz ve özet iletilir ya da üretici dokümanı portaldan kendisi indirir. Bu bir hukuk değerlendirmesi değildir.

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
