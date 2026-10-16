# BOZKOR Tender Intelligence — Teknik Karar, Eleme ve Puanlama Spesifikasyonu V2.0

**Sürüm:** 2.0.0 · **Tarih:** 14 Ekim 2026 · **Statü:** Ürün/politika ve referans algoritma taslağı  
**Mevcut dayanak:** Önceki BOZKOR Tender Screening Rubric V1.0. Bu metin V1'in sekiz ana ağırlığını ve hard-gate yaklaşımını korur; alt metrik, ölçüm aralığı, kanıt standardı ve nakit akışı simülasyonu ekler.  
**Amaç:** Find a Tender, TED, ulusal AB ihaleleri, EU Funding & Tenders, UK MoD, NSPA, SAM.gov/DLA kaynaklarından gelen ihaleleri **lot × sözleşme tarafı × tedarik modeli** bazında değerlendirip *nedenleri açıklanabilen* aksiyonlara yönlendirmek.

> ÖNEMLİ SINIR: Bu sistem hukuk, gümrük, vergi veya mühendislik onayı vermez. `BID_REVIEW` teklif gönderme izni değildir. `BID_APPROVED` yalnızca insan onayıyla, kayıt altına alınarak üretilir. **Önerilen rakamsal eşikler Bozkor'un başlangıç iş stratejisine ait ayarlanabilir iç politika değerleridir; mevzuat hükmü veya kanıtlanmış optimumlar değildir.**

---

## 1. Kullanım hedefleri ve korunan varsayımlar

1. Bozkor Ltd (UK), Companies House **17023023**, Find a Tender PPON **PXYY-4559-NMQR**; UK prime olarak bağımsız tüzel kişi.
2. Bozkor Türkiye ayrı tüzel kişi. UK ve TR bankaları, borçları ve nakitleri **birleştirilip tek kullanılabilir havuz sayılamaz**.
3. Bildirilen toplam ~€25.000, operasyon planı €17.000 + rezerv €5.000 + idari €3.000 **planlama varsayımıdır**. Bu kaynakların hangi tüzel kişide, hangi para biriminde, hangi tarihte kullanılabilir olduğu mutlaka doğrulanır. Son bildirilen UK HSBC £15, UK prime'ın satın alma gücü sayılmaz.
4. 5201 kapsamı/özel kontrole tabi ticaret **ilk faz hedefi dışında**. Alıcı NATO/MoD olsa bile normal cıvata veya ofis ekipmanı otomatik kontrollü ürün sayılmaz. Ürün sınıflandırması gerekir.
5. İlk odak standart *goods*, £/€15–35k bandında, net teslimatlı, mümkünse 1–2 sevkiyatlı, çok düşük yerel servis yükümlülüğü; tutar tek başına hard gate değildir.
6. Tercih edilen doğrudan maliyet sonrası katkı marjı **≥%20**, ön eleme ticari red çizgisi **<%12**, küçük sözleşmelerde katkı hedefi **~£/€2.500**. Bunlar parametre ve istisna onayına tabidir.
7. Gerçek ürün/üretici teklifi, teknik uygunluk, ithalatçı, gümrük vergisi, garanti, alıcı sipariş modeli, zamanlama ve ödeme kanıtı yoksa **kesin GO üretilemez**.

### 1.1 Girdi birimi neden `lot × route`?

Bir ihalede 6 lot olabilir; örneğin tekstil ve riskli solunum cihazı aynı ilanda değilse bile çok farklı teknik yeterlilikler ve nakit akışları olabilir. Aynı lota UK prime ve TR prime üzerinden teklif vermek farklı ülke katılımı, menşe, VAT ve finansman doğurur. Bu yüzden anahtar:

```
opportunity_key = source + procedure_id + lot_id + notice_version
assessment_key = opportunity_key + route_id + profile_snapshot_id + model_version
```

Aynı lotun farklı route sonuçları **birleştirilip ortalanmaz**. En iyi yasal route seçilebilir; diğer route retleri silinmez. Aynı satıcıya ait farklı lotlar için ortak finansman gereksinimi ayrıca portföy nakit takviminde üst üste bindirilir.

---

## 2. Sistem mimarisi ve faz sınırları

| Faz | Girdi | Çıktı | Otomasyon izni |
|---|---|---|---|
| P0 – Discovery | Resmî feed, ilan, CPV, buyer | `CANDIDATE` | Otomatik |
| P1 – Parsing | PDF/HTML, lot, ekler, değişiklik | `NORMALIZED_LOT`, kaynak satırları | Otomatik + doğrulama |
| P2 – Eligibility | Route, ülke kapsamı, kontrollü ürün, zorunlu şartlar | Gate listesi | Hukukî hassas olan insan teyidi |
| P3 – Feasibility | OEM, sertifikalar, servis, Incoterms, teslimat | 32 metrik + eksik bilgi listesi | Kanıt tabanlı scoring |
| P4 – Commercial | OEM teklifi, müşteri fiyatı, boQ, ledger | Temel/stres marj, peak cash, finansman açıkları | Hesaplama otomatik |
| P5 – Decision | Score interval, status, gate, commercial | `decision`, `reasons`, `next_actions` | `BID_REVIEW` en yüksek otomatik aşama |
| P6 – Bid | Nihai fiyat, teklif dosyaları, imzalar, ödeme/garanti | `BID_APPROVED`, teslimat kaydı | Dört göz onay; otomatik ihale gönderimi yok |
| P7 – Outcome | Kazanç/kayıp, cash variance, teslim/kabul | Kalibrasyon veri seti | Dönemsel inceleme |

