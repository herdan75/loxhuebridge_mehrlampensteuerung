## [2.5.12] - 2026-09-06
### Veröffentlichung
- Aktuellen Entwicklungsstand auf `main` übernommen, einschließlich Ablauf-Clustern, Lampendiagnose, Funkmaßnahmen und der unten dokumentierten Stabilitäts- und Sicherheitskorrekturen.
- Anwendungscode entspricht `2.5.12-dev`; die stabile Version wird ohne `-dev` angezeigt. README unterscheidet beide Branches und beschreibt die einmalige Sicherung beim Update älterer Installationen.

### Korrekturen
- Serverlog aktualisiert auch Einträge mit gleich langer, aber geänderter Meldung oder Uhrzeit.

### Prüfungen
- Regressionstests für die Loganzeige und HTML-Maskierung ergänzt.
- HTTP-Integrationstests prüfen Lampendiagnose ohne Debug sowie Debug-Aktivierung zur Laufzeit für Einzelbefehle und Multi-Sync, mit SQLite- und RAM-Logs.

## [2.5.11-dev] - In Entwicklung
### Korrekturen
- Globale Bridge-Rate für jeden tatsächlichen PUT durchgesetzt, auch innerhalb von Clustern, für Effekte und Retries.
- Letzter ausdrücklich gewünschter Schaltzustand gewinnt im Sammelfenster; gültige RGB-Werte mit Präfix 20 werden nicht mehr als Farbtemperatur verworfen.
- Veraltete Queue-Befehle, Wiederholungen und Effekt-Timer werden pro Ziel vor dem Senden verworfen. Unabhängige Effekte unterbrechen sich nicht mehr.
- Alte Nachsteuerungen werden bei Gruppenbefehlen unterbunden und nach vollständiger Zustandsbestätigung beendet.
- Hue-Fachfehler gelten nicht als Erfolg. Angeforderte Zustände werden nicht mehr als Istwerte an Dashboard, UDP oder MQTT zurückgemeldet.
- Rate-Pause ab Request-Start statt Antwortende berechnet; gemeinsame Timing-Planung für Backend und UI mit globaler Mindestpause.
- Config und Mapping atomar gespeichert; gemeinsamer Restore mit Wiederherstellungsjournal. Fehler bleiben auch im Webinterface sichtbar.
- Passwortprüfung asynchron, mit begrenzter Parallelität, kurzlebigem Credential-Cache und Anmeldebegrenzung.
- EventStream-Aufbau abbrechbar und zeitlich begrenzt; verspätete Verbindungen werden geschlossen.

### Sicherheit und Betrieb
- Abhängigkeiten aktualisiert; gepatchte qs-Version für die Express-Abhängigkeiten festgelegt. Hue-Requests folgen keinen Weiterleitungen.
- Docker kopiert nur Anwendungscode. Laufzeitdaten, Backups und Prüfartefakte vom Build ausgeschlossen; Logdatenbank aus Git-Verfolgung entfernt. Einmalige Datensicherung vor dem Update dokumentiert.
- API-Neustart und Restore verwenden den kontrollierten Shutdown; nach Shutdown werden keine neuen Hue-PUTs begonnen.
- Einstellungsformular und Timing-Vorschau passen auch auf schmale Mobilbildschirme.
- Version als Entwicklungsstand gekennzeichnet; Entwicklungs-Tags überschreiben kein stabiles latest-Image.

### Prüfungen
- Regressionstests für die korrigierten Fehler, temporäre Git-Datenmigration sowie echte lokale HTTP-/Auth-/SSE- und Shutdown-Tests ergänzt.
- npm test auf automatisierte Tests begrenzt; manuelle Netzwerkdiagnose separat und nur mit expliziter Zieladresse ausführbar.
- Tests und Dependency-Audit vor dem Docker-Release sowie CI-Prüfungen auf Windows und Linux eingerichtet.

## [2.5.10-dev] - In Entwicklung
### Verbesserungen
- **Stabilitäts- und Diagnosefunktionen ergänzt:** DATA_DIR-Fix, Logrotation, sauberer Shutdown, robuste Hue-Ressourcenladung und optionale Funkmaßnahmen pro Lampe.
- **Zuverlässigkeitsdiagnose pro Lampe:** Befehle, Bestätigungen, Widersprüche, Verifikationen, Nachsteuerungen und Hue `communication_error` werden pro Light-UUID sichtbar.
- **Funkmaßnahmen pro Lampe:** `Zustand nachlesen und korrigieren`, `Einschalten aufteilen` und `Befehl wiederholen` sind im Geräte-Detailfenster auswählbar und schließen sich gegenseitig aus.
- **MQTT-Passwort sicherer speichern:** Ein leeres Passwortfeld beim Speichern behält das bestehende Passwort bei; Löschen ist nur explizit möglich.
- **SSE-Parser UTF-8-sicher:** Der vorhandene Event-Puffer nutzt nun `StringDecoder`, damit Mehrbyte-Zeichen an Chunk-Grenzen korrekt bleiben.

### Tests
- Tests für DATA_DIR, Logger-Pruning, Shutdown-Vertrag, allSettled-Ressourcenladung, MQTT-Passwort-Erhalt, Funkmaßnahmen, Hue `communication_error`, Lampendiagnose, SSE-UTF-8 und UI-Erhalt der Multi-Sync-Felder ergänzt.

