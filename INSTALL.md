# LLM Visibility — Test Kurulumu

Bu extension ChatGPT'deki sohbetleri yerel olarak yakalar, brand mention'larını
sayar ve cevaptaki cümleleri kaynaklara bağlar. Hiçbir veri dışarı gitmez.

## Kurulum (5 dk)

1. **Zip'i aç.** İçinden çıkan `dist/` klasörünü bir yere koy (Desktop yeter).
2. Chrome'da `chrome://extensions` adresini aç.
3. Sağ üstteki **Developer mode** anahtarını aç.
4. **Load unpacked** butonuna tıkla → biraz önce çıkardığın `dist/` klasörünü seç.
5. Toolbar'da yeşil **LV** ikonu görünmesi lazım. Görünmüyorsa puzzle parçası
   ikonuna tıkla → LLM Visibility'yi pin'le.

## Nasıl Test Edilir

1. **chatgpt.com** aç (uyarı: `chat.openai.com` üstünde **çalışmaz** — extension
   sadece `chatgpt.com` host'unu izliyor).
2. ChatGPT'ye **arama gerektiren** bir soru sor. Örnek:
   - "Anthropic'in en son model release'i ne?"
   - "Türkiye'deki güncel SEO ajansları neler?"
3. Cevap akışı bittiğinde toolbar'daki **LV** ikonuna tıkla.
4. **Latest** sekmesinde son yakalanan capture'ı görürsün:
   - Prompt önizlemesi (yeşil kart)
   - Ghost % rozeti, unsourced % rozeti
   - Fan-out queries (ChatGPT'nin arka planda attığı arama sorguları)
   - Primary citations (cevapta görünen kaynaklar)
   - Cümle-cümle attribution (her cümlenin hangi kaynağa bağlandığı)

> **Not:** ChatGPT bazı sorulara arama yapmadan cevap verir. Bu durumda
> `💭 no-search` rozeti çıkar — bu bir bug değil, ürünün bilinçli olarak
> gösterdiği bir sinyal: "model bunu kendi prior'undan cevapladı, harici
> kaynak kullanılmadı."

## Sekmeler

- **Latest** — son capture'ın detayları
- **History** — tüm geçmiş, prompt/domain/brand üstünde arama, CSV export
- **Brands** — `⚙` butonundan brand listesi tanımlanırsa bu sekmede
  agregasyon görünür (toplam mention, primary/supporting/ghost dağılımı)
- **Domains** — tüm geçmişte hangi domain'lerin ne sıklıkla cite edildiği,
  hangilerinin "ghost" olduğu (ChatGPT'nin görüp de cite etmediği). Bir
  domain'e tıklayınca o domain'in zaman çizelgesi açılır.

## Geri Bildirim İçin Yararlı Şeyler

- **Capture düşmediği** bir senaryo (hangi soru, ne tip yanıt)
- **Ghost yüzdesi şüpheli** görünen bir capture (ekran görüntüsü iyi olur)
- **Attribution'ın saçmaladığı** bir cümle: doğru kaynağa bağlamadığı,
  ya da unsourced gösterip aslında cite edildiği bir örnek
- Brand listesi eklediysen brand match'lerinin **eksik / fazla** olduğu
  durumlar
- Pop-up yerine ayrı sekmede açmak istersen header'daki `↗` butonu

## Veri Saklama / Silme

- Tüm capture'lar Chrome'un kendi IndexedDB'sinde, **sadece bu profilde**.
- Brand listesi `chrome.storage.sync`'te (Google hesabınla diğer Chrome
  cihazlarına otomatik senkron olur — istemiyorsan Google senkronu kapat).
- `chrome://extensions` → LLM Visibility → **Remove** dersen tüm veri silinir.
- **Tek capture sil:** History sekmesindeki bir kartı aç → modal header'ında
  kırmızı **Sil** butonu. Onay sorar.
- **Tüm capture'ları sil:** `⚙` Options → **Veri yönetimi** bölümü.
  Brand listesi etkilenmez.
