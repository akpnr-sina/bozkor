# Bozkor Tender Intelligence

Bozkor'un iç platformu. UK (Find a Tender) ve AB (TED) kamu ihale ilanlarını çeker, kullanıcının tanımladığı kriter profillerine göre filtreler, eşleşen ihalelerin dokümanlarını indirir ve Claude API ile analiz eder. Sonraki aşamada Türk üretici veritabanı eklenecek ve analiz edilmiş ihalelere uygun üretici önerilecek.

Kapsam, veri modeli, şemalar ve fazlar: @SPEC.md

Next.js 16.4 kullanılıyor; API'ler eğitim verisinden farklı olabilir, kod yazmadan önce `node_modules/next/dist/docs/` altındaki ilgili rehberi oku: @AGENTS.md

Kullanıcılar 2 kişilik iç ekip. Çok kiracılı (multi-tenant) değil.

## Stack

- Next.js 16 (App Router), TypeScript strict
- Postgres (Supabase, EU bölgesi) + Drizzle ORM
- Supabase Auth (email magic link, `ALLOWED_EMAILS` allowlist) ve Supabase Storage (ihale dokümanları)
- Tailwind + shadcn/ui
- Worker: aynı repoda ayrı Node süreci (`src/worker/`), kuyruk ve zamanlama için pg-boss
- LLM: `@anthropic-ai/sdk`. Triage modeli `LLM_TRIAGE_MODEL` (varsayılan claude-haiku-5-5), derin analiz modeli `LLM_ANALYSIS_MODEL` (varsayılan claude-sonnet-5-5)
- Doğrulama: Zod (API payload'ları, kriter kuralları, LLM çıktıları)
- Doküman dönüştürme: mammoth (DOCX), SheetJS (XLSX), pdfjs-dist (PDF metni ve sayfa sayısı, alıntı doğrulama)
- E-posta: Resend
- Test: Vitest

## Komutlar

- `pnpm dev` web uygulaması
- `pnpm worker` worker süreci (pg-boss)
- `pnpm test` testler (Vitest; DB testleri gömülü Postgres, `tests/helpers/test-db.ts`)
- `pnpm typecheck` route tiplerini üretir ve `tsc --noEmit` çalıştırır
- `pnpm lint` ESLint
- `pnpm db:generate --name <ad>` / `pnpm db:migrate` Drizzle migration
- `pnpm backfill --source=uk_fat --days=30` geriye dönük yükleme, `--source=eu_ted` TED için (tekrar çalıştırmak güvenli)
- `pnpm renormalize --source=uk_fat` normalizer, fold ya da kapsam kuralı değişince tüm ihaleleri ham veriden yeniden hesaplar (API çağırmaz). `--dry-run` önce neyin silineceğini yazar. İhaleleri yeniden yazdığı için eşleşen ve kararlı ihalelerin olgularını da yeniden çıkartır (ihale başına ~0,002 USD)
- `pnpm facts --limit=50` bekleyen ihalelerden olgu çıkarır ve değerlendirir (elle; bütçe dolsa da uyarıyla çalışır), `--tender=<id>` ya da `--notice=ted:702149-2026,fat:096535-2026` seçilen ihaleleri yeniden işler ve kararlarını yazdırır (FaT ve TED numaraları çakışabildiği için önek)
- `pnpm assess` olgusu olan tüm ihaleleri yeterlilik politikasıyla yeniden değerlendirir, `--dry-run` hiçbir şey yazmadan kaç kararın değişeceğini gösterir (politika değerini değiştirdikten sonra), `--report` kayıtlı kararları özetler (ret nedenleri, ortak bulma süresine duyarlılık, örnek gerekçeler)
- `pnpm triage --limit=50` emekli profil bazlı AI puanı (worker çalıştırmaz; SPEC 7.1)
- `pnpm translate --limit=50` ekibin gördüğü ihalelerin Türkçe çevirisi (elle), `--tender=<id>` tek ihale
- `pnpm documents --report` doküman durumları, portal siteleri ve son denenen linkler (Faz 5 kabulü için), `--fetch` / `--process` worker'ın indirme ve okuma işlerinden birer parti (her doküman sahiplenildiği için worker açıkken de güvenli)
- `pnpm enrich-ted` eşleşmesi ya da kararı olan TED ihalelerinin ilanlarını TED_FIELDS'e sonradan eklenen alanlarla (süre, ödül ve seçim kriterleri) yeniden çeker ve ihaleleri günceller; "değişti" basmaz, tekrar çalıştırmak güvenli

## Klasör yapısı

- `src/app/` sayfalar ve route handler'lar
- `src/db/` Drizzle şema (`schema.ts`), bağlantı (`getDb()`) ve migration'lar (`migrations/`)
- `src/lib/auth/` allowlist ve `getCurrentUser()` (veri erişen her sayfa, aksiyon ve route'ta çağrılır)
- `src/lib/supabase/` Supabase SSR istemcisi ve proxy oturum yenileme
- `src/sources/` kaynaktan bağımsız katman: `types.ts` (SourceAdapter, NormalizedNotice), `http.ts` (timeout, 429, backoff), `fold.ts` (bir prosedürün ilanlarını tek ihaleye birleştirir), `store.ts` (ham kayıt + upsert), `sync.ts` (artımlı senkron, backfill, sources tablosu)
- `src/sources/uk-fat/`, `src/sources/eu-ted/` her kaynak için client + Zod şeması + normalizer + adapter
- `src/matching/` kriterler ve eşleştirme: `rules.ts` (profil kuralları, Zod), `types.ts` (sözleşme), `engine.ts` + `text.ts` (saf motor, anahtar kelime araması), `apply.ts` (profile_matches'e yazma, canlı önizleme), `describe.ts` (Türkçe sebep metinleri)
- `src/fx/` ECB kurları: çekme, ayrıştırma, `toEur`, `syncEcbRates`; `src/sources/value-eur.ts` ihalelerin `value_eur` alanını doldurur
- `src/documents/` indirme, açma, metne çevirme
- `src/analysis/` triage, derin analiz, Zod şemaları, alıntı doğrulama
- `src/worker/` job tanımları ve zamanlama (`jobs.ts`), backfill komutu (`backfill.ts`)
- `src/lib/time.ts` saat dilimi dönüşümleri, `src/lib/countries.ts` ülke adı ve kodu çevirisi, `src/lib/format.ts` UI'daki Türkçe etiketler ve tarih/tutar biçimleri
- `src/lib/auth/session.ts`: Server Component'ler `getCurrentUser()` (`use cache: private`), Server Action ve Route Handler'lar her çağrıda doğrulayan `requireUser()` kullanır
- `prompts/` versiyonlu prompt dosyaları (`triage.v1.md`, `deep.v1.md`)
- `tests/fixtures/` gerçek API yanıtlarından kaydedilmiş örnekler
- `tests/helpers/` test yardımcıları (PGlite ile migration uygulanmış test DB'si)
- Birim testleri kaynağın yanında: `*.test.ts`

## Değişmez kurallar

1. Sadece resmi API'ler ve herkese açık doğrudan doküman linkleri kullanılır. Giriş gerektiren portallar kazınmaz, captcha veya kullanım şartları aşılmaz. Rate limit'e uyulur: 429'da `Retry-After`, yoksa exponential backoff.
2. Her ham payload `raw_notices` tablosuna yazılır. Normalizer'lar ham veriden tekrar çalıştırılabilir olmalı.
3. Kesin kontroller (tarih, değer, ülke, CPV, kalan gün) kodda yapılır, LLM'e bırakılmaz.
4. LLM nihai karar vermez. AI önerisi (`analyses`) ile insan kararı (`tender_reviews`) ayrı tablolardadır.
5. Her AI iddiası bir kaynağa bağlanır: ilan alanı ya da doküman + sayfa + kısa alıntı. Doğrulanamayan alıntı UI'da "doğrulanmadı" olarak işaretlenir. Belirlenemeyen bilgi tahmin edilmez, `missingInfo`'ya yazılır.
6. LLM çıktıları Zod şemasıyla doğrulanır. Geçersiz çıktı bir kez tekrar denenir, sonra hata olarak kaydedilir.
7. Her LLM çağrısının modeli, prompt versiyonu, token kullanımı ve maliyeti kaydedilir. Aylık harcama `LLM_MONTHLY_BUDGET_USD` sınırına ulaşınca otomatik analizler durur, manuel tetik uyarıyla çalışır.
8. Testler canlı API çağırmaz; `tests/fixtures/` kullanılır.
9. Gizli anahtarlar sadece env'de; `.env.example` güncel tutulur.

## Konvansiyonlar

- Kod, tanımlayıcılar ve yorumlar İngilizce; UI metinleri Türkçe (tek dil, i18n kütüphanesi yok).
- AI özetleri Türkçe üretilir, alıntılar orijinal dilde kalır.
- UI metinlerinde, promptlarda ve AI çıktılarında em dash karakteri (U+2014) kullanılmaz.
- Tutarlar orijinal para birimiyle saklanır; ayrıca ECB kuruyla `value_eur` tutulur.
- Ülke kodları içeride ISO 3166 alpha-2.
- Saat dilimi Europe/Istanbul; veritabanında UTC.
- Bir faz SPEC.md'deki kabul kriterleri sağlanmadan kapanmaz ve sonraki faza geçilmez.

## Mevcut durum

Faz 0-5 tamam (18 Ekim 2026); resmi portal API'leri (Faz 5b) 19 Ekim'de TenderNed ile tamam. Sıradaki (kullanıcı kararı): Faz 6 (derin analiz). Faz 2 kullanıcı kararıyla TED'in önüne alındı.

Faz 5b, resmi portal API'leri (19 Ekim 2026):
- Araştırma (SPEC 4.4): TenderNed'in anahtarsız TNS servisi belge veriyor, uygulandı. Belçika başvuru istiyor (kullanıcı: şimdilik gerek yok). Vortal, SICAP, e-Zamówienia ve EOP'ta belge API'si yok; SICAP ve Vortal şartları otomasyonu yasaklıyor, onlara hiç istek gitmiyor.
- TenderNed adaptörü (`src/documents/adapters/`): ilan linkindeki yayın numarasıyla belge listesi (son düzeltme önce, ilan PDF'leri hariç, Zod denetimi). Dosyalar sayfa linkleriyle aynı yoldan iniyor (bekçi, robots.txt, kalan yer, tekilleştirme). API'nin listeleyip inmeyen her belge nedeniyle görünüyor; geçici hata alan dosya kendi linki olarak yeniden deneniyor. Liste son tarihe kadar günde bir yeniden okunuyor; başka yayının yolundan gelen aynı belge indirme kimliğiyle tanınıyor.
- robots.txt: 5xx ya da ağ kesintisinde son okunan kopya geçerli (RFC 9309 2.4, en çok 30 gün), 429'da değil. Hiç okunamamış sitenin linki 1 saat, sonra 6 saat sonra deneniyor. TenderNed'in /robots.txt'i aralıklı 503 veriyor.
- Canlıda ilk turda 4 TenderNed ihalesinden 60 dosya indi ve okundu. Olgular dosyalardan yeniden çıkarıldı (0,33 USD): yüksek gerilim skid ihalesi sahada kurulum istediği için "Ticari olarak uygun değil", dördü lot başına referans istediği için "Teklif verilemez" oldu; kalan dosyaları tasarım gereği indirilmiyor.
- Migration 0017: robots.txt okunamadığı için ekibe kalmış 5 TenderNed linki yeniden açılıyor. Migration 0018: `host_rests`; 429 ya da 503 veren siteye (yanıtı veren adres; API portalında alt alan adları dahil) süre bitene kadar hiçbir linkten ya da yönlendirmeden istek gitmiyor (kural 1).
- 779 test. 63 adaptörü, fetchJson'ı, belge kimliğini ve robots yedeğini yazdı. 03'ün dört inceleme turu 21 bulgu çıkardı (inmeyen belgenin izsiz kalması, 429'da sitenin satır satır bekletilmesi, 429'da robots yedeği, yeniden listelemede boşuna istenen satırlar ve ezilen notlar, beklemeye alınan listede virüs işaretli belgenin inmesi gibi); hepsi düzeltildi.

Faz 5b bilinen eksikleri:
- TNS haber vermeden değişebilir; biçim değişirse link "servis değişmiş olabilir" notuyla kalır.
- Aynı belgenin sürümleri (v1.0, v1.1, izlenen değişiklikler) birlikte olgu girdisine girebiliyor.
- Portal sayfaları (GIZ, NRW) bir kez okunuyor; günlük yeniden okuma yalnız API'lerde.
- Portalın virüs şüphesiyle işaretlediği ya da ihalenin alanı dolu olduğu için alınmayan belge, işaret kalksa ya da yer açılsa da yeniden denenmiyor.

Faz 5 kabulü (Supabase üzerinde, 18 Ekim 2026):
- Migration 0013-0016 uygulandı; Supabase Storage'da özel `tender-documents` kovası (dosya başına 50 MB). Worker işleri `fetch-documents` (saatte iki) ve `process-documents` (dakikada bir); `pnpm documents --report|--fetch|--process`.
- 16 Ekim taraması: linklerin %2'si doğrudan dosya. Kullanıcı kabulde girişsiz açık portal dokümanlarının otomatik çekilmesini istedi (17 Ekim). Kural 1 gereği yalnız kullanım şartları okunmuş portalların sayfaları izleniyor (`src/documents/hosts.ts`: GIZ, Vergabemarktplatz NRW); şartları otomasyonu yasaklayanlara hiç istek yok (platformazakupowa.pl, Deutsche eVergabe); robots.txt'e her istekte uyuluyor; ilk istek ve her yönlendirme bekçiden geçiyor (şartlar, robots, site sırası). İnceleme tablosu SPEC 4.4'te. enarocanje.si kullanıcı kararıyla ilan linkinden otomatik.
- Canlıda: 3 Slovenya ZIP'i 12 üyeye açıldı, GIZ'den 32 dosya, NRW'den doküman ZIP'i; 18 Ekim'de depoda 102 dosya (113 MB). PDF metni ve sayfa sayısı, DOCX ve XLSX metni çıkıyor; NUL ve kontrol karakterleri atılıyor.
- Elle yükleme: sürükle bırak, tarayıcıda SHA-256, tek kullanımlık imzalı link, ihale başına kilit altında 200 MB ve toplam 950 MB sınırı, silme. Kullanıcı yükledi; dosya "Analize girecek" oldu ve değerlendirme güncellendi.
- Dokümanlı olgular (17 Ekim ekip kararı, `prompts/facts.v5.md`): analize giren dosyaların metni olgu girdisine giriyor (en fazla 12 dosya, 240.000 karakter), alıntı kaynağı dosya ve sayfa olarak gösteriliyor. Slovenya ihalelerinde referans ve ciro şartları dosyalardan çıktı (ör. "dosya 5, sayfa 9"), durumlar "Teklif verilemez" oldu. Dosyası değişen ihale 5 dakika sonra yeniden çıkarılıyor; v5'e geçiş ~580 ihaleyi yeniden çıkardı (~2-3 USD).
- 717 test. 63 indiriciyi, çerez kabını, robots.txt'i ve portal link çıkarmayı; 03 metin çıkarmayı, ayarlar kartını, gelen kutusu göstergesini, komutu ve dosyalı olgu girdisini yazdı. Dört salt okunur inceleme turu 40'tan fazla bulgu çıkardı (NUL'lu PDF'te sonsuz döngü, yönlendirmeyle yasak listenin atlatılması, sınır yarışları gibi); hepsi düzeltildi.

Faz 5 bilinen eksikleri:
- Otomatik açılabilen portallar ilanların ~%10'u. evergabe-online.de şartları izin verse de dosyaları yalnız tarayıcıya veriyor (oturum sıfırlanıyor, güvenlik duvarı); robots.txt'in yasakladıkları (~%11: ekr.gov.hu, uvo.gov.sk, eojn.hr, achatpublic, contrataciondelestado) ve giriş isteyenler elle yükleniyor.
- Eksik ara sertifika zinciri sunan siteler (e-propublico.pl, leidos-supply.uk) okunamıyor; NODE_EXTRA_CA_CERTS ile çözülebilir. Türkiye'den zaman aşımına uğrayan siteler (sell2wales, NEN) Railway'den yeniden denenmeli.
- Portal sayfası bir kez taranıyor; sonradan eklenen dokümanlar için yeniden tarama yok. Taranmış PDF'in metni yok, alıntıları doğrulanamaz.
- Bazı dillerde olgu girdisi 100k token'ı aşabiliyor (Slovence bir ihale 121k, ~0,09 USD).
- Bazı Slovence ZIP adları eski Windows kod sayfasıyla yazıldığı için harf bozuk görünüyor.
- Faz 8 kısıtı: dört Alman platformu dokümanların üçüncü kişilere verilmesini yasaklıyor; üreticilere doküman değil analiz iletilmeli (SPEC 10).

Faz 4 kabulü (Supabase üzerinde, 16 Ekim 2026):
- Kapsam ekip geri bildirimiyle değişti: profil başına AI puanı (triage, rubrik V2) yüksek puanlı ihalelerin elle kontrolde Bozkor'a uymadığını gösterince yerini yeterlilik politikası aldı (`docs/qualification-policy-v1.md`). AI yalnız alıntılı olgu çıkarır (`prompts/facts.v4.md`), puan, kapı, durum ve Türkçe gerekçeyi kod hesaplar (`src/policy/`, policy.v3). Ekip kararları: yalnızca ürün teslimi (kurulum, basit montaj, yerinde servis, sahada devreye alma ya da eğitim isteyen lot elenir), hizmet ve yapım lotları kapsam dışı, ortak bulma süresi 10 iş günü, Bozkor'un istekli belgesi, kendi referansı ve hiçbir ülkede ortağı yok.
- Migration 0009-0012 uygulandı. `renormalize --source=uk_fat` 421 FaT ihalesine, `enrich-ted` 571 TED ihalesine (677 ilan) yapılandırılmış ayrıntıları (süre, çerçeve, e-sipariş, GPA, ödül ve seçim kriterleri, teklif dilleri) ekledi.
- Politika belgesinin örnekleri canlıda beklenen sonucu verdi: lastik ve yedek parça "Ticari olarak uygun değil" (aylık ~333 ve ~1.042 EUR), kompresör (şartname ilan dokümanının açıklamasında) eleniyor, Litvanya jeneratörleri ve kafe mobilyası ilandan "Doküman gerekli". Malta ilanı veritabanında yok (30 günlük yüklemenin dışında).
- ~580 eşleşen ve kararlı ihalenin olguları çıkarıldı ve değerlendirildi (ihale başına ~0,0026 USD); dağılım: doküman gerekli 276, ticari olarak uygun değil 130, yeterlilik incelemesi 93, teklif verilemez 48, kesin ret (kapsam dışı) 29, süresi doldu 3. Geçersiz yanıt yok. Çeviriler translate.v2 ile (doğal Türkçe, paragraf ve madde düzeni) yeniden çevriliyor.
- Kullanıcı gelen kutusunu ve detay sayfasını kontrol etti: tek puan (aralığın ortası) ve basit montajın elenmesi istendi, yapıldı; çeviri Türkçesi ve düzeni düzeltildi.
- 534 test. Politika motoru ve olgu hattı iki Claude oturumunun salt okunur incelemesinden geçti (lot bazında yükümlülükler, çıkarımın ret vermemesi, eş zamanlı değerlendirme, okuma anına göre olgu kuyruğu gibi 30'a yakın bulgu düzeltildi).

Faz 4 bilinen eksikleri:
- Olgular yalnız ilan metninden; çoğu ihale "Doküman gerekli". Faz 5-6 dokümanları okuyunca ayrışacak. Üretici veritabanı ve nakit modeli olmadığı için "Üretici bulunmalı" ilan düzeyinde nadir, "Finansman gerekli" hiç üretilmiyor.
- Yükümlülükler ihale düzeyinde tek değer ve lot listesiyle; lotlar farklıysa en ağırı yazılır, diğerleri bilinmiyor sayılır.
- Dinamik satın alma sistemlerinde son tarih katılım tarihidir; H03 süre kuralı bunlarda fazla katı olabilir.
- Emekli triage kodu (`src/analysis/triage*.ts`, `rubric.ts` içindeki metrikler, `pnpm triage`) duruyor; `bidWindow` politika motorunda kullanılıyor. Kalan kısım ileride silinebilir.
- Worker kullanıcının Mac'inde arka planda çalışıyor (`worker.log`); Mac uyuyunca bağlantılar kopuyor, uyanınca toparlanıyor. Sunucuya taşıma (Railway) bekliyor.
- Supabase oturum havuzu 15 bağlantı: web 3, worker 3 + pg-boss 4, bir komut 3.

Faz 3 kabulü (Supabase üzerinde):
- TED istemcisi, normalizer ve senkron (`src/sources/eu-ted/`), worker işi `sync-eu-ted`. 18 gerçek TED örneği ve 4 ilanlık değişiklik zinciri `tests/fixtures/eu-ted/` altında.
- Ekip kararıyla sadece ürün (mal alımı) ihaleleri; kural iki kaynağa da uygulandı (SPEC bölüm 1). Migration 0008 `tenders.contract_nature` ekler. `renormalize --dry-run` 2.349 silinecek ihale gösterdi; gerçek çalıştırma 2.349 hizmet, yapım ve yazılım ihalesini sildi, 404 UK mal ihalesi kaldı, karar kaybı olmadı.
- 30 günlük TED backfill: 16.320 ham ilan, 13.078 ihale, 1.232 kapsam dışı (yazılım), 82 atlanan (çoğu yeterlilik sistemi), 6.349 ihalede value_eur. Yaklaşık 85 dakika sürdü (Türkiye'den AB veritabanına ihale başına ~1 sn). İkinci çalıştırma kopya üretmedi.
- Düzeltme ilanı alan prosedürler (5-7 ilan) tek ihale olarak kaldı; son tarih en son ilandaki tarih (SQL ile doğrulandı). /settings'te TED satırı ve worker'da `sync-eu-ted` görüldü.
- Veritabanı 63 MB'tan 161 MB'a çıktı. 302 test. TED istemcisini ve dil/ülke dönüşümlerini bir Claude oturumu, fixture'ları ve kapsam denetimini diğeri yaptı; iki tur denetimin bulguları düzeltildi.

Faz 2 kabulü (Supabase üzerinde):
- Migration 0004-0007 uygulandı. ECB'den 90 günlük kur çekildi (1.856 satır). Tutarı olan 2.159 ihalenin 2.158'inde value_eur dolu; kalan 1'i AED.
- "Ana kategoriler" profili (4 kategori) oluşturuldu. Gelen kutusunda 25 teklif verilebilir ihale nedenleriyle listeleniyor. Karar verme ve geri alma çalışıyor.
- 239 test (PGlite ve postgres-js). Eşleştirme motorunu ve ECB modülünü iki ayrı Claude oturumu yazdı; kod iki ayrı incelemeden geçti, bulgular düzeltildi.

Faz 1 kabulü:
- 30 günlük backfill: 9.951 ham ilan, 2.705 ihale. İkinci çalıştırma kopya üretmedi. Worker senkronu ve /settings doğrulandı.

Bilinen eksikler:
- TED sonuç ilanları çekilmiyor: TED ihaleleri "Sonuçlandı" olmaz, son tarih geçince kapalı görünür.
- TED planlama ilanı (PIN) ile sonraki çağrı ilanı bağlanmıyor; ayrı ihaleler olarak görünür. TED yeterlilik sistemleri (qu-sy) bilerek alınmıyor.
- TED ilanlarının ~%95'i İngilizce değil: profil anahtar kelimeleri orada pek işlemez, eşleşme CPV'ye dayanır (profil formunda not var).
- Sadece ekibin gördüğü ilanlar (güncel eşleşme ya da karar) Türkçeye çevrilir; diğerleri ilanın dilinde kalır.
- Depolama: 30 günlük TED verisi ~98 MB tuttu; iki kaynakla tahmini büyüme ayda 130-150 MB. Supabase ücretsiz planı 500 MB, aralık civarı dolar. Karar gerekiyor: Supabase Pro ya da kapanmış ihalelerin ve kapsam dışı FaT prosedürlerinin ham verisini silen saklama kuralı.
- TED backfill yavaş (30 gün ~85 dk); `APPLY_CONCURRENCY` ve havuz boyutu artırılarak hızlandırılabilir.
- Promptlar `prompts/`'tan çalışma anında okunuyor; şimdilik sadece worker ve CLI çağırıyor. Bir Server Action ileride LLM çağırırsa Vercel'de `outputFileTracingIncludes` ile `prompts/*.md` eklenmeli.
- Gelen kutusu sorgusu tüm ihaleleri tarıyor; ihale sayısı yüz binlere çıkınca eşleşme tablosundan başlayan bir sorguya çevrilmeli.
- Politika motoru yükümlülükleri (kurulum, servis) ihale düzeyinde okur, lot bazında değil; olgular şimdilik yalnız ilan metninden (dokümanlar Faz 5-6).
- LLM çağrıları akışsız; çıktı sınırı 21.000 token. Çok uzun çeviriler için akışlı çağrıya geçilebilir.
- /settings'te kategori yönetimi ve LLM harcaması yok; kategoriler şimdilik migration 0005'teki seed'den geliyor.
- Önizleme son 30 günün ihalelerini 2 dakika bellekte tutuyor; yeni gelen ilan önizlemeye en geç 2 dakikada yansır.
- Worker sadece bilgisayarda açıkken çalışıyor; production ortamı (Vercel, Railway) henüz kurulmadı.
- Supabase magic link şablonu düzenlenemedi; varsayılan şablon ve PKCE `code` akışı kullanılıyor. Link, isteğin yapıldığı bilgisayardaki aynı tarayıcıda açılmalı. Resend SMTP bağlanınca `token_hash` şablonuna geçilebilir (README).
- Supabase'in yerleşik e-posta servisi sadece organizasyon üyelerine ve saatte birkaç e-posta gönderiyor. İkinci kullanıcı için organizasyon daveti ya da Resend SMTP gerekiyor.

Kararlar:
- Next 16.4 Cache Components ve Partial Prefetching açık (sonraki major'da zorunlu). Oturum ve DB okuyan bileşenler `<Suspense>` içinde olmalı.
  - `getCurrentUser()` `"use cache: private"` kullanır: Supabase token süresini `Date.now()` ile karşılaştırıyor, oturuma özel App Shell ön render'ı buna sadece cache scope içinde izin veriyor.
  - Server component'te DB'ye dokunmadan önce `await io()` (`next/cache`) çağrılır: postgres-js havuzu kurarken `Math.random()` kullanıyor ve ön render bunu reddediyor. Örnek: `src/app/(app)/settings/source-status.tsx`. `getDb()`'nin içine konmaz, çünkü worker ve komut satırı araçları Next dışında çalışır.
- Tüm tablolarda RLS açık, politika yok; uygulama `DATABASE_URL` ile tablo sahibi olarak bağlanır.
- Supabase'de kayıt kapalı, kullanıcılar panelden eklenir (`shouldCreateUser: false`).
- `analyses` tablosuna maliyet hesabı için `cache_read_tokens` ve `cache_write_tokens` eklendi.
- Tüm Find a Tender ilanları raw_notices'e yazılır. Sonuç ve sözleşme bildirimleri sadece mevcut ihalenin durumunu günceller, ihale oluşturmaz ve değişiklik sayılmaz (SPEC 4.1).
- Yarıda kalan senkron, raw_notices.applied_at sayesinde bir sonraki çalıştırmada kendiliğinden tamamlanır.
- tenders.status `closed` yazılmaz; kapanmış ihale sorguda submission_deadline ile ayıklanır.
- value_eur Faz 2'de ECB kurlarıyla doldurulacak; Faz 1'de boş.
- Eşleştirmede CPV önekleri ile `keywordsAny` arasında VEYA var (kaçırmak fazladan sonuçtan pahalı; Faz 4'te AI skorlayacak). Ayrıntılar SPEC bölüm 6.
- Eşleşme kayıtları silinmez: profil artık istemiyorsa `profile_matches.unmatched_at` işaretlenir (durum, triage, karar korunur). Gelen kutusu karar filtresiyle bunları da gösterir.
- Karar geri alma, `tender_reviews`'e kararı boş yeni bir satır eklemektir (append-only).
- Worker işleri: `sync-uk-fat` (2 saatte bir), `sync-eu-ted` (11:30 ve 17:30), `fx-ecb` (18:30), `facts` ve `translate` (10 dakikada bir), `assess` (15 dakikada bir), hepsi açılışta bir kez; `enrich-ted` (05:45, ayrıntısı eksik eşleşmiş TED ihaleleri); senkron ve kur işlerinin sonunda `fillValueEur` ve `rematch` çalışır. Emekli `triage` işinin zamanlaması açılışta silinir.
- Sadece mal alımı (14 Ekim 2026, ekip kararı). Kural `src/sources/scope.ts`'te, eşleştirme motorunun ilk kuralı da odur. Kapsam dışına düşen ihale silinir; kararı, analizi ya da indirilmiş dokümanı olan kalır ama eşleşmez.
- Gelen kutusunun varsayılan görünümü, eşleşmesi bitmiş olsa da son kararı GO, REVIEW ya da WATCH olan ihaleleri de gösterir.
- Şu aşamada yalnızca ürün teslimi (16 Ekim 2026, ekip kararı): kurulum (basit montaj dahil), yerinde servis, sahada devreye alma ya da eğitim isteyen lotlar elenir (`src/policy/policy.ts` `supplyOnly`, `allowMinorAssembly`). Puan tek sayı (aralığın ortası) gösterilir. Ekip ayrıca 10 iş günlük ortak bulma süresini ve Bozkor'un istekli belgesi, kendi referansı ve hiçbir ülkede ortağı olmadığını doğruladı.
- Değerlendirme çerçevesi Bozkor'un yeterlilik politikası (`docs/qualification-policy-v1.md`, 15 Ekim 2026). AI sadece alıntılı olgu çıkarır; puan, kapı ve durumu kod hesaplar (`src/policy/`, SPEC 7.0). Alıntısı doğrulanmayan olgu kararda kullanılmaz. Politika değerleri `src/policy/policy.ts`'te; değer değişince sürüm artar. Rubrik V2 ve profil bazlı triage emekli (SPEC 7.1).
- Ekibin gördüğü ihaleler (güncel eşleşme ya da karar) Türkçeye çevrilir, diğerleri çevrilmez (maliyet ve depolama). Orijinal metin her zaman görünür kalır (SPEC 7.1a).
- LLM işleri ortak çalıştırıcıyı kullanır (`src/analysis/runner.ts`): tek tekrar, her çağrının kaydı, bütçe ve durma koşulları.
- TED ham kaydı XML değil, arama API'sinin JSON alanlarıdır (`links` hariç); eForms XML indirilmez. Hizmet ve yapım ilanları sunucu tarafında elenir (SPEC 4.2).
