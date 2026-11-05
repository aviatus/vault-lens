# Changelog

## 0.7.0

- Dağıtım paketindeki JS/CSS `esbuild` ile küçültülüyor (87 KB → 49 KB); `E2E_EXTENSION` ile uçtan uca testler paketin kendisine karşı çalıştırılabiliyor.
- Proje adı: **Vault Lens**. Paket dosyası `dist/vault-lens-<sürüm>.zip`.
- Eklenti içi klavye kısayolları kaldırıldı (`Alt+Shift+V` duruyor).
- Her vault kendi son konumunu hatırlar; vault değiştirip geri dönünce kaldığın klasör/secret açılır.
- Son vault'a ulaşılamazsa (VPN, sealed, kapalı) PIN ekranında veya boş listede takılma yok: vault listesi hatayla gösterilir.
- Vault listesindeki nokta vault'un kullanılabilir olup olmadığını gösterir: yeşil bağlı ve token geçerli; kırmızı ulaşılamıyor veya token reddedildi; sarı sealed, redirect veya adres izni yok. Kontrol `sys/health` + kayıtlı token'la `lookup-self` (salt okunur), 5 sn zaman aşımı.
- Sayfa geçişlerinde ara "Loading…" ekranı yok: yeni ekran verisi gelince tek seferde çizilir, popup açılırken son yüksekliğinde başlar. Geç gelen yanıtlar vault değişimi veya kilitten sonra ekrana yazılmaz.
- Kasma giderildi: "For this site" taraması ekran oturduktan sonra ve en fazla 2 istekle arka planda çalışır (arama başlayınca 8'e çıkar), sonucu popup açık kaldıkça vault başına saklanır; vault açılırken token kontrolü ile ilk ekranın verisi aynı anda istenir.
- Arayüz düzenlendi: listeler ve ayarlar kartlarda, turuncu sadece ana eylemde, "+ Add vault" ve "Change PIN" düğme olarak, ince yazı ağırlıkları, kırmızı sıfırlama düğmesi, düzenle/sil satır üzerine gelince; secret araç çubuğu tek düzende; kilit sayacı dakika olarak (son dakikada saniye); vault satırında sadece "Token needed" uyarısı; görünmeyen "read-only" etiketi kaldırıldı.
- Bağlanırken bekleme işareti: başlığın altında ince ilerleme çubuğu (200 ms'den uzun beklemelerde), tıklanan vault satırında "Connecting…", kontrol süren durum noktası yanıp söner. Vault isteklerine 15 sn zaman aşımı; cevap gelmezse "did not answer within 15 s … (VPN?)" mesajı. Beklerken başka vault açılırsa geç gelen cevap ekranı değiştirmez.
- Token reddedilince, token yoksa veya adres izni yoksa düzenleme formu kendiliğinden açılmaz: liste en üstte kalır, mesajın yanında tek düğme çıkar ("Paste new token", "Add token", "Allow access").
- Vault eklerken önce adres izni istenir ("Allow access"), token ve PIN alanları izin alınınca açılır. Ad, adres ve ortam taslak olarak `chrome.storage.session`'da tutulur (token/PIN asla); izin penceresi popup'ı kapatırsa form geri gelir. İzin verilince popup kendiliğinden yeniden açılmaya çalışır ve doğrudan forma döner.
- Güvenlik (run-3 denetimi): kilit, beklemedeki vault açılışını iptal eder (token tekrar ekrana gelmez, PIN ekranının yerine liste çizilmez); Ayarlar kilitliyken açılmaz; "Change PIN" sadece kilit açıkken çalışır ve yanlış denemeleri sayar; yanlış PIN sayacı sayfalar arası kilitli (`navigator.locks`); yanlış-PIN silmesi ile "Forgot PIN" aynı verileri temizler; kayıtta token kontrolü sırasında kilit gelirse hiçbir şey yazılmaz; geçersiz ayar değerleri yok sayılır; paketleme sembolik bağlantıları ve sayısal olmayan sürümü reddeder, test kancasını tüm .js dosyalarında arar.
- "For this site" önerileri kaldırıldı; `activeTab` izni ve test için kullanılan `?tab=` parametresi de gitti. Arama indeksi artık sadece arama yapınca oluşturuluyor.
- Vault görünümünde seçicinin yanında "Open this page in the vault's web UI" düğmesi: vault'un kendi arayüzünü o an açık olan yerde açar (KV v2/v1 klasör ve secret sayfası, eski sürüm görüntüleniyorsa o sürüm; TOTP için secrets listesi). Adresler Vault 1.18 ile doğrulandı; token aktarılmaz, Vault giriş isteyip sonra o sayfaya döner.
- Erişilemeyen vault'a geçince eski vault'un içeriği ekranda kalmaz.
- Geri yüklenen secret/klasör artık açılmıyorsa bir üst seviye gösterilir.

## 0.6.0

- İlk dağıtılabilir paket: `npm run package` ile paketlenebilir ilk sürüm.
- Sabit eklenti ID'si (`cgkcicfmobickhpfbdaepdiehjfhefan`): her bilgisayarda aynı.
- Token'lar Vault eklenirken girilir ve PIN'den türetilen anahtarla şifrelenip saklanır; PIN saklanmaz.
- PIN süresi (varsayılan 15 dk), arka planda kilitlenme, "Forgot PIN?" ile sıfırlama (PIN ekranı ve Settings).
- KV v1/v2 ve TOTP okuma, arama, favoriler, son açılanlar, "For this site" önerileri, versiyon geçmişi.
- Radix Colors tabanlı açık/koyu tema.
- Güvenlik: salt-okunur istekler (GET/LIST), yönlendirmeler takip edilmez, `..` path parçaları reddedilir,
  `.env` çıktısı shell için güvenli, pano belirli süre sonra temizlenir.