**Dosya önceliği:** en yeni resmî değişiklik/clarification → imzalı tender documents ve conditions → lot-specific technical specification / BoQ → ilan detail → notice summary → üçüncü taraf özet. Ancak birbirini çürüten iki *resmî* belge çözülmeden doğru ilan edilemez; `CONFLICT` ve `NEEDS_DOCUMENTS`.

**Zorunlu veri kökeni:** Her maddi alan için `value`, `unit`, `status`, `source_doc_id`, `page_or_section`, `exact_quote`, `extracted_at_utc`, `notice_version`, `human_verified`, `extraction_confidence`. LLM'in çıkarım olasılığı tek başına hukukî kanıt değildir.

---

## 3. Başlangıçta kesin gate kontrolleri

### 3.1 Gate veri tipi

```json
{
  "id": "MANDATORY_CERT_IMPOSSIBLE",
  "state": "FAIL",
  "verified": true,
  "human_reviewed": false,
  "scope": "UK_PRIME_TR_SUPPLIER / LOT-01",
  "evidence": [{
    "document_id": "official_tender_spec.pdf#sha256:...",
    "locator": "page 8, clause 4.2",
    "quote": "Must hold certificate X at submission"
  }]
}
```

State = `PASS | FAIL | UNKNOWN | NOT_APPLICABLE`. Veri çekilemediği için `FAIL` kullanmak yasak; ancak açık imkânsızlık kanıtıyla `FAIL` verilir. Menşe/ülke uygunluğu ve ihracat kontrolü gibi hukukî konularda nihai `HARD_NO_BID` kararı için `human_reviewed=true` de şart.

### 3.2 Hard-no-bid sınıfları

| Kod | Şart | İzlenecek aksiyon |
|---|---|---|
| `CONFIRMED_INELIGIBLE` | Sözleşme tarafı ihale koşullarına göre kesin katılamıyor | Alternatif route; hukuk onayı |
| `CONTROLLED_NOT_AUTHORIZED` | Ürün kontrollü, gereken izin/uyum altyapısı yok | Mevcut fazda teklif yok; hukuk incelemesi |
| `PROHIBITED_TRADE` | Teyitli yaptırım/ambargo/yasak | Teklif yok, uyum kaydı |
| `MANDATORY_CERT_IMPOSSIBLE` | Zorunlu ve muadili kabul edilmeyen belge sağlanamıyor | Alternatif OEM araştırması |
| `MANDATORY_LICENSE_IMPOSSIBLE` | Zorunlu lisans yok; meşru taşeron çözümü yok | Ret |
| `LOCAL_PREMISES_IMPOSSIBLE` | Zorunlu yerel fiziksel tesis/mağaza şartı karşılanamaz | Ret |
| `MANDATORY_HISTORY_IMPOSSIBLE` | Ciro/referans/personel kriteri, üçüncü taraf kapasitesi dahil karşılanamaz | Route değiştir/ret |
| `MATERIAL_SPEC_UNAVAILABLE` | Ürün için zorunlu teknik özellik, eşdeğer çözüm yok | Ret |
| `IMPOSSIBLE_DELIVERY` | Şartname teslim tarihine hiçbir geçerli model yetişmiyor | Ret |

**Hard gate değildir:** GPA `no`, farklı teklif dili, belirli CPV, askeri alıcı, toplam tahmini ihale değeri > €25k, ihalenin `Goods` diye etiketlenmiş olması, ISO belgesinin ilan özetinde yazmaması, markalı ürünün teorik olarak bulunmaması. Bunlar araştırma veya tercih sinyalidir.

### 3.3 Değerlendirme öncelik sırası

```
if most_recent_notice confirms expired/cancelled/awarded: ARCHIVE_EXPIRED
elif verified hard fail (required human sign-off where relevant): HARD_NO_BID
elif legal/export-control/market-origin route unclear: NEEDS_LEGAL_REVIEW
elif material document conflict or critical requirement unknown: NEEDS_DOCUMENTS
elif mandatory local support unsigned: NEEDS_PARTNER
elif 10+ year warranty unbacked or no compliant OEM quotation: NEEDS_SUPPLIER
elif cash stress calendar missing: NEEDS_FINANCE
elif stress peak has funding deficit: NEEDS_FINANCE or NO_BID_FINANCE
elif prices/costs cannot be validated: NEEDS_DOCUMENTS
elif base margin <12% or stress margin <12% (without signed exception): COMMERCIAL_NO_BID
elif absolute contribution below threshold (without signed exception): COMMERCIAL_NO_BID
elif framework has zero guaranteed call-offs: WATCH / exception review
else: interval-score decision subject to evidence threshold
```

**Kritik fark:** `ARCHIVE_EXPIRED` hukuken yasaklı ürünle aynı ret türü değildir; yalnızca artık canlı teklif yapılamaz. Eski ihaleler üretici/CPV öğrenim arşivinde kalır.

---

## 4. 32 alt metrik — 100 ağırlıklı puan

**Skala:** 0 kesin uyumsuzluk/ekstrem risk, 1 çok zayıf, 2 zayıf, 3 koşullu uygulanabilir, 4 güçlü, 5 hazır/kanıtlı. **Açık gate ihlali varsa skor tek başına karar vermez.** Aşağıdaki kriterlerin alt puanları *performans yönünde* tanımlanır: **5 her zaman iyidir**.