## [2.5.9-dev] - In Entwicklung
### Verbesserungen
- **Manuelle Ablauf-Cluster für Multi-Sync:** Lampen innerhalb einer Multi-Sync-Gruppe können zusätzlich einem Ablauf-Cluster wie Deckenlampe, Stehlampe, TV oder Buddha zugeordnet werden.
- **Engere Cluster-Planung:** Lampen mit gleichem Ablauf-Cluster werden im Zeitplan enger nacheinander gesendet, während zwischen verschiedenen Clustern weiterhin der normale Hue-Mindestabstand gilt.
- **Timing-Vorschau erweitert:** Die Multi-Sync-Vorschau zeigt nun Cluster, Lampe, Offset und geplanten Zeitpunkt.

### Tests
- Tests für Cluster-Scheduling, Offset-Reihenfolge, Fallback ohne Cluster, Mapping-Validierung und Preview-Zeiten ergänzt.

## [2.5.8-dev] - In Entwicklung
### Entwicklung
- Entwicklungszweig nach Release 2.5.7 fortgeführt.

## [2.5.7] - 2026-06-22
### Bugfixes
- **Geräte-Details-Modal scrollbar:** Der Inhalt scrollt nun innerhalb des Modals, Header und Button-Zeile bleiben bedienbar.
- **Sync-Offset zuverlässig speichern:** Geräteeinstellungen werden im Modal als Draft bearbeitet und erst mit "Speichern & schließen" über einen gezielten Mapping-Settings-Endpunkt gespeichert.

### Verbesserungen
- **Offset-Bedienung verbessert:** Sync-Offset bietet Schnellbuttons (-50, -10, 0, +10, +50) und beschreibt direkt, ob eine Lampe früher oder später gesendet wird.
- **Timing-Vorschau erweitert:** Die Multi-Sync-Vorschau zeigt nun pro Lampe Offset und geplanten relativen Sendepunkt in Scheduler-Reihenfolge.

### Tests
- Tests für Mapping-Settings-Endpunkt, Sync-Offset-Validierung, scrollbares Detailmodal und Scheduler-Offset-Reihenfolge ergänzt.

## [2.5.6-dev] - In Entwicklung
### Entwicklung
- Entwicklungszweig nach Release 2.5.5 fortgeführt.

## [2.5.5] - 2026-06-22
### Bugfixes
- **Multi-Sync verwirft keine anderen Lampen mehr:** Geplante Lampenbefehle werden nicht mehr gruppenweit invalidiert. Neue Befehle ersetzen nur ältere Timer derselben Lampen-UUID.
- **Live-Szenen mit mehreren Wellen stabiler:** Wenn Loxone eine Szene in mehreren kurzen Wellen sendet, bleiben bereits geplante Befehle anderer Lampen erhalten.

### Verbesserungen
- **Eigenes Browser-Icon:** Dashboard und Setup verwenden nun ein loxHueBridge-Favicon statt der Standard-Weltkugel.

### Tests
- Regressionstests für 10 Lampen in einer Multi-Sync-Gruppe, zweite Befehlswelle, per-UUID-Ersetzung und Off-Payload-Überschreibung ergänzt.

## [2.5.4-dev] - 2026-06-22
### New Features
- **Dashboard/API-Passwortschutz im UI:** Im System-Tab kann der Zugriffsschutz für Dashboard und `/api/*` aktiviert oder deaktiviert werden.
- **Passwort-Hash statt Klartext:** Neue Passwörter werden per PBKDF2-Hash gespeichert. Benutzername und Passwort können über `/api/security/settings` gesetzt werden.

### Verbesserungen
- **Loxone-Kompatibilität erhalten:** Steuer-URLs wie `/lampe/1` und `/lampe/sunrise/30` bleiben bewusst ohne Auth erreichbar.
- **Security-Status ohne Secrets:** `/api/security/status` meldet nur Aktivierung, Benutzername und ob ein Passwort gesetzt ist.
- **Backup-Redaction erweitert:** Reduzierte Backups enthalten weder Auth-Token noch Passwort-Hash.

### Tests
- Tests für Basic Auth mit Passwort-Hash, offene Loxone-Steuerpfade, Security-API, Aktivierung ohne Passwort und redigierte Auth-Secrets ergänzt.

## [2.5.3-dev] - 2026-06-22
### Verbesserungen
- **UTF-8/Mojibake repariert:** `public/app.js` zeigt deutsche Texte, Sonderzeichen und Emojis wieder korrekt an.
- **Encoding-Test ergänzt:** Frontend- und Dokumentationsdateien werden automatisch auf typische Mojibake-Sequenzen geprüft.
- **HueScheduler-Drosselung korrigiert:** Normale Einzellichtbefehle respektieren wieder `Drosselung`/`throttleTime`; Multi-Sync bleibt durch eigenes Timing und die globale Bridge-Grenze schnell.
- **Warmweiß/CT validiert:** Loxone-Werte im Format `20BBBKKKK` werden streng geprüft und sicher auf Hue-Mirek-Grenzen begrenzt.
- **Effekt-Timer abgesichert:** Schnelle Effektwechsel und `no_effect` verwerfen alte geplante Effekt-Timer pro Gruppe.
- **Scheduler-Code bereinigt:** Alte Queue-Funktionen wurden entfernt; die verbleibenden Delay-Werte sind als Runtime-Abstände des zentralen HueSchedulers benannt.

