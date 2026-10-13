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
- `pnpm backfill --source=uk_fat --days=30` geriye dönük yükleme (tekrar çalıştırmak güvenli)
- `pnpm renormalize --source=uk_fat` normalizer ya da fold kuralı değişince tüm ihaleleri ham veriden yeniden hesaplar (API çağırmaz)

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

Faz 0, Faz 1 ve Faz 2 tamam (13 Ekim 2026). Sıradaki: Faz 3 (AB veri hattı, TED). Faz 2 kullanıcı kararıyla TED'in önüne alındı.

Faz 2 kabulü (Supabase üzerinde):
- Migration 0004-0007 uygulandı. ECB'den 90 günlük kur çekildi (1.856 satır). Tutarı olan 2.159 ihalenin 2.158'inde value_eur dolu; kalan 1'i AED.
- "Ana kategoriler" profili (4 kategori) oluşturuldu. Gelen kutusunda 25 teklif verilebilir ihale nedenleriyle listeleniyor. Karar verme ve geri alma çalışıyor.
- 239 test (PGlite ve postgres-js). Eşleştirme motorunu ve ECB modülünü iki ayrı Claude oturumu yazdı; kod iki ayrı incelemeden geçti, bulgular düzeltildi.

Faz 1 kabulü:
- 30 günlük backfill: 9.951 ham ilan, 2.705 ihale. İkinci çalıştırma kopya üretmedi. Worker senkronu ve /settings doğrulandı.

Bilinen eksikler:
- /settings'te kategori yönetimi ve LLM harcaması yok; kategoriler şimdilik migration 0005'teki seed'den geliyor.
- Gelen kutusu en fazla 500 ihale gösteriyor, sayfalama yok.
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
- Worker işleri: `sync-uk-fat` (2 saatte bir), `fx-ecb` (18:30), ikisi de açılışta bir kez; her ikisinin sonunda `fillValueEur` ve `rematch` çalışır.