### A — Product & Supplier Fit (15 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **A1 / 5** Tam ürün uyumu | Ürün ailesi yakın ama işlev/ölçü belirsiz | Belirli model eşdeğer olabilir; açıklama bekliyor | Teknik çizim, model ve varyant şartnameye birebir uyar |
| **A2 / 4** Üretici kanıtı | Sözlü/arama motoru kaydı | İlgili ürün ailesi olan 1 doğrulanmış üretici | Yazılı fiyat, model, firma kaydı ve üretici kapasitesi teyitli |
| **A3 / 3** Kapasite ve lead time | MOQ ve üretim süresi uyumsuz/unknown | Üretici beklenen miktara olumlu ancak yazılı teslim yok | Kapasite, MOQ, stok, üretim ve sevkiyat günü yazılı teyitli |
| **A4 / 3** Kaynak dayanıklılığı | Tek üretici; kritik girdi veya kesinti riski | Alternatif ürün/üretici araştırması var | En az 2 uygun kaynak veya kanıtlı kesinti/fallback planı |

### B — Technical & Qualification Compliance (15 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **B1 / 5** Şartname satır matrisi | Kritik maddeler cevapsız | Büyük gereklilikler eşleşiyor, birkaç kanıt eksik | Her zorunlu gereklilik için ürün + katalog/test/eşdeğer ispatı |
| **B2 / 4** Mevzuat/test | Ürün kategorisi yüksek riskli ve sertifika yok | Mevzuat türü belirlendi; belge kapsamı teyit bekliyor | Ürün/model, sürüm, onaylayan kuruluş ve geçerlilik doğrulanmış |
| **B3 / 4** Şirket yeterliliği | Ciro/referans/personel/yerel kurum uyuşmazlığı | Uygunluk muhtemel; üçüncü taraf kapasitesi teyit bekliyor | İlgili sözleşme tarafı bütün seçim kriterlerini kanıtlayabiliyor |
| **B4 / 2** Dokümantasyon izlenebilirliği | Veriye kaynak yok | Çoğu ürün lot/seri/spec ile eşleniyor | Belge sürümü, numune, lot/serial, belge yetkilisi zinciri tam |

### C — Contract Execution (15 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **C1 / 4** Yerel teknik servis | Zorunlu yerel servis ve partner yok | İhtiyaç var, imzalı yetkili partner/plan mevcut | Yerel servis şartı yok; basit ürün iadesi yeterli |
| **C2 / 4** Kurulum/devreye alma | Ağır sahada teknik kurulum/commissioning | Sınırlı montaj/test; partner maliyeti hesaplanmış | Saf mal teslimi, yerinde uzman veya eğitim gerekmiyor |
| **C3 / 4** Garanti/yedek parça | 10–15+ yıl yükümlülük, OEM desteği belirsiz | Üretici back-to-back, 5–15 yıl risk karşılığı hesaplanmış | Kısa standart garanti, parçalar hazır, yazılı üretici taahhüdü |
| **C4 / 3** Call-off operasyonu | Düzensiz, küçük, aylık/haftalık siparişler | Toplu birkaç sipariş, teslimat planı/stoğu olabilir | Tek veya iki açık adetli teslimat; yeniden stok yok |

> Uzun garanti otomatik ret değildir; C3'te üst puan sınırlaması ve ayrıca **zorunlu OEM yazılı taahhüdü** tetikleyicisi vardır. Ürün görselinde `suitable for installation` demesi tek başına kurulum hizmeti isteniyor anlamına gelmez. `Supplier must install/commission` gibi ifadelere bakılır.

### D — Liquidity & Finance (20 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **D1 / 9** Stres nakit coverage | Stres peak açığı, fonun <%50'si mevcut | Stress timeline boyunca fon açığı yok, cover ≥1.0 | Stress timeline boyunca fon açığı yok, cover ≥1.5 |
| **D2 / 4** Fon kanıtı | Sözlü vaat / kişisel nakit UK şirketi gibi sayılmış | Doğrulanmış fon; bazı kısıt/transfer şartları var | İlgili şirkette serbest ve teyitli nakit/bağlayıcı kredi mevcut |
| **D3 / 4** Ödeme ve tahsilat | Uzun/onaysız kabul, ödeme/gecikme belirsiz | Ödeme mekanizması biliniyor; gecikme streslenmiş | Supplier credit ve buyer milestones güvenilir; worst-case tolere edilir |
| **D4 / 3** Teminat/rezerv | Teminat/banka blokesi belirsiz | Bond tutarı hesaplandı, rezerv hassas | Banka limitleri, risk tamponu ve teminat maliyeti teyitli |

**D1 otomatik hesaplanır; elle yüksek skor girişi geçersizdir.** Coverage aşağıdaki sermaye takvimiyle hesaplanır ve varsayımsal bankacılık imkânları teyitsizken sıfır sayılır.

### E — Unit Economics & Contribution (15 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **E1 / 6** Baz katkı marjı | <%10 | %15–19,99 | ≥%25 |
| **E2 / 3** Stres katkı marjı | <%10 | %15–19,99 | ≥%25 |
| **E3 / 3** Mutlak katkı | <£/€500 | £/€1.500–2.500 | ≥£/€5.000 |
| **E4 / 3** Sipariş kesinliği | Framework minimum 0 ve stok riski | Bazı minimum çağrılar kanıtlı | Tek teslim veya alıcının garantili siparişi |