### Tests
- Testabdeckung für Encoding, Scheduler-Quellen, CT-Validierung, Effekt-Generationen und Scheduler-Bereinigung erweitert.

## [2.5.2-dev] - 2026-06-22
### New Features
- **Optionale Dashboard/API-Authentifizierung:** Webinterface und API können optional per Token geschützt werden, ohne bestehende Loxone-Befehls-URLs zu blockieren.
- **Backup ohne Zugangsdaten:** Zusätzlicher Backup-Export maskiert Hue App-Key, MQTT-Passwort und Auth-Token. Redigierte Backups werden beim Restore bewusst abgelehnt.

### Verbesserungen
- **Runtime-Konfiguration beim Start:** Gespeicherte Einstellungen wie Drosselung und Multi-Sync-Grenzen werden nach Neustart korrekt in die laufenden Queues übernommen.
- **Zentrale Hue-Befehlsplanung:** Hue PUT-Befehle laufen über einen gemeinsamen Scheduler mit globalem Rate-Limit und Backoff bei `429` Antworten.
- **Robustere Hue Requests:** Hue PUTs haben nun ein Timeout; der EventStream bleibt davon unberührt.
- **Sicherere Loxone-Werte:** Ungültige Zahlen-, RGB- und CT-Werte werden abgewiesen, statt als fehlerhafte Hue Payload gesendet zu werden.
- **Stabilere Mehrlampensynchronisierung:** Alte Timer werden sauber verworfen und mehrere Payloads innerhalb eines Sammelfensters werden sinnvoll zusammengeführt.
- **Hue Effekt-Fähigkeiten berücksichtigen:** Effekte werden nur an Lampen gesendet, die den jeweiligen Effekt laut Hue-Daten unterstützen.
- **Deduplizierter Alles-Fallback:** `/all` und Gruppen-Fallbacks senden Befehle nicht mehrfach an dieselbe physische Lampe.
- **SD-Card Mode ohne SQLite-Schreibzugriffe:** Im SD-Card Mode wird keine SQLite-Datenbank geöffnet und kein WAL geschrieben.
- **Frontend-Ausgabe abgesichert:** Dynamische Inhalte im Webinterface werden konsequenter escaped.
- **`.env` früh geladen:** Umgebungsvariablen stehen bereits beim Initialisieren der Konfiguration zur Verfügung.

### Tests
- Testabdeckung für Runtime-Konfiguration, Hue Timeout, Loxone-Validierung, Multi-Sync-Timer, Payload-Merge, Scheduler, 429-Backoff, Effekt-Fähigkeiten, deduplizierte Fallbacks, SD-Card Mode, Frontend-Escaping, Auth und redigierte Backups erweitert.

## [2.5.1-dev] - 2026-05-19
### New Features
- **Hue Effekt-Fallback für Gruppen/Räume/Zonen:** Effektbefehle wie `candle`, `fire`, `prism`, `sparkle`, `opal`, `glisten`, `noeffect` und `sunrise` werden bei Hue Gruppen/Räumen/Zonen intern auf die enthaltenen einzelnen Hue-Lampen aufgelöst.
- **Multi-Sync Timing für Gruppen-Effekte:** Enthaltene Lampen mit loxHueBridge Multi-Sync-Gruppe A-E verwenden beim Effekt-Fallback die Timing- und Rate-Einstellungen ihrer Gruppe.
- **Direkte Multi-Sync Effektziele:** Gruppen A-E können direkt per URL angesteuert werden, z. B. `/gruppe_a/candle`, `/group_b/fire` oder über den frei vergebenen Gruppennamen.
- **Alles-Effekt:** `/all/candle`, `/alles/fire` und `/all/sunrise/30` verteilen Effekte auf alle einzeln gemappten Hue-Lampen.
- **Einstellbarer EventStream Watchdog:** Der Neustart bei ausbleibenden Hue Events ist im Systembereich einstellbar. Standard ist 10 Minuten.
- **Info-Hilfen im UI:** System-, MQTT- und Mehrlampen-Einstellungen haben kleine Info-Buttons mit Kurzbeschreibung der jeweiligen Funktion.

### Verbesserungen
- **API-konforme Effektsteuerung:** Gruppen-Effekte werden nicht mehr gegen `grouped_light` ausgeführt, sondern einzeln gegen `/resource/light`, wie es die Hue API v2 für Effekte erwartet.
- **Sicherer Standard für nicht gemappte Lampen:** Lampen, die in einer Hue-Gruppe enthalten, aber nicht einzeln in loxHueBridge gemappt sind, werden trotzdem mit konservativem Timing angesteuert.
- **Effekt-Alias:** `fireplace` wird als Alias für den Hue Effekt `fire` akzeptiert.
- **Ruhigere EventStream-Logs:** Der Watchdog startet den Hue EventStream nicht mehr bereits nach 60-90 Sekunden ohne Events neu. Das reduziert unnötige Reconnects in ruhigen Installationen.
- **Discovery-Probe-Schutz:** Reservierte Pfade wie `/api/...`, `/description.xml` oder `/upnp/...` werden nicht mehr versehentlich als Loxone-Befehl behandelt. Das reduziert False-Positive-Risiken bei lokalen Smart-Home-Gerätesuchen.
- **Hue Rate-Limit Retry:** Kurzzeitige Hue `429` Antworten werden mit kleinem Backoff erneut versucht, damit einzelne Lampenbefehle bei Lastspitzen nicht sofort verloren gehen.

