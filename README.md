# Bozkor İhale İstihbarat Platformu

UK (Find a Tender) ve AB (TED) kamu ihalelerini çeken, kriter profillerine göre filtreleyen ve eşleşen ihaleleri Claude ile analiz eden iç platform. Kapsam, veri modeli ve fazlar için [SPEC.md](SPEC.md), çalışma kuralları için [CLAUDE.md](CLAUDE.md).

## Gereksinimler

- Node.js 24
- pnpm 10
- Bir Supabase projesi (EU bölgesi, örn. Frankfurt `eu-central-1`)

Yerelde Docker ya da yerel Postgres gerekmez. Testler gömülü Postgres (PGlite) kullanır.

## Kurulum

### 1. Bağımlılıklar

```bash
pnpm install
```

### 2. Ortam değişkenleri

```bash
cp .env.example .env.local
```

Supabase panelinden doldurulacaklar:

| Değişken | Nereden |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings > Data API > Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Project Settings > API Keys > Publishable key |
| `SUPABASE_SECRET_KEY` | Project Settings > API Keys > Secret key |
| `DATABASE_URL` | Connect > Session pooler (port 5432). Transaction pooler (6543) pg-boss ile çalışmaz. |

`ALLOWED_EMAILS` içine giriş yapabilecek adresleri virgülle yazın. Liste boşsa kimse giremez.

### 3. Supabase Auth ayarları

1. **Authentication > Sign In / Providers**: "Allow new users to sign up" kapalı olsun. Kullanıcılar elle eklenir.
2. **Authentication > Users > Add user**: `ALLOWED_EMAILS` içindeki her adres için kullanıcı oluşturun ("Auto Confirm User" işaretli).
3. **Authentication > URL Configuration**:
   - Site URL: `APP_URL` ile aynı (yerelde `http://localhost:3000`)
   - Redirect URLs: `http://localhost:3000/**` ve production için `https://<alan-adi>/**`
4. İsteğe bağlı: **Authentication > Emails > Magic Link** şablonundaki linki şununla değiştirin:
   ```html
   <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">Giriş yap</a>
   ```
   Böylece link farklı tarayıcıda da açılabilir. Supabase şablonu düzenlemeye izin vermiyorsa bu adımı atlayın: varsayılan şablonla da giriş çalışır, ama link isteğin yapıldığı bilgisayardaki aynı tarayıcıda açılmalıdır.
5. Supabase'in yerleşik e-posta servisi sadece Supabase organizasyonunun üyelerine gönderir ve saatte birkaç e-postayla sınırlıdır. İlk denemeyi Supabase hesabının e-postasıyla yapın. Diğer kullanıcılar için ya onları organizasyona davet edin ya da **Authentication > Emails > SMTP Settings** altında Resend SMTP bilgilerini girin.

### 4. Veritabanı

```bash
pnpm db:migrate
```

Tüm tablolar `public` şemasında RLS açık ve politikasız oluşturulur. Uygulama Postgres'e doğrudan bağlandığı için etkilenmez; bu sadece Supabase Data API'sini kapatır. pg-boss kendi tablolarını ilk çalışmada `pgboss` şemasına kurar.

### 5. Dosya deposu

İhale dokümanları özel bir Supabase Storage kovasında durur (`SUPABASE_STORAGE_BUCKET`, varsayılan `tender-documents`).

1. **Storage > New bucket**: ad `tender-documents`, "Public bucket" kapalı.
2. "Restrict file size" açık, 50 MB. İzin verilen dosya türlerini (MIME) boş bırakın; tür kontrolünü uygulama yapar.

Kovaya sadece sunucu ve worker gizli anahtarla erişir. Tarayıcı tek kullanımlık imzalı linkle yükler, iki dakikalık imzalı linkle indirir. Kova yoksa ya da değişkenler eksikse worker doküman işlerini atlar, ihale sayfasında yükleme kapalı görünür.

### 6. Çalıştırma

```bash
pnpm dev      # web: http://localhost:3000
pnpm worker   # ayrı terminalde: zamanlanmış işler
```

Worker başladığında her 30 dakikada bir `[heartbeat]` satırı loglar.

## Veri yükleme

İlk kurulumda son 30 günün ilanlarını yükleyin:

```bash
pnpm backfill --source=uk_fat --days=30
```

Gün gün ilerler ve her gün için özet yazar. Find a Tender bazen yavaş yanıt verdiğinden 10-30 dakika, yoğun saatlerde daha uzun sürebilir. Yükleme sırasında worker'ı kapalı tutun. Yarıda kesilirse aynı komutu tekrar çalıştırın: yarım kalan ihaleler tamamlanır, kopya kayıt oluşmaz.