`E1–E3` için üretici fiyatı ve **tüm doğrudan maliyetler** doğrulanmadan rating `MISSING` kalır; £12.500 ihale tahmini bedeli otomatik **Bozkor teklif bedeli olarak alınmaz**. Framework maksimum değeri garanti ciroya dönüştürülmez.

### F — Logistics & Border (10 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **F1 / 4** All-in landed cost | Gümrük/kargo/boşaltma/vergiler bilinmiyor | Yazılı freight teklifinin bir bölümü hazır | FCA/DAP/DDP, teslim noktası, sigorta, duty, broker ve local mile teyitli |
| **F2 / 3** Teslimat tamponu | En iyi halde deadline zor | Minimum üretim/transit sığıyor, tampon sınırlı | Üretim+QC+gümrük+son kilometre ve gecikme tamponu sığıyor |
| **F3 / 2** Saha handling | Adalar/uzak site/kritik forklift/çok teslim | Tek zor lokasyon; handling fiyatlandı | Standart adrese tek palet/kolay kabul, düşük hasar |
| **F4 / 1** Menşe ve ithalat belgesi | GTİP/ithalatçı/sorumluluk bilinmiyor | Sınıflandırma/ithalatçı belirlenmiş; evrak eksik | İthalatçı, beyan, vergiler, VAT timing ve gerçek menşe net |

**A.TR ≠ Türk menşe belgesi.** UK şirketinin teklife uygunluğu ile Türkiye menşeli malın kabulü ayrı alanlardır. Gümrükte geri alınabilir VAT bile ödeme/geri alma zamanları arasında nakit açığı yaratabilir.

### G — Deadline & Delivery Preparation (5 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **G1 / 2** Teklif penceresi | ≤5 iş günü | 11–20 iş günü | >35 iş günü |
| **G2 / 1** Üretim-teslim planı | Süre belirsiz veya gerçekçi değil | Teslim mümkün ama tampon sınırlı | Yazılı lead time ve anlamlı teslimat tamponu |
| **G3 / 1** Numune/teklif dili | Zor/ulaşılamayan numune veya teknik çeviri | Yetişebilir, çeviri/numune planlı | Dosyalar hazır; yeterli dil ve örnekleme kapasitesi |
| **G4 / 1** Saha/clarification | Soru ve site visit süresi kaçırıldı | Soru listesi var, buyer dönüşü bekleniyor | İlgili tüm sorular kapatılmış, gerekiyorsa saha incelenmiş |

Teklif tarihini teslim tarihiyle karıştırma. Tatiller/çalışma günü ülkeden ülkeye farklıdır; referans kodda G1 yalnız hafta içi yaklaşık sayım yapar, üretim takvimi değildir.

### H — Competition & Bid Effort (5 puan)

| ID / ağırlık | 1 puan | 3 puan | 5 puan |
|---|---|---|---|
| **H1 / 2** Rekabet avantajı | Fiyat/kalite avantajı görünmüyor | Maliyet avantajı mümkün ama rakip veri eksik | Teslim dahil fiyat + kalite belgeli ve anlamlı avantaj |
| **H2 / 1** Award score fit | Kritik puanlar Bozkor'un zayıf olduğu yerde | Metodoloji belli; kazanma mantığı makul | Açık değerlendirme matrisi ve ölçülebilir avantaj |
| **H3 / 1** Teklif maliyeti ROI | Numune/çeviri/belge yükü katkıyı tüketiyor | Teklif maliyeti makul ancak yüksek | Düşük bid cost, reutilizable belgeler, iyi katkı potansiyeli |
| **H4 / 1** Rakip/benchmark | OEM/yerel tedarikçi yapısı aleyhte | Pazar araştırması kısmi | Rakip ürün-fiyat, award geçmişi, alıcı davranışı verili |

Bilinmeyen kazanma olasılığı için yapay `%70 chance to win` yazılmaz. İstatistiksel kazanma olasılığı modelinin eğitimi için gerçek geçmiş ihaleler ve teklif sonuçları gerekir.

---

## 5. Kanıt kalitesi ve skor intervali

Her metrikte şu veri tipi uygulanır:

```json
{
  "B1": {
    "rating": 4,
    "quality": "PROVISIONAL",
    "evidence": [{
      "document_id": "tender_technical.pdf",
      "locator": "p.2, Tables",
      "quote": "Galvanised steel, powder coated"
    }]
  }
}
```

| Durum | Interval (0–5 içinde) | Anlam |
|---|---|---|
| `VERIFIED` | `[rating, rating]` | Primer belge ve gerekçe var; uzman yorumu gerekebilir |
| `PROVISIONAL` | `[rating−1.5, rating+1.5]` | Makul ama henüz tam teyit yok |
| `MISSING` | `[0, 5]` | Bilgi yok, ret veya uygun kabul edilemez |
| `CONFLICT` | `[0, 5]` | Kaynak uyuşmazlığı; karar hold |

Puan formülü:

\[
S_{\min}=\sum_i w_i\frac{l_i}{5},\quad S_{\max}=\sum_iw_i\frac{u_i}{5}
\]

`verification_coverage = (VERIFIED altmetriklerin toplam ağırlığı) / 100`.

