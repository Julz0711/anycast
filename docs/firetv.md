# AnyCast auf dem Fire TV Stick

Die Fire-TV-App ist nur eine Hülle: ein Vollbild-Browser, der die AnyCast-Web-App öffnet,
mit eigenem Symbol auf dem Startbildschirm. Steuern geht am bequemsten mit dem Handy über
`/remote` (Einstellungen › Remote). Der Code liegt in `android/`, gebaut wird sie bei jedem
Merge in `main` und steckt im Docker-Image. Der Server liefert sie unter `/firetv.apk` aus.

## Installieren

1. **Entwickleroptionen freischalten:** Einstellungen › Mein Fire TV › Info › siebenmal auf
   den Gerätenamen (z. B. „Fire TV Stick HD“) klicken, bis „Sie sind jetzt Entwickler“ erscheint.
2. **Downloader** aus dem Amazon Appstore installieren (Suche: „Downloader“, orangenes Symbol).
3. Einstellungen › Mein Fire TV › Entwickleroptionen › **Apps unbekannter Herkunft
   installieren** › Downloader auf **An**.
4. Downloader öffnen und im Heimnetz diese Adresse eingeben:
   `http://192.168.0.232:8787/firetv.apk`
   (mit Tailscale geht auch `https://anycast.gtkncht.com/firetv.apk`). Installieren, danach
   kann Downloader die APK löschen.
5. Für den Zugriff über `https://anycast.gtkncht.com` (Standard der App) **Tailscale** aus dem
   Appstore installieren und anmelden. Ohne Tailscale: in der App die Heimnetz-Adresse wählen.
6. AnyCast liegt jetzt unter „Apps“. Zum Anpinnen auf dem Startbildschirm: Apps › AnyCast
   markieren › Menütaste › Verschieben / Nach vorne.

## Bedienung

- **Menütaste** (drei Striche) auf der Fernbedienung: Adresse ändern (Standard,
  Heimnetz `http://192.168.0.232:8787` oder eigene).
- **Zurück:** eine Seite zurück in AnyCast, auf der ersten Seite schließt die App.
- Ist der Server nicht erreichbar, fragt die App: nochmal versuchen, Heimnetz oder Adresse ändern.
- Der Bildschirm bleibt an, Videos starten ohne extra Klick.

## Aktualisieren

Neues Image auf dem Server ziehen (siehe casaos.md), dann in Downloader wieder
`/firetv.apk` laden und installieren. Adresse und Anmeldung bleiben erhalten, weil jede
Version mit demselben Schlüssel (`android/anycast-tv.keystore`) signiert ist.