### Tests
- Tests für die Auflösung von Hue Räumen/Zonen auf einzelne Lampen, direkte Multi-Sync-Gruppenziele, Alles-Effektziele, EventStream-Watchdog-Timing, Hue Rate-Limit-Retry, reservierte Discovery-Pfade und die Übernahme der Multi-Sync-Zuordnung bei Gruppen-Effekten ergänzt.

## [2.5.0] - 2026-05-18
### New Features
- **Gruppierte Mehrlampensynchronisierung:** Einzelne Hue-Lampen können jetzt einer von fünf neutralen Multi-Sync-Gruppen A-E zugeordnet werden. Damit lassen sich mehrere Räume oder Lampenbereiche unabhängig voneinander abstimmen.
- **Freie Gruppennamen:** Die Gruppen A-E können im Systembereich individuell benannt werden, z. B. Wohnzimmer, Büro oder Küche.
- **Eigene Gruppen-Settings:** Jede Gruppe hat eigene Werte für Sammelfenster, Batchgröße, Batch-Pause und maximale Lichtbefehle pro Sekunde.
- **Timing-Test pro Gruppe:** Die Simulation zeigt je Gruppe aktive Lampen, Mindestabstand, geschaetzte Zeit bis zum letzten Befehl und effektive Befehlsrate.
- **Globale Bridge-Sicherheitsgrenze:** `Max. Bridge-Befehle/s` begrenzt die Gesamtlast über alle Multi-Sync-Gruppen hinweg, damit gleichzeitig auslösende Räume die Hue Bridge nicht gemeinsam überlasten.

### Verbesserungen
- **Rückwärtskompatibilität:** Bestehende Lampen mit aktivierter Mehrlampensynchronisierung, aber ohne Gruppenzuordnung, laufen automatisch in Gruppe A weiter.
- **Normale Lampen bleiben unverändert:** Lampen ohne aktivierte Mehrlampensynchronisierung laufen weiterhin über die normale Queue/Drosselung außerhalb des Multi-Sync-Ablaufs.
- **README erweitert:** Gruppenlogik, Gruppenzuordnung, Timing-Test und Bridge-Gesamtlimit sind dokumentiert.

### Tests
- Zusaetzlicher Test prueft, dass die Multi-Sync Preview Lampen korrekt nach Gruppe trennt und Hue-Gruppen nicht in den Einzel-Lampen-Sync einbezieht.

## [2.4.0] - 2026-05-15
### 🌟 New Features
- **Mehrlampensynchronisierung pro Lampe:** Lampen können einzeln für einen gemeinsamen Sammel-/Batch-Ablauf aktiviert werden. Dadurch lassen sich mehrere einzeln angesteuerte Hue-Lampen bei Ambient-Szenen deutlich synchroner starten.
- **Sync-Offset pro Lampe:** Für jede Multi-Sync-Lampe kann ein individueller Zeitversatz in Millisekunden gesetzt werden. Negative Werte senden früher, positive Werte später.
- **Konfigurierbare Multi-Sync Parameter:** Sammelfenster, Batchgröße und Batch-Pause können konfiguriert werden.

### 🐛 Bugfixes
- **Robuster SSE/EventStream Parser:** Hue Events werden nun gepuffert und erst nach vollständigem SSE-Event geparst. Das behebt sporadische JSON-Parsing-Fehler bei großen oder fragmentierten Events, z. B. `Unexpected end of JSON input`, `Unterminated string in JSON` und `Expected double-quoted property name in JSON`.

### 🔄 Verbesserungen
- **Gezielter Queue-Bypass:** Die bestehende Queue bleibt für normale Lampen erhalten. Nur Lampen mit aktivierter Mehrlampensynchronisierung nutzen den neuen Batch-Ablauf.
- **Fork-Docker-Setup:** `docker-compose.yml` baut das lokale Image aus diesem Repository, damit beim Testen kein externes Standard-Image verwendet wird.

## [2.3.0] - 2026-05-04
### 🌟 New Features
- **Hue Effekte & Alert:** Lampen können jetzt per einfachem Befehl in spezielle Effektmodi versetzt werden – vollständig rückwärtskompatibel zu allen bestehenden Steuerungen.
  - `/{name}/alert` → Einmaliges Breathe-Blinken (ideal für Alarmierung, Türklingel-Bestätigung, etc.)
  - `/{name}/candle` → Kerzenflackern 🕯️ (persistent bis zum Stoppen)
  - `/{name}/fire` → Feuereffekt 🔥 (persistent, nur neuere Lampen)
  - `/{name}/prism` → Regenbogen-Farbwechsel 🌈 (persistent, nur Farblampen)
  - `/{name}/sparkle`, `/opal`, `/glisten` → weitere atmosphärische Effekte
  - `/{name}/noeffect` → Aktiven Effekt stoppen
  - `/{name}/sunrise/30` → 30-Sekunden Sonnenaufgang-Simulation 🌅 (oder beliebige Dauer in Sekunden)