Örnek: `score_interval=69–91`, `verified_weight=62%` ise kullanıcıya “80/100 doğrulanmış ve teklif verilebilir” denmez. **Aralık + kanıt kapsamı + eksik kritik alanlar** birlikte gösterilir. İç sıralama için hesaplanan orta nokta **kalıcı GO skoru değildir**.

**Karar kısıtı:** `BID_REVIEW` için en az `%80 VERIFIED weight`, `score_min≥85`, bütün kritik kontrollerin `PASS/N/A` olması, stres finansman açığının bulunmaması, geçerli ürün/üretici fiyatı ve en düşük stres marj koşulları gerekir. Bu katı bir ilk sürüm politikasıdır ve test edilerek güncellenir.

---

## 6. Kesin nakit modeli: kontrat değeri değil maksimum fon ihtiyacı

### 6.1 İşlem bazlı nakit defteri

Her işletme nakit hareketi:

```
(day_from_award, currency, cash_amount, event_type, payer/payee,
 evidence_ref, scenario, relevant_entity, incoterm, taxable/recoverable)
```

`amount < 0` gerçek nakit çıkışı; `amount > 0` gerçekleşecek müşteri tahsilatı/VAT iadesi gibi nakit girişi. **Sipariş kabulü veya fatura kesilmesi, banka tahsilatı değildir.** İthalat KDV'si ve varsa geri alınması iki ayrı tarihli olaydır. Alıcı teminatı nakit bloke ediyorsa teminat da zamanlı nakit çıkışıdır.

Örnek olaylar: supplier deposit; progress payment; balance-before-dispatch; packing, inspection; shipment; cargo insurance; customs duty; brokerage; import VAT paid; last mile + unloading; samples; local installer; warranty reserve cash expenditure; buyer payment received; VAT refund; bond release. Farklı fonlar ancak **ilgili sözleşme tarafında ve ilgili günde teyitle hazırsa** kullanılır.

### 6.2 Formül

\[
C_t=\sum_{j:d_j\leq t}\text{operating_cash_event}_j
\]
\[
F_t=\sum_{k:d_k\leq t}\text{confirmed_funding_event}_k
\]
\[
\text{PeakUnfundedCash}=\max_t(0,-C_t)
\]
\[
\text{FundingShortfall}=\max_t(0,-(C_t+F_t))
\]

Karşılaştırma yalnız aynı para biriminde. Başka para birimi kullanılıyorsa tarihli FX snapshot ve stres kuru uygulanır. Gerçek sermaye transferi ve borç geri ödeme politikası olmadan TR/şahsi fon UK nakdi olarak sayılamaz.

`D1` için confirmed funding / peak unfunded cash oranı yanında **FundingShortfall = 0** şartı aranır. Çünkü paranın 60. günde bulunması 1. gündeki üretici avansını ödeyebilmek demek değildir.

### 6.3 Senaryolar

| Değişken | Base | Stress örneği | Severe örneği |
|---|---|---|---|
| Üretici maliyeti | Yazılı teklif | Kur/ham madde +%10 | +%20 |
| Navlun | Forwarder teklif | +%25 | +%40 |
| Üretim | OEM lead time | +14 gün | +30 gün |
| Müşteri kabulü/tahsilatı | Sözleşme tarihi | +30 gün | +60 gün |
| Hasar/yeniden sevkiyat | Teknik garanti karşılığı | %3 tutar | %5–8 tutar |
| İthalat VAT iadesi | Belgelendiği tarihte | +30 gün gecikme | +60 gün gecikme |
| FX | Kayıtlı forward/rate | %5 aleyhte | %10 aleyhte |

Bu yüzdeler **başlangıç stres varsayımlarıdır**, pazar verisi veya finansman kurumu teklifi değildir. Ürün sınıfına göre değiştirilmeli. Örneğin plastik mobilyada hacim/navlun, yüksek güvenlikli medikal cihazda test/servis daha hassas olabilir.

### 6.4 Nakit ve marj ayrı şeylerdir

```
verified_offer_value_ex_vat
- verified_factory_cost
- packaging_and_samples
- freight_insurance_duties_customs
- importer_fees_and_delivery
- site_work_testing_training
- transaction_specific_financing_and_bond_cost
- warranty_spares_expected_cost
- attributable_fx_contingency
= contribution_before_overheads_and_corporate_tax
```

**Geri alınabilir VAT** (koşulları gerçekten sağlıyorsa) kâr maliyetine eklenmeyebilir, fakat nakit takviminde taşınır. Geri alınamaz VAT doğrudan maliyet olabilir. Bidderın KDV/VAT kayıt ve ithalatçı statüsü netleştirilmeden DDP fiyat varsayılmaz.

---

## 7. Sözleşme koşulları ve otomatik risk çıkarımı

Parser her lot için aşağıdaki feature bayraklarını çıkarır, **negative assertion için tüm relevant ekleri kontrol eder**.

