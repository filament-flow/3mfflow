# 3MF Flow (Desktop-Client)

Überwacht einen lokalen Ordner (z.B. den Export-Ordner deines Slicers) auf neue
`.3mf`-Dateien und lädt sie automatisch zu FilamentFlow hoch. Die Datei landet
dort in einer Warteschlange (**Einstellungen → 3MF Flow** bzw. Hinweis in der
App) – die Zuordnung zu Filament/Projekt/Platte machst du danach wie gewohnt
manuell im 3MF-Import.

Passt namentlich zu WatchFlow (Drucker-Monitoring) und SpoolFlow (NFC-Tracking)
– 3MF Flow ist das dritte Ökosystem-Teil: automatischer Datei-Transport vom
Slicer-PC zur App.

## Entwicklung / Test (ohne .exe)

```bash
cd client
npm install
npm start
```

Beim ersten Start fragt das Tool interaktiv nach:
- FilamentFlow-URL (Standard: `https://filament-flow.com`)
- API-Key (aus der App: **Einstellungen → 3MF Flow → Key erzeugen**)
- Ordner, der überwacht werden soll

Die Antworten werden in `config.json` neben dem Programm gespeichert. Du kannst
diese Datei jederzeit per Texteditor anpassen (siehe `config.example.json`).

## Build als eigenständige .exe (für Endnutzer ohne Node.js)

`vercel/pkg` ist offiziell archiviert – wir nutzen den aktiv gepflegten Fork
[`@yao-pkg/pkg`](https://www.npmjs.com/package/@yao-pkg/pkg), der als
Drop-in-Ersatz funktioniert:

```bash
npm install
npm run build:win     # erzeugt dist/3mfflow-win.exe
npm run build:mac     # erzeugt dist/3mfflow-mac
npm run build:linux   # erzeugt dist/3mfflow-linux
npm run build:all     # alle drei auf einmal (Cross-Compile)
```

Falls der `pkg`-Befehl nicht gefunden wird: `npx @yao-pkg/pkg .` statt `pkg .`
in den Scripts verwenden (je nach lokaler PATH-Konfiguration).

Wichtig: `config.json` und `3mfflow.log` werden **neben der .exe** abgelegt
(nicht im pkg-Snapshot), damit Nutzer sie bearbeiten/einsehen können.

## Autostart unter Windows (v1, manuell)

Ein vollwertiger Installer (Inno Setup/NSIS) mit automatischer Autostart-
Registrierung ist ein guter nächster Schritt, ist hier aber bewusst noch nicht
enthalten. Für den ersten Rollout reicht:

1. `3mfflow-win.exe` in einen festen Ordner legen
2. `Win+R` → `shell:startup` → Verknüpfung zur .exe dort ablegen
3. Tool läuft beim nächsten Login automatisch im Hintergrund (Konsolenfenster
   bleibt offen – für v2 wäre ein Tray-Icon ohne Konsolenfenster die feinere Lösung)

## Verhalten bei Fehlern

- **Datei wird noch geschrieben:** Tool wartet, bis sich die Dateigröße nicht
  mehr ändert, bevor hochgeladen wird.
- **Netzwerkfehler:** Bis zu 5 Versuche mit steigender Wartezeit. Schlägt es
  endgültig fehl, wandert die Datei nach `_failed/` (inkl. `.error.txt`).
- **API-Key ungültig/widerrufen:** Klarer Log-Eintrag, Datei wandert ebenfalls
  nach `_failed/`. Neuen Key in den FilamentFlow-Einstellungen erzeugen und in
  `config.json` eintragen.
- **Erfolgreich hochgeladen:** Datei wandert nach `_uploaded/` (zeitgestempelt),
  bleibt also lokal als Backup erhalten statt gelöscht zu werden.

## Bekannte Grenzen (für v2 vormerken)

- Kein System-Tray-Icon, kein Hintergrund-Service (läuft als Konsolenprozess)
- Kein automatischer Installer mit Autostart-Registrierung
- Kein Auto-Update-Mechanismus für das Tool selbst
- `_uploaded/`-Ordner wächst unbegrenzt – ggf. später eine Aufräum-Routine
  (z.B. Dateien älter als 30 Tage löschen) ergänzen