Sonrasında `pnpm worker` açık olduğu sürece yeni ilanlar 2 saatte bir otomatik çekilir. Son senkron zamanı ve varsa son hata /settings sayfasında görünür.

## Profiller ve gelen kutusu

- **/profiles**: kriter profillerini oluşturup düzenleyin. Form, kaydetmeden önce "son 30 günde kaç ihale eşleşirdi" önizlemesini gösterir. Kaydedince profil açık ihalelerle hemen eşleştirilir.
- **/inbox**: eşleşen ihaleler, neden eşleştikleri ve kararlarınız. Varsayılan olarak teklif verilebilir olanlar, son tarihe göre sıralı gösterilir.
- **/tenders/[id]**: ilan bilgileri, lotlar, eşleşme nedenleri, değerlendirme, dokümanlar ve karar (GO / REVIEW / NO_GO / WATCH). Karar geri alınabilir, geçmiş görünür. Worker ilan linklerini ve girişsiz açık portal sayfalarının listelediği dokümanları kendisi indirir (robots.txt'e uyarak; giriş, form ve captcha yok). Giriş isteyen portallardaki dosyaları "Portalı aç" ile indirip sayfadaki alana sürükleyin (PDF, DOCX, XLSX, ZIP; dosya başına 50 MB). Worker dosyaları bir iki dakikada okur; okunan dosyalar değerlendirmeye girer ve her olgunun yanında hangi dosyanın hangi sayfasından alındığı görünür.
- Worker açıkken yeni ilanlar ve ECB kurları geldikçe eşleşmeler kendiliğinden güncellenir.

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `pnpm dev` | Web uygulaması (geliştirme) |
| `pnpm build` / `pnpm start` | Production build ve çalıştırma |
| `pnpm worker` | pg-boss worker süreci (2 saatte bir Find a Tender senkronu) |
| `pnpm backfill --source=uk_fat --days=30` | Geriye dönük yükleme (`--source=eu_ted` TED için) |
| `pnpm renormalize --source=uk_fat` | İhaleleri saklanan ham ilanlardan yeniden hesaplar (API çağırmaz). `--dry-run` sadece neyin silineceğini yazar. İhaleleri yeniden yazdığı için worker eşleşen ve kararlı ihalelerin olgularını yeniden çıkarır (ihale başına ~0,002 USD) |
| `pnpm facts --limit=50` | Bekleyen ihalelerden alıntılı olgu çıkarır ve yeterlilik politikasıyla değerlendirir; `--tender=<id>` ya da `--notice=ted:<ilan no>,fat:<ilan no>` seçilen ihaleleri yeniden işler ve kararlarını yazdırır. Worker bunu 10 dakikada bir kendisi yapar |
| `pnpm assess` | Olgusu olan tüm ihaleleri politikayla yeniden değerlendirir (worker açılışta ve günde bir kez yapar, değişen ihaleleri hemen); `--dry-run` hiçbir şey yazmaz |
| `pnpm rematch` | Tüm açık ihaleleri aktif profillerle yeniden eşleştirir; eşleştirme kodu değişince gerekir (yaklaşık 30 MB Supabase veri çıkışı) |
| `pnpm translate --limit=50` | Ekibin gördüğü ihalelerin Türkçe çevirisi; `--tender=<id>` tek ihale. Worker bunu da 10 dakikada bir yapar |
| `pnpm enrich-ted` | Eşleşmesi ya da kararı olan TED ihalelerinin ilanlarını sonradan eklenen alanlarla (süre, ödül ve seçim kriterleri) yeniden çeker. Tekrar çalıştırmak güvenli |
| `pnpm documents --report` | Doküman durumları, elle yüklenmesi gereken siteler ve son denenen linkler (`--limit=20`). `--fetch` ve `--process` worker'ın indirme ve okuma işlerinden birer parti çalıştırır; worker açıkken de güvenli |
| `pnpm test` | Vitest (canlı API ve Supabase kullanmaz) |
| `pnpm typecheck` | Route tiplerini üretir ve `tsc` çalıştırır |
| `pnpm lint` | ESLint |
| `pnpm db:generate` | Şema değişikliğinden migration üretir (`src/db/migrations/`) |
| `pnpm db:migrate` | Migration'ları `DATABASE_URL` veritabanına uygular |
| `pnpm db:studio` | Drizzle Studio |

## Şema değişikliği akışı

1. `src/db/schema.ts` dosyasını düzenleyin.
2. `pnpm db:generate --name <kisa_aciklama>`
3. Üretilen SQL'i gözden geçirin, `pnpm test` ile gömülü Postgres'te deneyin.
4. `pnpm db:migrate`

Veri ekleyen migration'lar için `pnpm drizzle-kit generate --custom --name <ad>` boş bir SQL dosyası açar.