| Tespit | Puan/risk etkisi | Tetiklenecek araştırma |
|---|---|---|
| `must install`, `shall commission`, `operator training` | C1/C2 düşük, partner yolu | Onsite labour ve sorumluluk kapsamı |
| `UK-based service`, `24/7`, `response within 4h` | Partner yoksa `NEEDS_PARTNER` | İmzalı SLA ve servis teklifi |
| `warranty 15 years` | C3 cap2 (back-to-back yoksa) | OEM yazılı garanti, spare parts, güvence |
| `framework`, `no guarantee of business` | E4 düşük; `WATCH` blokajı | Minimum call-off, fiyat endeksleme, stok |
| `manufacturer-authorised`, `approved source` | B2/B3 araştırma | OEM yetki mektubu ve kaynağın kapsamı |
| `ISO 9001 held by bidder` | B3 gate/uygunluk | Üreticinin ISO'su bidder ISO'su yerine geçer mi? |
| `FSC-certified oak` | B1/B2 ve timber traceability | Sertifikanın ürün zinciri, metal alternatifleri |
| `must have local shop / owned premises` | Şart kesin karşılanmazsa hard gate | Alıcının yerel tesis şartı |
| `Supplies` + `maintenance` | Gizli hizmet riski | Work breakdown ve servis tahmini |
| `price 60 / quality 40` | H2 kalite dosyası | Ayrıntılı marking matrix |
| `100% price` | H2 avantaj olabilir, marj baskısı | Tam teknik PASS ve rakip fiyatı |
| `award cap vs expected value mismatch` | `CONFLICT` | Alıcı clarification |
| `DKK value field appears quantity units` | `CONFLICT` | Para/adet ayrımı |
| `GPA no` | Hukuk araştırma | Ülke uygunluğu; **otomatik ret yok** |
| `contract duration 4 years, est €20k` | C4/E4 küçük parçalı iş riski | Order frequency, minimum basket, location |
| `supplier shall provide own forklift` | F3/C2 | İndir/yerleştir sorumluluğu |

**Negation parsing:** `installation within a publicly accessible outdoor space` ile `supplier shall install and anchor the furniture` farklı anlam taşır. Başlık/CPV bir alımın kapsamını geçersiz kılamaz. 15 yıllık garantide tüketicinin hangi kusurlarda, kime, hangi sürede başvuracağı sözleşmeye göre kontrol edilir.

---

## 8. Operasyonel kararlar ve kaynak planlaması

| Decision | Tanım | Otomatik bir sonraki iş |
|---|---|---|
| `ARCHIVE_EXPIRED` | Süresi geçen/iptal olan/sonuçlanan | Arşive taşı, kategori sinyali sakla |
| `HARD_NO_BID` | Doğrulanmış yasal/teknik imkânsızlık | Mevcut route/lot kapat; alternatif route incele |
| `NEEDS_LEGAL_REVIEW` | Kontrole tabi/uygunluk/menşe belirsiz | Hukuk/uyum sorusu oluştur |
| `NEEDS_DOCUMENTS` | Lot/boQ/yeterlilik/tutar/şartname çelişkisi | Belge indir, source anchor, buyer question |
| `NEEDS_SUPPLIER` | OEM fiyatı, kapasite, sertifika/garanti yok | RFQ oluştur, üretici adayları bul |
| `NEEDS_PARTNER` | UK/EU servis/kurulum/yerel tesis eksik | Yetkili servis/iş ortaklığı araştır |
| `NEEDS_FINANCE` | Nakit takvimi/finansman opsiyonu eksik | Fon akışı, banka/üretici vade modeli |
| `NO_BID_FINANCE` | Stress cash gap doğrulanmış, finansman yolu yok | Alternatif prime veya ret |
| `COMMERCIAL_NO_BID` | Düşük marj, düşük mutlak katkı, yük fazla | Gerekçeli arşiv |
| `WATCH` | Kategori uygun ama belirsizlik/fırsat gecikmesi var | Yenileme ve benzer ilan takibi |
| `SHORTLIST` | İnceleme için yeterince güçlü | Plan, fiyat ve legal check |
| `BID_REVIEW` | Belgelerle güçlü aday | CFO/Finance + Legal/Compliance + Technical + Director imzası |

### 8.1 Aksiyonların zamanlanması

SLA = `min(deadline_to_submit, clarification_deadline, supplier_quote_deadline)`; ilk aşamadaki belge isteği son teklif gününe bırakılmaz. Örnek öncelik:

```
ActionPriority = impact_if_unresolved × urgency × route_feasibility
```

Bu bir **görev sıralama heuristiğidir**, yasal uygunluk yerine geçmez. `impact` 1–5; `urgency` son soru gününe kalan iş günüyle artar; `route_feasibility` 0–1. Son soru sorma tarihi geçmiş ve zorunlu cevap bulunamıyorsa `NO_BID` riski yükselir.

### 8.2 Portföy kapasitesi

Aynı 17k EUR operasyon nakdi beş farklı ihalede beş kez kullanılabilir varsayılamaz. Birden fazla teklif kazanmaya dönük senaryolarda **ortak tarihli likidite takvimi**, garanti limitleri ve üreticinin eşzamanlı kapasitesi kontrol edilir. Tüm açık tekliflerdeki teminat blokelerinin toplamı ayrıca izlenir.

---

## 9. Üretici-veri tabanı ve teknik compliance matrisleri

### 9.1 Supplier master alanları

`vendor_id, registered_name, country, verified_contact, website, products, HS_codes, machinery_capability, dimensions_tolerance, materials, coating, MOQ, standard_lead_days, verified_capacity_per_month, cash_terms, Incoterm, production_references, certificates{scope,valid_to}, country_of_origin, price_quote{valid_to}, sample_cost, tooling_cost, warranty_terms, spare_parts, OTD, quality_claims, export_experience, blacklisted/sanction_checked_on, last_verified_at`.