- **Erweiterter Diagnose-Tab:** Der Diagnose-Tab zeigt jetzt drei Abschnitte:
  1. 📋 Geräte & Batterien (bekannt)
  2. 🌐 Bridge & Zigbee Netzwerk – Verbindungsstatus (`connected` / `connectivity_issue`) jedes einzelnen Zigbee-Geräts, Bridge-ID und Zeitzone
  3. 🎭 Lampen-Fähigkeiten – Übersichtstabelle zeigt pro Lampe, ob Dimmen ✅, Farbe ✅ und Weißton ✅ unterstützt werden, sowie alle verfügbaren Effekte.
- **Nativer "Alles" Befehl:** Der Befehl `/all` (bzw. `/alles`) nutzt nun die native `bridge_home` Ressource der Hue Bridge, um das gesamte Zuhause nahezu verzögerungsfrei zu schalten. Im UI ist die Option „🏠 Alle Lichter (bridge_home)" jetzt im Dropdown wählbar.
- **Batterie-Warnsystem:** Geräte mit einem Batteriestand von ≤ 10 % werden im Dashboard optisch hervorgehoben (rotes Badge + Leer-Symbol 🪫).
- **Automatisierte Tests:** Einführung einer robusten Test-Infrastruktur basierend auf dem nativen Node.js Test-Runner (`node:test`) mit 16 Tests und > 85 % Abdeckung der Kernmodule.

### 🔄 Verbesserungen & Refactoring
- **Backend-Modularisierung:** Komplette Neustrukturierung der `server.js`. Die Logik wurde in saubere Module im Ordner `lib/` (`logger`, `config`, `loxone`, `mqtt`, `hue`, `routes`) ausgelagert, was die Wartbarkeit und Stabilität massiv erhöht.
- **Frontend-Cleanup:** Trennung von HTML, CSS und JavaScript. Die `index.html` wurde bereinigt, Styles wanderten in `style.css` und die Logik in `app.js`.
- **Smarte Listen:** Die Liste der „Neu erkannten Befehle" filtert nun automatisch Duplikate.
- **Robustheit:** Zuvor leere `catch`-Blöcke loggen nun detaillierte Fehlermeldungen.

## [2.2.0] - 2026-02-26
### 🌟 New Features
- **Dynamics ignorieren:** Es kann nun pro Lampe/Gruppe individuell eingestellt werden, ob weiche Übergänge (Transition/Dynamics) gesendet werden sollen. Für reine An/Aus-Schalter (ohne Dimmfunktion) wird dies automatisch erzwungen.
- **Interaktive UI & Detail-Ansicht:** Die Gerätekarten im Dashboard sind nun klickbar. Ein Modal zeigt Live-Status, technische Details und erlaubt individuelle Geräte-Einstellungen (Loxone Sync & Dynamics ignorieren).
- **Slider für Timings:** Übergangszeit und Drosselung lassen sich im System-Tab nun intuitiv per Schieberegler (0-1000ms) einstellen.

### 🔄 Verbesserungen
- **Smarte Sortierung:** Schalter und Diagnose-Einträge werden nun ebenfalls priorisiert nach niedrigstem Batteriestand sortiert.
- **Diagnose-Icons:** Optische Aufwertung und bessere Übersichtlichkeit des Diagnose-Tabs durch Geräte-Typ-Icons.

## [2.1.2] - 2026-02-17
### 🐛 Bugfixes
- **UI Settings:** Fehlende Eingabefelder für "Übergangszeit" und "Drosselung" im System-Tab hinzugefügt.
- **Diagnose Tab:** Fehler behoben, der das Laden der Diagnose-Tabelle verhinderte (`loadDiagnostics is not defined`).
- **Server Stabilität:** Kritischen Fehler beim Start behoben (Hoisting-Problem bei der alten Queue-Konfiguration).
- **Sonoff / On-Off Fix:** Reine Schaltaktoren erhalten keine `dynamics` Parameter mehr (behebt Probleme mit Sonoff ZBMINIR2).
- **Sensor Sortierung:** Sensoren werden nun nach Batterie-Status (leer zuerst) und Aktivität sortiert.

## [2.1.1] - 2026-02-16
### 🐛 Bugfixes
- **Sonoff / On-Off Fix:** Reine Schaltaktoren (ohne Dimm-Funktion) erhalten nun keine `dynamics` Parameter mehr. Das behebt Probleme mit Geräten wie dem Sonoff ZBMINIR2, die sich sonst nicht ausschalten ließen.
- **Queue Timing:** Die Einstellung `throttleTime` (Drosselung) gilt nun auch korrekt für Gruppen- und Zonen-Befehle (war vorher fest auf 1100ms).
- **Sensor Sortierung:** Im Dashboard werden Sensoren nun nach Wichtigkeit sortiert (Leere Batterie -> Aktiv -> Name).

## [2.1.0] - 2026-01-29
### 🌟 New Features
- **SD-Card Mode:** Neue Option in den Systemeinstellungen, um das Schreiben von Logs auf die Festplatte zu deaktivieren (schont SD-Karten auf Raspberry Pi). Logs werden dann nur im RAM gehalten.
- **Robustheit:** Neuer Crash-Monitor fängt kritische Fehler ab und verhindert, dass der Server bei kleineren Problemen komplett abstürzt.

