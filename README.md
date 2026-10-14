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

### 5. Çalıştırma

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
- **/tenders/[id]**: ilan bilgileri, lotlar, eşleşme nedenleri, dokümanlar ve karar (GO / REVIEW / NO_GO / WATCH). Karar geri alınabilir, geçmiş görünür.
- Worker açıkken yeni ilanlar ve ECB kurları geldikçe eşleşmeler kendiliğinden güncellenir.

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `pnpm dev` | Web uygulaması (geliştirme) |
| `pnpm build` / `pnpm start` | Production build ve çalıştırma |
| `pnpm worker` | pg-boss worker süreci (2 saatte bir Find a Tender senkronu) |
| `pnpm backfill --source=uk_fat --days=30` | Geriye dönük yükleme (`--source=eu_ted` TED için) |
| `pnpm renormalize --source=uk_fat` | İhaleleri saklanan ham ilanlardan yeniden hesaplar (API çağırmaz). `--dry-run` sadece neyin silineceğini yazar |
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