Firma ismi benzerliği sertifika uygunluğuna kanıt değildir. OEM teklifindeki ürün modelini ve ihale teknik şartnamesini ilişkilendirmeden A/B maksimum puan verilmez.

### 9.2 Compliance matrix

| Requirement ID | Zorunlu mu? | Şartname | Teklif edilen model | Evidence ref | Durum |
|---|---|---|---|---|---|
| T01 | Evet | Sandalye frame powder-coated aluminium | Model X | Katalog/çizim | VERIFIED/UNKNOWN |
| T02 | Evet | 15-year warranty | OEM warranty | İmzalı taahhüt | VERIFIED/UNKNOWN |
| T03 | Evet | UK local servicing | OEM/partner | SLA | VERIFIED/UNKNOWN |

Zorunlu gerekliliğin `FAIL` olması skorlar yüksek olsa dahi teklifin uygunluğunu bloke eder. `equivalent` kabulü yalnız resmî şartname veya açıklama ile doğrulanır.

---

## 10. Veri modeli, API sözleşmesi ve örnek çağrı

### 10.1 Referans Python motoru input modeli

`opportunity_id, lot_id, lifecycle, route, context, gates[], critical_checks{}, submetrics{}, finance{}, economics{}`.

- `lifecycle.deadline`: mutlaka offset'li ISO 8601, örn. `2026-11-09T12:00:00+00:00`.
- `latest_notice_verified`: iptal/uzatma kontrolü yapılmış mı?
- `route.eligibility`: `PASS/FAIL/UNKNOWN`; `context.origin_access`: ayrı.
- `context.product_control_classification`: `NOT_CONTROLLED`, `CONTROLLED_REVIEWED`, `UNKNOWN`.
- `critical_checks`: 9 kritik kontrolün hepsi `PASS` veya `NOT_APPLICABLE` olmalıdır.
- `submetrics.A1`..`H4`: `{rating:0..5,quality:'VERIFIED'|'PROVISIONAL'|'MISSING'|'CONFLICT',evidence:[...]}`.
- `finance.base` ve `finance.stress`: aynı para biriminde `operating_events[]`, `funding_events[]`. Finansman kanıtı olmayan girişler `verified:false`.
- `economics.bid_price_ex_vat`: **gerçek teklif bedeli**; `base_costs`, `stress_costs`, `quotes_verified`, `costs_complete`, `stress_costs_complete`.
- `context.supplier_ready`, `supplier_quote_verified`, `signed_local_service_partner`, `warranty_years`, `warranty_back_to_back`.

Birden fazla lot veya route, **bir JSON array** olarak motora iletilebilir; sonuçlar ayrık döner.

### 10.2 Örnek minimal mali olay

```json
{
  "day": 0,
  "amount": -4500,
  "currency": "GBP",
  "category": "OEM_DEPOSIT",
  "evidence_ref": "manufacturer_proforma_2026_10_14"
}
```

Finansman girişi ancak:

```json
{
  "day": -1,
  "amount": 8000,
  "currency": "GBP",
  "verified": true,
  "available_to_bidding_entity": true,
  "entity": "BOZKOR LTD",
  "evidence_ref": "bank_statement_or_binding_credit"
}
```

Kanıtlı `funding_event` olarak dikkate alınır. **Üreticiye ödemeyle aynı günde gelen banka transferi** için zaman sırası net değilse motor muhafazakâr davranır ve çıkışı önce işler; bunu bankanın gerçek cut-off saatine göre güncellemek gerekir.

### 10.3 Çıktı

```json
{
  "opportunity_id": "...",
  "lot_id": "...",
  "route_id": "UK_PRIME_TR_SUPPLIER",
  "decision": "NEEDS_SUPPLIER",
  "reason_codes": ["UNBACKED_LONG_WARRANTY"],
  "scores": {
    "score_lower": 34.6,
    "score_upper": 89.2,
    "verified_weight_pct": 36.0
  },
  "finance": {"base": {}, "stress": {}},
  "unit_economics": {"status": "MISSING"},
  "tasks": ["obtain_factory_warranty_and_spareparts_undertaking"],
  "human_bid_approval_required": true
}
```

Yukarıdaki puanlar **yalnız JSON yapı örneği**, gerçek ihaleye ait ölçüm değildir.

---

## 11. QA/Red-Team testleri (zorunlu)