### 🐛 Bugfixes
- **MQTT:** Fix für Abstürze bei leeren Benutzer/Passwort-Feldern und Endlos-Schleifen bei Authentifizierungsfehlern.
- **Datenbank:** Server startet nun auch, wenn die `logs.db` gesperrt oder beschädigt ist (Fallback auf RAM-Modus).

## [2.0.0] - 2026-01-29
### 💥 Major Changes
- **Core Engine Upgrade:** Umstellung auf **Node.js 24 LTS**.
- **Native SQLite Integration:** Logs werden nun persistent in einer lokalen SQLite-Datenbank (`data/logs.db`) gespeichert statt nur im Arbeitsspeicher.
    - *Vorteil:* Logs überleben Neustarts und ermöglichen eine Historie von Millionen Einträgen ohne RAM-Verbrauch.
    - *Performance:* Nutzung des neuen `node:sqlite` Moduls für maximale Geschwindigkeit ohne externe C++ Abhängigkeiten.
- **UI Overhaul:** Komplettes Redesign des Dashboards.
    - Auslagerung der Styles in `style.css`.
    - Neue **Filter-Leiste** für Logs (Kategorien + Volltextsuche).
    - Verbesserte **Sensor-Gruppierung** (Kontakte, Bewegung, Sonstige).
    - **Backup & Restore:** Vollständige Sicherung und Wiederherstellung der Konfiguration direkt über das Web-Interface.

### 🐛 Bugfixes
- **Grouped Lights:** Fix für fehlenden Status von Lichtgruppen (Zimmer/Zonen) nach Neustart. Der Endpunkt `grouped_light` wird nun beim Start synchronisiert.
- **Zero-Value Display:** Korrektur eines Fehlers im Frontend, bei dem Werte von `0` (z.B. Licht Aus, Keine Bewegung) fälschlicherweise als "leer" interpretiert und ausgeblendet wurden.
- **Log Formatting:** Fix für Zeilenumbrüche in der Log-Ansicht für bessere Lesbarkeit.

---
---

## [1.8.0] - 2026-01-21

### 🚀 Features
- **MQTT Support:** Die Bridge kann nun Statusänderungen (Licht, Sensoren, Taster) parallel an einen MQTT Broker senden.
    - Konfiguration im Tab "System" (Broker, Port, User, Passwort).
    - Topic-Struktur: `loxhue/<typ>/<name>/<attribut>` (z.B. `loxhue/light/kueche/bri`).
    - Ideal für die Integration in Home Assistant, ioBroker oder Node-RED.
- **Erweitertes Dashboard:**
    - **Licht-Gruppierung:** Im Tab "Lichter" werden Lampen nun übersichtlich in "Eingeschaltet" 💡 und "Ausgeschaltet" 🌑 unterteilt.
    - **Live-Info Modal:** Das Info-Icon (ℹ️) zeigt nun Live-Werte der Lampe an (Helligkeit %, Kelvin, Hex-Code), was das Debuggen massiv erleichtert.

### 🛠 Verbesserungen
- **Stabilität:** Beinhaltet alle Fixes aus v1.7.x (Watchdog gegen Verbindungsabbrüche, Queue-Drosselung).
- **UI:** Neuer Toggle-Switch im System-Tab, um MQTT global an- oder abzuschalten.

---

## [1.7.3] - 2026-01-20

### 🛡️ Stabilität
- **EventStream Watchdog:** Behebt das Problem ("Zombie Connection"), bei dem nach längerer Laufzeit (10-14 Tage) keine Sensor-Updates mehr empfangen wurden.
    - Der neue Watchdog prüft auf eingehende Daten (inkl. Hue Heartbeats).
    - Bei Stille (>60s) wird die Verbindung proaktiv getrennt und neu aufgebaut.

### 🚀 Features
- **Configurable Throttling:** Die Drosselung der Befehls-Queue ist nun im System-Tab einstellbar (0ms - 1000ms).
    - Ermöglicht Power-Usern, die Reaktionsgeschwindigkeit zu erhöhen oder bei Verbindungsproblemen (Error 429) konservativer zu agieren.
    - Standardwert: 100ms.

---

## [1.7.2] - 2025-12-15

### 🐛 Bugfixes
- **Button Event Cache Fix:** Behebt ein Problem, bei dem wiederholte Tastendrücke (z.B. zweimaliges Drücken für "An" und "Aus") von der internen Cache-Logik verschluckt wurden, da sich der Status-Text (z.B. `short_release`) nicht geändert hatte.
    - **Jetzt:** Events von Tastern (`button`) und Drehreglern (`rotary`) umgehen nun den Cache und senden **immer** ein UDP-Paket an Loxone, auch wenn der Wert identisch zum vorherigen ist.
    - Sensoren (Temp, Motion, Lux) werden weiterhin dedupliziert, um das Netzwerk nicht zu fluten.

---

## [1.7.1] - 2025-12-15

### 🛡️ Global Rate Limiting
- **Traffic Queue:** Implementierung einer globalen Warteschlange, um Fehler bei der Hue Bridge ("429 Too Many Requests") zu verhindern.
    - Befehle für Einzel-Lichter werden auf max. 8-10 pro Sekunde begrenzt.
    - Befehle für Gruppen/Zonen werden auf max. 1 pro Sekunde begrenzt.
    - Loxone kann nun "feuern" so schnell es will (z.B. Szenen), die Bridge arbeitet alles sauber nacheinander ab.