1. Süresi dolan 2024 ihalesi, ürün uyumu 100 olsa dahi `ARCHIVE_EXPIRED`.
2. `GPA no` otomatik yasaklı katılım oluşturmaz.
3. Savunma kurumu alıcısı kontrol listesine giren ürün kanıtı değildir.
4. `Supplies` + zorunlu commissioning + UK local servicing = koşullu partner.
5. Teknik ilanda `FSC oak or aluminium`: ahşap FSC zorunluluğu alüminyum alternatifi için uydurulamaz.
6. 15 yıl garanti fakat OEM taahhüdü yok = yüksek skor olsa bile `NEEDS_SUPPLIER`.
7. İhale miktarı 26,080 adet ama TED tutar alanına DKK girilmişse `CONFLICT`; 26,080 DKK varsayılamaz.
8. 2 milyonluk framework + kanıtlı 10k call-off + vade = büyük tutar diye otomatik ret yok.
9. £12.5k tek teslim + yüksek doğrulanmış marj + finansman = küçük diye otomatik ret yok.
10. Geçmiş 4 yıllık toplam €20k, teslim 100 parti ve minimum sipariş sıfırsa uygun basit ürün tek teslim sanılamaz.
11. İthalat VAT geri alınabilir olsa dahi gümrük günü nakit çıkışı olarak modele girer.
12. UK şirketi bankada £15 iken kişisel/TR hesabındaki €25k kanıtsız şekilde UK likiditesi olamaz.
13. Ödeme ancak kabulden 60 gün sonra; `invoice_issued` customer cash-in sayılmaz.
14. Üretici rakamı yokken ihalenin tahmini bütçesi `bid_price` sayılmaz.
15. Üretici ISO belge sahibi ancak bidder ISO şartı varsa uygunluk kanıtı olmaz; buyer kuralı incelenir.
16. Puan 92 ama kritik belge eksikse `BID_REVIEW` verilmez.
17. Fiyat + kalite değişik ilan sürümünde farklıysa eski matriks superseded edilir.
18. Bir lot uygunsuzsa diğer lotlar otomatik elenmez.
19. UK ve TR prime aynı parayı iki kere kullanamaz; shared portfolio ledger gerekir.
20. Kâr pozitif, stress cash gap negatif ise teklif onayı verilmez.

**Başarı ölçütleri:** Hard-gate false negative = 0 hedef (mutlak doğruluk garanti edilemez); expired doğru arşiv oranı; belge çelişki yakalama; finansman açığı zamanlaması doğruluğu; karar açıklamasında source-link coverage. İlk veri setiyle precision/recall ve yanlış eleme maliyeti raporlanmalıdır.

---

## 12. Üretim uygulama önerisi

**Aşama A / 2–3 hafta (MVP):** resmî ilan alımı, lot parser, version/dedup, source anchors, hard gate, submetric skoru, tek-senaryo cashflow, dashboard. İlk 30 eski ve 20 güncel ihale elle etiketlenip kontrol edilir.

**Aşama B:** EU/UK shipment quoting, tedarikçi kartları, otomatik OEM RFQ taslakları, finansman route karşılaştırma, cashflow stress, quality evidence matrix; 100 örnekle precision/recall analizi.

**Aşama C:** gerçek bid outcomes, award/competitor intelligence, fiyat dağılımı, lot bazlı alıcı geçmişi, kalibre edilmiş kazanma olasılığı. Veri gelene kadar hiçbir kazanma yüzdesi tahminini gerçekte model çıktısı gibi göstermeyin.

**Güvenlik ve audit:** servis token'ları ayrı secret manager'da, kullanıcı/şirket finans belgeleri erişimi rol bazlı, ilgili mevzuata uygun veri saklama, her skor ve karar için `input_hash`, `document_hash`, `policy_version`, `model_version`, `reviewer`, `reason_code`, `decision_timestamp`, `previous_version` kaydı. Kaynakların robots/TOS/API sınırlarına uyum gerekir.

---

## 13. Önemli teknik sınırlamalar ve sonraki geliştirmeler

- Referans Python motoru, **kanıta dayalı karar mantığı + 32 ağırlık + iki nakit senaryosu** sağlar; üretici araştırması, hukukî uygunluk, PDF ayrıştırma, gerçek FX, kurumsal banka API'si veya bütün CPV kodlarının güncel doğrulamasını kendisi gerçekleştirmez.
- Bir kısmı belgelere dayalı **uzman/LLM rating** gerektirir; tüm 32 metrik tümüyle otonom objektif olarak ölçülmüş değildir. Doğrudan hesaplanabilen D1, E1, E2, E3, E4 ve G1 hesaplama motoruyla override edilir.
- Referans engine tek para birimi kabul eder ve **fon transferi hukuken/operasyonel olarak doğrulanmış olmalıdır**. Bu nedenle çok para birimli portföy/kur risk motoru daha sonra eklenmelidir.
- Tarih sayacı hafta sonlarını çıkarır, resmî tatil/özel ihaleye özgü yerel takvim içermez.
- `VERIFIED` kaynak mevcut demektir; gerçek sertifika otantikliğini ve bütün belge anlamını makine tek başına garanti edemez.
- Tek başına veri derlemesi veya skor yüzünden alıcıya otomatik teklif/beyan gönderilmemelidir.

## 14. Kısa karar kartı standardı

```
TENDER: [buyer / lot / deadline / estimated value / currency]
ROUTE:  [UK prime / TR prime / OEM prime / consortium]
STATUS: [NEEDS_DOCUMENTS / ... / BID_REVIEW]
FIT:    [score_lower .. score_upper /100]  VERIFIED COVERAGE: [%]
RED:    [verified non-negotiable conditions]
YELLOW: [technical/source/financing unknowns]
FINANCE: [base peak / stress peak / eligible funding / peak gap]
MARGIN: [base / stress / minimum guaranteed order]
ACTION: [next 3 concrete steps, owner, due date]
PROVENANCE: [notice version, contracts, referenced clauses]
HUMAN APPROVAL: REQUIRED
```

**Sonuç:** BOZKOR V2, bir ihale “uygun kategori” diye körü körüne GO vermeyi veya bir belge eksik diye potansiyel fırsatı otomatik öldürmeyi önlemek için tasarlanmıştır. Ölçülen fırsat kalitesi ile kanıt/uygulanabilirlik seviyesi bilinçli biçimde ayrılmıştır.