### 🛠 Fixes & Verbesserungen
- **Smart Button Logic:** Taster-Events werden nun sauber gefiltert (`short_release` & `long_press`), um Fehlschaltungen zu vermeiden.
- **Rotary (Drehregler):** Sendet nun `cw` (rechts) und `ccw` (links) als Text für einfachere Einbindung in Loxone.
- **Discovery:** Tap Dial Switch wird nun vollständig erkannt (4 Tasten + Drehring separat).

---

## [1.7.0] - 2025-12-12

### 🚀 Major Features
- **Tap Dial Switch Support:** Der Philips Hue Tap Dial Switch wird nun vollständig unterstützt!
    - Alle 4 Tasten werden als einzelne Geräte erkannt.
    - Der Drehring (Rotary) wird als eigenes Gerät erkannt.
- **Smart Button Logic:** Taster-Events werden nun gefiltert:
    - Nur noch `short_release` (Klick) und `long_press` (Halten) werden an Loxone gesendet.
    - Irrelevante Events wie `initial_press` oder `repeat` werden unterdrückt, um Traffic zu sparen.
- **Rotary Logic:** Der Drehring sendet nun `cw` (Clockwise) und `ccw` (Counter-Clockwise) als Text an Loxone. Das ermöglicht das direkte Anbinden an `V+` und `V-` Eingänge von Dimmern.

### 🛠 Verbesserungen
- **XML Export:** Der Input-Generator erstellt nun automatisch digitale Eingänge für Drehregler (CW/CCW).
- **Stabilität:** `dotenv` Dependency entfernt und `package.json` Laderoutine abgesichert (verhindert Abstürze in Docker-Umgebungen).
- **UI:** Verbesserte Log-Darstellung mit Kategorien (Light, Sensor, Button).

---

## [1.6.3] - 2025-12-08

### 🛠 Bugfixes & Kompatibilität
- **3rd-Party Controller Fix:** Bei einer eingestellten Transitionszeit von `0ms` wird das `dynamics`-Objekt nun komplett aus dem Befehl entfernt (statt `duration: 0` zu senden).
    - Dies behebt Probleme mit günstigen Zigbee-Controllern, die bei `duration: 0` abstürzen oder den Befehl ignorieren.
    - Das Licht nutzt in diesem Fall das Standard-Fading des Controllers.

---

## [1.6.1] - 2025-12-03

### 🛠 Verbesserungen
- **UI Fix:** Layout-Korrektur beim Hinweis für den "All"-Befehl (Text überlappte mit Eingabefeld).
- **Styling:** Abstände in der Verbindungs-Karte optimiert.

---

## [1.6.0] - 2025-12-03

### 🚀 Features
- **Loxone Sync (Rückkanal für Lichter):** Neues Opt-In Feature im Dashboard (Tab "Lichter").
    - Ermöglicht es, den Status von Lichtern (An/Aus, Helligkeit) per UDP an Loxone zu senden, wenn diese extern (z.B. via Hue App, Alexa, Dimmschalter) geschaltet wurden.
    - Perfekt für den Eingang `Stat` am EIB-Taster Baustein, um die Visualisierung synchron zu halten.
    - Standardmäßig deaktiviert, um Netzwerk-Traffic gering zu halten.

### 🛠 Verbesserungen
- **UI Fixes:** Korrektur beim Laden der Transition-Time (0ms wurde fälschlicherweise als 400ms interpretiert).
- **Icon Cleanup:** Beim Speichern von Mappings werden Icons (💡, 🏠, etc.) im Namen nun zuverlässiger entfernt.

---

## [1.5.1] - 2025-12-03

### ⚡ Optimierungen
- **Smart "All" Logic:** Der Befehl `/all/0` nutzt nun eine **fixe Verzögerung von 100ms** zwischen den Lampen (statt abhängig von der Transition Time). Dies garantiert eine sichere Entlastung der Bridge und des Stromnetzes, unabhängig von Benutzereinstellungen.
- **Transition Fix:** Bei "Alles"-Befehlen wird die Übergangszeit (Transition) temporär auf 0ms gesetzt, damit das Ausschalten sofort sichtbar ist, während die Schleife läuft.
- **Queue Stability:** Rückkehr zur stabilen "1-Slot-Buffer" Logik für die Befehlswarteschlange, um Seiteneffekte bei schnellen Schaltvorgängen zu vermeiden.

---

## [1.5.0] - 2025-12-02

### 🚀 Features
- **Diagnose Tab:** Neuer Tab im Dashboard zeigt den Gesundheitsstatus des Zigbee-Netzwerks (Verbindungsstatus, MAC-Adresse, Zuletzt gesehen) und den Batteriestatus aller Geräte.
- **Smart "All" Command:** Der Befehl `/all/0` (oder `/alles/0`) schaltet nun alle gemappten Lichter nacheinander mit einem Sicherheitsabstand von 100ms. Dies schützt die Bridge vor Überlastung und erzeugt einen angenehmen "Wellen-Effekt".

### ⚡ Optimierungen
- **Queue Logic:** Verbesserte Warteschlange für Lichtbefehle. Verhindert das Verschlucken von schnellen Ein/Aus-Schaltvorgängen (Hybrid Queue).
- **Logging:** Zeitstempel im Log sind nun präzise (Millisekunden) und im 24h-Format. Rate-Limit Fehler (429) werden sauber abgefangen.

---

## [1.4.0] - 2025-12-02

### ⚡ Optimierungen (Logic & Performance)
- **Zero-Latency Switching:** Reine Schaltbefehle (Ein/Aus) ignorieren nun die eingestellte Übergangszeit und schalten sofort (0ms), um eine spürbare Verzögerung zu vermeiden.
- **Stable Queue:** Die Warteschlange wurde stabilisiert ("1-Slot-Buffer"). Dies verhindert das Verschlucken von schnellen Schaltfolgen (An -> Aus -> An), behält aber die "Last-Wins"-Logik für flüssiges Dimmen bei.

### 🛡️ Stabilität
- **Rate Limit Handling (429):** Fehlercode 429 ("Too Many Requests") der Hue Bridge wird nun abgefangen und als Warnung geloggt, anstatt den Log mit HTML-Fehlerseiten zu fluten.
- **Error Throttling:** Bei Fehlern wird eine kurze Wartezeit (100ms) eingefügt, um die Bridge nicht weiter zu belasten.

### 📝 Logging
- **Präzise Zeitstempel:** Logs enthalten nun Millisekunden (`HH:MM:SS.mmm`) für genaueres Debugging von Timing-Problemen.
- **24h Format:** Zeitstempel werden nun erzwungen im deutschen 24h-Format ausgegeben.

---

## [1.3.0] - 2025-12-01

### 🚀 Neu (Features)
- **Smart Lighting:**
    - **Transition Time:** Einstellbare Überblendzeit (0-500ms) im System-Tab für weichere Lichtwechsel.
    - **Command Queueing:** Verhindert "Stottern" bei schnellen Slider-Bewegungen (Loxone -> Hue). Befehle werden gepuffert.
    - **RGB Fallback:** Sendet Loxone Farben an eine reine Warmweiß-Lampe, berechnet die Bridge nun automatisch die passende Farbtemperatur (Wärme basierend auf Rot/Blau-Anteil).
    - **Capabilities:** Die Bridge liest die physikalischen Kelvin-Grenzen der Lampen aus und skaliert Loxone-Werte exakt auf diesen Bereich.
- **UI & DX:**
    - **Color Dot:** Farbiger Punkt in der Liste zeigt den aktuellen Status der Lampe.
    - **Device Details:** Info-Button (ℹ️) zeigt technische Daten (Modell, Farbraum, Kelvin-Range) im Overlay.
    - **Export Filter:** Im Export-Dialog können nun gezielt einzelne Geräte per Checkbox ausgewählt werden.

### 🛠 Verbesserungen
- **Backend:** `server.js` nutzt nun zentrales Config-Management für Transition Time.
- **Frontend:** Optimierte Dropdowns (keine bereits gemappten Geräte mehr sichtbar).
- **Docker:** Healthcheck und Pfad-Optimierungen.

---

## [1.1.0] - 2025-11-27

### 🚀 Neu (Features)
- **UI Dashboard:**
    - Live-Werte: Anzeige von Temperatur, Lux, Batteriestand (<20% = 🚨) und Schaltzustand direkt in der Liste.
    - Color Dot: Farbiger Indikator zeigt die aktuelle Lichtfarbe an (berechnet aus XY/Mirek).
    - Selection Mode: Gezielter XML-Export von ausgewählten Geräten via Checkboxen.
    - Unique Name Check: Warnung beim Überschreiben von bestehenden Mappings.
- **Hardware Support:**
    - **Rotary Support:** Volle Unterstützung für den Hue Tap Dial Switch (Drehring sendet relative Werte).
- **Technical:**
    - **Initial Sync:** Lädt beim Start sofort alle aktuellen Zustände der Lampen.
    - **Smart Fallback:** Automatische Umrechnung von RGB zu Warmweiß für Lampen, die keine Farbe unterstützen (Berechnung der "Wärme" aus Rot/Blau-Anteil).
    - **Filtered XML:** XML-Export berücksichtigt jetzt die Auswahl im UI.

### 🐛 Fehlerbehebungen (Fixes)
- Behoben: Falsche Darstellung im Dropdown bei bereits zugeordneten Geräten.
- Behoben: Checkbox-Status Verlust bei Live-Updates (durch Modal-Overlay gelöst).
- Behoben: Slash `/` wurde bei Sensoren im Export-Overlay fälschlicherweise angezeigt.

---

## [1.0.0] - 2025-11-27

### 🎉 Initial Release
- **Core:** Bidirektionale Kommunikation (Loxone HTTP -> Hue / Hue SSE -> Loxone UDP).
- **Docker:** Robustes Setup mit `data/` Ordner Persistence und Host-Network Support.
- **Setup:** Automatischer Wizard zur Erkennung der Bridge und Konfiguration von Loxone IP/Ports.
- **UI:** Modernes Dashboard mit 4 Tabs (Lichter, Sensoren, Schalter, System) und Dark Mode.
- **Integration:** XML-Template Generator für Loxone Config (Inputs/Outputs).
- **Logging:** Runtime Debug-Toggle und In-Memory Log-Buffer im UI.
