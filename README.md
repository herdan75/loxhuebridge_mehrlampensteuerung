# loxHueBridge Mehrlampensteuerung 🇦🇹

**loxHueBridge** ist eine bidirektionale Schnittstelle zwischen dem **Loxone Miniserver**, der **Philips Hue Bridge (V2 / API)** und optional **MQTT**.

Dieser Fork erweitert loxHueBridge um eine **gruppierte Mehrlampensynchronisierung pro Lampe**, einen **Effekt-Fallback für Hue Gruppen/Räume/Zonen** und behebt das **robuste SSE/EventStream Parsing** bei großen Hue Events.

Sie ermöglicht eine extrem schnelle, lokale Steuerung ohne Cloud-Verzögerung und nutzt die moderne Hue Event-Schnittstelle (SSE), um Statusänderungen in Echtzeit an Loxone (UDP) und MQTT Broker zurückzumelden.

> Fork: https://github.com/herdan75/loxhuebridge_mehrlampensteuerung

---

## 🚀 Features V2.5.12-dev Mehrlampensteuerung

### Neu in diesem Fork

* **Mehrlampensynchronisierung pro Lampe:** Einzelne Hue-Lampen können gezielt in einen gemeinsamen Sammel-/Batch-Ablauf aufgenommen werden.
* **Multi-Sync Gruppen A-E:** Lampen können einer von fünf neutralen Gruppen zugeordnet werden, z. B. für Wohnzimmer, Büro oder Küche.
* **Manuelle Ablauf-Cluster:** Innerhalb einer Multi-Sync-Gruppe können optisch zusammengehörige Lampen enger geplant werden, z. B. Deckenlampe top/bottom, Stehlampe oben/mitte/unten, TV oder Buddha.
* **Freie Gruppennamen:** Gruppe A-E können im Systembereich individuell benannt werden.
* **Eigene Einstellungen pro Gruppe:** Sammelfenster, Batchgröße, Batch-Pause, Lichtbefehle/s, Abstand innerhalb Ablauf-Cluster und Timing-Test sind pro Gruppe separat einstellbar.
* **Globale Bridge-Sicherheitsgrenze:** `Max. Bridge-Befehle/s` begrenzt die Gesamtlast über alle Gruppen hinweg, falls mehrere Räume gleichzeitig schalten.
* **Hue Effekt-Fallback für Gruppen/Räume/Zonen:** Effektbefehle wie `candle`, `fire`/`fireplace`, `prism`, `sparkle`, `opal`, `glisten`, `noeffect` und `sunrise` werden bei Hue Gruppen/Räumen/Zonen intern auf die enthaltenen einzelnen Hue-Lampen verteilt.
* **Multi-Sync Timing auch für Gruppen-Effekte:** Wenn enthaltene Lampen einer loxHueBridge Gruppe A-E zugeordnet sind, werden deren Timing-/Rate-Einstellungen auch beim Effekt-Fallback verwendet.
* **Direkte Multi-Sync Effektziele:** loxHueBridge Gruppen können direkt per URL angesprochen werden, z. B. `/gruppe_a/candle`, `/group_b/fire` oder über den frei vergebenen Gruppennamen.
* **Alles-Effekt:** `/all/candle`, `/alles/fire` und `/all/sunrise/30` verteilen Effekte auf alle einzeln gemappten Hue-Lampen.
* **Einstellbarer EventStream Watchdog:** Der Neustart bei ausbleibenden Hue Events ist global einstellbar. Standard ist 10 Minuten, damit ruhige Installationen nicht alle 60-90 Sekunden neu verbinden.
* **Sync-Offset pro Lampe:** Jede Lampe kann zeitlich feinjustiert werden.
    * negativer Offset = früher senden
    * positiver Offset = später senden
    * sinnvoller Bereich: ca. -500 ms bis +1000 ms
* **Sammelfenster für gleichzeitige Szenen:** Mehrere Loxone-Kommandos werden kurz gesammelt und dann gebündelt an die Hue Bridge gesendet.
* **Batch-Steuerung:** Lampen werden in logischen Blöcken seriell gesendet. Die globale Rate gilt auch innerhalb von Clustern, für Effekte und Wiederholungen.
* **Einstellbares Hue-Limit:** Die maximale Anzahl Lichtbefehle pro Sekunde kann angepasst werden, um je nach Lampenanzahl das schnellste stabile Limit der eigenen Bridge zu finden.
* **Timing-Test im UI:** Gemeinsame Berechnung mit dem Backend für Lampenanzahl, Mindestabstände, Reihenfolge und Planrate. Keine Messung der tatsächlichen Lampenreaktion.
* **Queue-Bypass nur für Multi-Sync-Lampen:** Die bestehende Queue bleibt für normale Lampen erhalten. Nur Lampen mit aktivierter Mehrlampensynchronisierung nutzen den neuen Ablauf.
* **Robuster SSE/EventStream Parser:** Behebt sporadische Fehler wie:
    * `Unexpected end of JSON input`
    * `Unterminated string in JSON`
    * `Expected double-quoted property name in JSON`
* **UTF-8-sicherer EventStream:** Der SSE-Puffer nutzt einen UTF-8 `StringDecoder`, damit Umlaute und andere Mehrbyte-Zeichen an TCP-Chunk-Grenzen nicht beschädigt werden.
* **Zuverlässigkeitsdiagnose pro Lampe:** Der Diagnose-Tab zählt Befehle, Bestätigungen, Widersprüche, Nachsteuerungen und Hue `communication_error`-Meldungen pro einzelner Lampe.
* **Optionale Funkmaßnahmen pro Lampe:** Für problematische Zigbee-/Fremdhersteller-Lampen können gezielt `Zustand nachlesen`, `Einschalten aufteilen` oder `Befehl wiederholen` aktiviert werden.
* **Robustere Hue-Ressourcenladung:** Geräteliste und Initial-Sync bleiben teilweise nutzbar, wenn ein einzelner Hue-Endpunkt temporär fehlschlägt.
* **Sauberer Container-Shutdown:** HTTP-Server, Hue EventStream, MQTT, UDP-Socket und Logger werden beim Stoppen kontrolliert geschlossen.
* **Logrotation:** Die SQLite-Logs werden begrenzt und per WAL-Checkpoint sauber gehalten.
* **Globale Multi-Sync Feineinstellungen:** Sammelfenster, Batchgröße und Batch-Pause sind konfigurierbar.

### Bestehende Features

* **Nativer „Alles" Befehl:** Nutzt die Hue `bridge_home` API für blitzschnelles Ausschalten des gesamten Hauses.
* **Hue Effekte & Alert:** Steuere Lampen, Hue Räume/Zonen und loxHueBridge Multi-Sync-Lampen mit atmosphärischen Effekten direkt aus Loxone:
    * `/{name}/alert` → Einmaliges Blinken (Alarmmeldung, Türklingel)
    * `/{name}/candle` / `/fire` / `/fireplace` / `/prism` / `/sparkle` → Persistente Atmosphäre-Effekte
    * `/{name}/noeffect` → Effekt stoppen
    * `/{name}/sunrise/30` → 30-Sekunden Sonnenaufgang (oder beliebige Dauer)
* **Modularer Kern:** Hochperformante und wartbare Backend-Architektur durch saubere Modul-Trennung (`lib/`).
* **Smart Setup:** Automatische Suche der Hue Bridge und Pairing per Web-Interface.
* **Live Dashboard:** Echtzeit-Anzeige aller Lichter, Sensoren und Batteriestände.
* **Smart Mapping:** Einfache Zuordnung per „Klick & Wähl" mit automatischer Duplikatsfilterung bei erkannten Befehlen.
* **Erweiterter Diagnose-Tab:** Zeigt Gerätestatus, Zigbee-Konnektivität pro Gerät und eine vollständige Übersicht aller Lampen-Fähigkeiten.
* **Persistent Logging (SQLite):** Logs bleiben nach Neustarts erhalten und sind durchsuchbar.
* **SD-Card Mode:** Optional werden Logs nur im RAM gehalten. In diesem Modus wird keine `logs.db` geöffnet und kein SQLite-WAL geschrieben.
* **Backup & Restore:** Lade deine komplette Konfiguration inkl. Mappings als Backup herunter und stelle sie bei Bedarf wieder her. Zusätzlich gibt es ein Backup ohne Zugangsdaten, bei dem Hue App-Key, MQTT-Passwort und Auth-Token maskiert werden.
* **Loxone Integration:** Schalten, Dimmen, Warmweiß, RGB sowie Rückmeldungen via UDP.
* **MQTT Support:** Sendet Statusänderungen parallel an einen MQTT Broker.
* **Stabilität:** Watchdog, Queue und Rate-Limiting verhindern Überlastung der Bridge.
* 🎛️ **Individuelle Geräte-Steuerung:** Detaillierte Einstellungen pro Gerät direkt im UI.

---

## 📋 Voraussetzungen

* Philips Hue Bridge (V2, eckiges Modell)
* Loxone Miniserver
* Ein Server für Docker, z. B. Raspberry Pi, Synology, Unraid oder LoxBerry mit Docker
* *Nur bei manueller Installation:* Node.js 24+

---

## Hue EventStream Watchdog

loxHueBridge überwacht den Hue EventStream, damit eine hängende Verbindung automatisch neu aufgebaut wird. In ruhigen Installationen kann es aber normal sein, dass längere Zeit keine Hue Events eintreffen. Deshalb ist der Watchdog im Systembereich einstellbar.

Empfehlung:

| Einstellung | Empfehlung |
| --- | --- |
| EventStream Watchdog | 10 min |
| Bei echten Aussetzern | schrittweise reduzieren, z. B. 5 min |
| Bei sehr ruhigen Installationen | eher 10-20 min |

Ein Wert von 60-90 Sekunden ist meist zu aggressiv, weil er bei wenig Hue-Aktivität unnötige Reconnects und Initial-Syncs auslösen kann.

---

## 🛠 Installation dieses Forks mit Docker Compose

Diese Variante baut das Image direkt aus deinem lokalen Fork-Verzeichnis. Damit ist sichergestellt, dass wirklich der Code aus diesem Repository verwendet wird und nicht das Original-Image.

1. **Repository klonen:**

    ```bash
    git clone https://github.com/herdan75/loxhuebridge_mehrlampensteuerung.git
    cd loxhuebridge_mehrlampensteuerung
    ```

2. **Container bauen und starten:**

    ```bash
    docker compose up -d --build
    ```

3. **Setup öffnen:**

    ```text
    http://<DEINE-IP>:8555
    ```

Der Ordner `data` enthält deine Konfiguration (`config.json`), Mappings (`mapping.json`) und die Log-Datenbank (`logs.db`).

### Datenordner / `DATA_DIR`

Standardmäßig nutzt die Bridge den Ordner `data` direkt im Projektverzeichnis. Der Datenordner hängt nicht vom aktuellen Startverzeichnis ab; dadurch gehen Konfiguration und Mappings nicht scheinbar verloren, wenn der Prozess aus einem anderen Pfad gestartet wird.

Optional kann ein fester Datenpfad gesetzt werden:

```yaml
environment:
  - DATA_DIR=/app/data
volumes:
  - ./data:/app/data
```

Für Docker/Portainer ist die im Beispiel gezeigte Volume-Zuordnung empfohlen, damit Konfiguration und Mappings bei Container-Neubau erhalten bleiben.

### Einmaliges Update von Versionen mit versionierter Logdatenbank

Vor dem ersten Update von einem Stand mit versionierter Logdatenbank auf 2.5.11-dev oder neuer (einschließlich 2.5.12 auf `main`) den kompletten Datenordner sichern. Ältere Git-Stände verfolgen `data/logs.db`; beim Update wird diese Datei aus Git entfernt. Konfiguration und Mapping werden nicht entfernt. Das neue Docker-Image enthält ausschließlich Anwendungscode, keine lokalen Daten oder Backups.

Für die Standardinstallation auf LoxBerry folgenden Block in Bash ausführen. Bei eigenem Volume-Pfad stattdessen diesen Datenordner sichern. Der Block bricht bei Fehlern ab; das Backup liegt außerhalb des Repositorys. Andere lokale Codeänderungen werden nicht verworfen.

```bash
(
set -e
cd /opt/loxberry/loxhuebridge_mehrlampensteuerung
docker compose stop
backup=$(mktemp -d /opt/loxberry/loxhuebridge-backup.XXXXXX)
cp -a data "$backup/data"
printf 'Datensicherung: %s\n' "$backup"
if git ls-files --error-unmatch data/logs.db >/dev/null 2>&1; then
    git restore --source=HEAD --worktree -- data/logs.db
fi
git pull --ff-only
mkdir -p data
cp -a "$backup/data/." data/
docker compose up -d --build
docker compose ps
)
```

`git pull` aktualisiert den bereits ausgewählten Branch; es wechselt nicht automatisch zwischen `main` und `develop`. Scheitert das Update, bleibt die Sicherung erhalten. Vor einem erneuten Start die gesicherten Daten zurückspielen. Die Migration wird mit einem temporären Git-Repository getestet; ein Docker-Build ist eine separate Prüfung.

---

## Main oder Develop?

Dieses Repository verwendet zwei Branches:

| Branch | Version | Zweck |
| --- | --- | --- |
| `main` | `2.5.12` | Stabiler Stand für den normalen Betrieb, inkl. Mehrlampengruppen, Ablauf-Clustern, Effekt-Fallback und Stabilitätskorrekturen |
| `develop` | `2.5.12-dev` | Weiterentwicklungsstand, aktuell mit demselben Anwendungscode wie `main`; künftige Änderungen werden zuerst hier getestet |

Wenn kein Branch angegeben wird, wird normalerweise `main` installiert. Das ist die empfohlene Variante für den normalen Betrieb.

### Develop frisch installieren

```bash
git clone -b develop https://github.com/herdan75/loxhuebridge_mehrlampensteuerung.git
cd loxhuebridge_mehrlampensteuerung
docker compose up -d --build
```

### Bestehende Installation auf develop umstellen

```bash
cd loxhuebridge_mehrlampensteuerung
git fetch
git checkout develop
git pull
docker compose down
docker compose up -d --build
```

Danach im Webinterface unter **System** prüfen:

```text
Version: 2.5.12-dev
```

### Zurück auf main

Bei einer alten Installation zunächst die oben beschriebene Datensicherung durchführen. Ein Branchwechsel allein aktualisiert keinen laufenden Container.

```bash
cd loxhuebridge_mehrlampensteuerung
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose up -d --build
```

Danach zeigt **System** die Version `2.5.12` ohne `-dev` an.

---

## 🐳 docker-compose.yml für diesen Fork

```yaml
services:
  loxhuebridge:
    build:
      context: .
      dockerfile: Dockerfile
    image: loxhuebridge-mehrlampensteuerung:local
    container_name: loxhuebridge
    restart: always
    network_mode: "host"
    environment:
      - TZ=Europe/Vienna
      - DATA_DIR=/app/data
    volumes:
      - ./data:/app/data
```

---

## 🔄 Update dieses Forks

Für den stabilen Branch `main`:

```bash
cd loxhuebridge_mehrlampensteuerung
git checkout main
git pull
docker compose up -d --build
```

Für den Test-/Entwicklungsbranch `develop`:

```bash
cd loxhuebridge_mehrlampensteuerung
git checkout develop
git pull
docker compose up -d --build
```

---

## 🛠 Manuelle Installation (Experten)

Falls du kein Docker nutzen möchtest, benötigst du **Node.js 24** oder neuer.

```bash
git clone https://github.com/herdan75/loxhuebridge_mehrlampensteuerung.git
cd loxhuebridge_mehrlampensteuerung
npm install
node server.js
```

Optional kann eine `.env` Datei im Projektverzeichnis verwendet werden. Sie wird beim Start automatisch geladen, bevor die Konfiguration gelesen wird.

Beispiel:

```env
HUE_BRIDGE_IP=192.168.1.10
HUE_APP_KEY=dein-hue-app-key
LOXONE_IP=192.168.1.20
LOXONE_UDP_PORT=7000
DEBUG=false
HTTP_PORT=8555
LOXHUE_AUTH_TOKEN=
```

`LOXHUE_AUTH_TOKEN` bleibt als optionaler Legacy-/Umgebungszugang möglich. Empfohlen ist aber der Passwortschutz direkt im Webinterface.

### Dashboard/API-Passwortschutz

Im Tab **System** gibt es den Bereich **Sicherheit / Zugriffsschutz**. Dort kann der Schutz für Dashboard und `/api/*` aktiviert werden:

```text
[x] Dashboard/API mit Passwort schützen
Benutzername: admin
Neues Passwort: ********
Passwort wiederholen: ********
```

Das Passwort wird nicht im Klartext gespeichert, sondern als Hash in `config.json`. Loxone-Steuer-URLs wie `/wohnzimmer/50` oder `/wohnzimmer/sunrise/30` bleiben bewusst ohne Auth erreichbar, damit bestehende virtuelle Ausgänge in Loxone weiter funktionieren.

Die Passwortprüfung läuft asynchron mit höchstens zwei parallelen Berechnungen. Erfolgreiche Prüfungen werden höchstens 60 Sekunden in einem begrenzten Cache wiederverwendet; geänderte Zugangsdaten machen alte Berechtigungen ungültig. Nach zehn fehlgeschlagenen Versuchen innerhalb einer Minute wird die betreffende Quelladresse vorübergehend mit HTTP 429 gebremst. Diese HTTP-429-Antwort des Dashboards ist vom Hue-Rate-Limit im Lichtlog zu unterscheiden. Loxone-Steuerpfade bleiben davon ausgenommen.

Der Zugriffsschutz ist für das lokale Netzwerk gedacht. Die Bridge sollte trotzdem nicht direkt aus dem Internet veröffentlicht werden.

---

## 💡 Mehrlampensynchronisierung verwenden

Die Mehrlampensynchronisierung wird **pro einzelner Hue-Lampe** aktiviert. Nur Lampen mit aktivierter Option **Mehrlampensynchronisierung** laufen bei normalen Schalt-, Dimm- und Farbwerten in den gemeinsamen Sammel-/Timing-Ablauf.

Hue Gruppen, Räume und Zonen werden bei normalen numerischen Befehlen weiterhin direkt über `grouped_light` gesteuert. Bei Hue Effekten ist das anders: Da die Hue API v2 Effekte wie `candle` oder `fire` nur am Endpunkt `light` akzeptiert, löst loxHueBridge Gruppen/Räume/Zonen für Effektbefehle automatisch in einzelne Lampen auf.

Empfohlene Einstellung für Ambient-Szenen mit mehreren einzelnen Hue-Lampen:

```text
[x] Sync
[ ] Dynamics ignorieren, falls weiche Übergänge gewünscht sind
[x] Mehrlampensynchronisierung
Ablauf-Cluster: Deckenlampe
Sync-Offset: 0 ms
```

Die drei Ebenen sind bewusst getrennt:

```text
Multi-Sync-Gruppe = Raum oder Szene, z. B. Wohnzimmer
Ablauf-Cluster   = optisch zusammengehörige Lampen, z. B. Deckenlampe, Stehlampe, TV, Buddha
Sync-Offset      = Feintuning pro einzelner Lampe
```

### Einstellungen pro Lampe

| Einstellung | Wirkung |
| --- | --- |
| Loxone Sync | Statusänderungen dieser Lampe werden per UDP an Loxone zurückgemeldet |
| Dynamics ignorieren | Sendet Hue-Befehle ohne `dynamics.duration`. Das ist sinnvoll für reine Schaltaktoren oder wenn ein Gerät mit Hue Dynamics Probleme macht |
| Bei unzuverlässiger Übertragung | Optionale Funkmaßnahme pro einzelner Lampe. Standard ist `Keine` |
| Mehrlampensynchronisierung | Diese einzelne Lampe nimmt am gemeinsamen Sammel-/Timing-Ablauf teil |
| Gruppe | Zuordnung zu Gruppe A-E. Die Gruppennamen können in den globalen Einstellungen frei benannt werden, z. B. Wohnzimmer, Büro oder Küche |
| Ablauf-Cluster | Gleicher frei gewählter Name fasst Lampen innerhalb derselben Gruppe zusammen. Ohne Namen gilt die bekannte Hue-Device-Zuordnung, ansonsten die einzelne Light-UUID als Fallback |
| Sync-Offset | Feinjustierung nur für diese Lampe. Negativ = früher, positiv = später |

Den Sync-Offset erst nach einem Testlauf anpassen:

```text
Lampe reagiert später  → Offset z. B. -30 ms oder -50 ms
Lampe reagiert früher  → Offset z. B. +30 ms oder +50 ms
```

### Funkmaßnahmen pro Lampe

Die Funkmaßnahmen sind nur für einzelne Hue-Lampen gedacht, die sich im Zigbee-Netz unzuverlässig verhalten, z. B. einzelne Fremdhersteller-Leuchtmittel oder LED-Controller. Normalerweise bleibt die Einstellung auf **Keine - Befehl einmal senden**.

| Option | Wirkung | Einsatz |
| --- | --- | --- |
| Keine | Der Befehl wird normal einmal gesendet | Standard für zuverlässig reagierende Hue-Lampen |
| Zustand nachlesen und korrigieren | Prüft nach dem Schalten später `on` und Helligkeit und sendet denselben Payload nur bei Abweichung erneut | Beste Wahl, wenn Lampen manchmal auf falscher Helligkeit bleiben oder nicht sauber übernehmen |
| Einschalten aufteilen | Sendet bei `on=true` mit Zusatzwerten zuerst nur `on=true`, danach Helligkeit/Farbe/Farbtemperatur | Test für Lampen, die beim Einschalten kurz auf 0 % oder alter Helligkeit hängen |
| Befehl wiederholen | Sendet denselben Befehl nach kurzer Verzögerung einmal erneut | Test für einzelne Funk-Aussetzer; nicht global aktivieren |

Die drei Optionen schließen sich gegenseitig aus. Alte Nachprüfungen oder Wiederholungen werden verworfen, sobald ein neuerer Befehl für dieselbe Hue-UUID kommt. Gruppenbefehle unterbinden alte Nachsteuerungen ihrer bekannten Mitglieder. Ist die Mitgliedschaft noch nicht bekannt, werden vorsorglich alle ausstehenden Nachsteuerungen verworfen; normale Lampenbefehle bleiben erhalten.

Die Zustandsprüfung erfolgt nach 15 bzw. 90 Sekunden, solange noch keine vollständige Bestätigung von Ein/Aus und angeforderter Helligkeit vorliegt. Nach einer Bestätigung wird nicht weiter korrigiert. Eine spätere Bedienung über Hue-App oder Schalter darf dadurch nicht wieder rückgängig gemacht werden. Änderungen vor der ersten Bestätigung lassen sich im SSE nicht sicher nach Verursacher unterscheiden. Die Prüfung verifiziert keine Farben und ist keine Garantie für die sichtbare Lichtwirkung.

### Gruppen und globale Multi-Sync Einstellungen

Die Werte können über das Webinterface angepasst werden:

| Einstellung | Empfehlung | Erklärung |
| --- | ---: | --- |
| Max. Bridge-Befehle/s | zunächst 10 | Harte Mindestpause für jeden tatsächlichen Hue-PUT, einschließlich Cluster, Effekte, Retries und Funkmaßnahmen. Bestehende Werte bleiben beim Update erhalten |
| Gruppenname | Gruppe A-E | Frei benennbarer Anzeigename pro Gruppe |
| Sammelfenster | 120 ms | Zeitfenster, in dem mehrere Loxone-Kommandos gesammelt werden |
| Batchgröße | 4-10 | Anzahl Lampen pro logischem Block. Der Wert beeinflusst die zusätzliche Batch-Pause, die maximale Befehlsrate bleibt aber die wichtigste Grenze |
| Batch-Pause | 30 ms | Zusätzliche Pause nach jedem Batch. Hilft, wenn die Bridge bei großen Gruppen kurz ins Stolpern kommt |
| Max. Lichtbefehle/s | 10 | Bestimmt den Abstand zwischen unterschiedlichen Clustern der Gruppe. Innerhalb eines Clusters gilt der Cluster-Abstand, immer mindestens die globale Bridge-Pause |
| Abstand im Ablauf-Cluster | 10 ms Sollwert | Wird automatisch auf mindestens `ceil(1000 / Max. Bridge-Befehle/s)` begrenzt. Beispielsweise sind bei global 20/s auch im Cluster mindestens 50 ms erforderlich |

Es gibt fünf neutrale Gruppen A-E. Alte Installationen ohne Gruppenzuordnung laufen automatisch in Gruppe A weiter. Jede Gruppe hat eigene Timingwerte, zusätzlich begrenzt **Max. Bridge-Befehle/s** die Gesamtlast über alle Gruppen.

Beispiel für ein Wohnzimmer:

```text
Gruppe Wohnzimmer
  Cluster Deckenlampe: deckenlampe_top, deckenlampe_bottom
  Cluster Stehlampe: stehlampe_oben, stehlampe_mitte, stehlampe_unten
  Cluster TV: tv_links, tv_rechts, tv_hintergrund
  Cluster Buddha: buddha_links, buddha_rechts
```

Cluster halten zusammengehörige Lampen in der Reihenfolge zusammen. Ein Cluster-Sollwert von 5 oder 10 ms umgeht die globale Grenze nicht; ein unkontrollierter Burst ist nicht vorgesehen. Zwischen zwei Clustern gilt zusätzlich der Abstand aus `Max. Lichtbefehle/s`. Die Hue Bridge bekommt weiterhin einzelne `/resource/light/{uuid}`-Befehle. Echte Gleichzeitigkeit oder identisches Flackern mehrerer Effekte wird nicht garantiert.

### Hue Effekte auf Gruppen, Räume und Zonen

Effekte können wie bisher über dieselben URLs aus Loxone aufgerufen werden:

```text
/{name}/candle
/{name}/fire
/{name}/fireplace
/{name}/prism
/{name}/sparkle
/{name}/opal
/{name}/glisten
/{name}/noeffect
/{name}/sunrise/30
```

Wenn `{name}` eine einzelne Hue-Lampe ist, wird der Effekt direkt an diese Lampe gesendet.

Wenn `{name}` eine Hue-Gruppe, ein Hue-Raum oder eine Hue-Zone ist, sucht loxHueBridge die enthaltenen Hue-Lampen und sendet den Effekt einzeln an diese Lampen. Damit funktionieren z. B. auch Aufrufe wie:

```text
/wz_group/candle
/wohnzimmer/fire
/ambiente_zone/noeffect
```

Die Hue-Gruppe bleibt also das bequeme Ziel in Loxone, technisch wird aber jede enthaltene Lampe über `/resource/light` angesprochen. Das ist nötig, weil Hue Effekte nicht zuverlässig direkt auf `grouped_light` ausgeführt werden.

Wenn eine enthaltene Lampe in loxHueBridge einer Multi-Sync-Gruppe A-E zugeordnet ist, nutzt der Effekt-Fallback die Timingwerte dieser Gruppe. Nicht zugeordnete Lampen werden mit einem sicheren Standard verteilt. Dadurch können mehrere Lampen sehr zeitnah starten, ohne die Hue Bridge mit einem harten Request-Stoß zu überfahren.

Alternativ können die loxHueBridge Multi-Sync-Gruppen direkt angesprochen werden. Das ist praktisch, wenn die Hue-Raumstruktur nicht exakt der gewünschten Loxone-Steuerung entspricht:

```text
/gruppe_a/candle
/gruppe_b/fire
/group_c/noeffect
/wohnzimmer_ambient/candle
```

Unterstuetzt werden die Aliase `gruppe_a` bis `gruppe_e`, `group_a` bis `group_e`, `multisync_a` bis `multisync_e`, `sync_a` bis `sync_e` sowie der frei vergebene Gruppenname. Bestehende Mappings haben Vorrang, falls ein Loxone-Name gleich heisst.

Für das gesamte Haus können Effekte auf alle einzeln gemappten Hue-Lampen verteilt werden:

```text
/all/candle
/alles/fire
/all/sunrise/30
```

Dabei werden bewusst nur einzelne Hue-Lampen verwendet. Gemappte Hue-Gruppen werden nicht erneut in den Alles-Effekt aufgenommen, damit Lampen nicht doppelt angesteuert werden.

### Timing-Test / Simulation lesen

Der Bereich **Timing-Test** im Webinterface simuliert den Ablauf je Gruppe für alle dort aktivierten Multi-Sync-Lampen:

| Anzeige | Bedeutung |
| --- | --- |
| aktive Lampen | Anzahl einzelner Hue-Lampen mit aktivierter Mehrlampensynchronisierung |
| Mindestabstand | geplanter Abstand zwischen verschiedenen Clustern, mindestens die globale Bridge-Pause |
| im Cluster | geplanter Abstand innerhalb eines Clusters, ebenfalls mindestens die globale Bridge-Pause |
| Planzeit letzter Befehl | Sammelfenster plus Planzeit bis zum Start des letzten Befehls |
| geplante Rate | rechnerische Rate zwischen erstem und letztem geplanten Start, kein gemessener Durchsatz |

Die Detailzeilen zeigen Cluster, Lampenname, Offset und geplanten Zeitpunkt. Die Vorschau nimmt an, dass alle Befehle rechtzeitig im Sammelfenster eintreffen. Laufende Warteschlangen, andere Gruppen, langsame Bridge-Antworten und 429-Retries können den realen Ablauf verlängern.

Beispiel ohne Offsets: zehn Lampen, Sammelfenster 120 ms, Batchgröße 10 und globale sowie Gruppenrate 10/s ergeben mindestens 900 ms zwischen erstem und letztem Start, also etwa 1020 ms Planzeit insgesamt. Bei beiden Raten 20/s sind es etwa 570 ms. Die Antwortzeit wird nicht zusätzlich zur Rate-Pause addiert: Bei serieller Übertragung gilt mindestens das Maximum aus Antwortzeit und Sollabstand.

### Praxiswerte zum Finden des Limits

Für 10-11 einzelne Lampen:

```text
Start:       globale Rate 10/s, Gruppenrate 10/s, Offsets 0
Wenn stabil: beide Raten schrittweise auf 12, 15, dann 20/s testen
Bei Problemen: zum letzten stabilen Wert zurück, Funkmaßnahmen berücksichtigen
```

Hue nennt ungefähr 10 Lichtbefehle/s und 1 Gruppenbefehl/s als Richtwerte. Die öffentliche Angabe verwendet ältere API-Ressourcenbezeichnungen und garantiert keine bestimmte V2-Leistung. Höhere Werte sind experimentell. Andere Anwendungen können zusätzlich Bridge-Kapazität verbrauchen. [Hue Support](https://developers.meethue.com/support/)

Bei Hue-429, verspäteten Reaktionen oder nicht übernommenen Farben zuerst die globale Rate reduzieren. Cluster können den Gruppenabstand verkürzen, aber nicht die globale Grenze. Ein längeres Sammelfenster hilft beim Zusammenfassen von Szenenbefehlen, verzögert jedoch den Start. Es erhöht nicht die Bridge-Kapazität.

### Diagnose pro Lampe

Der Tab **Diagnose** enthält zusätzlich eine Zuverlässigkeitstabelle für Lampenbefehle seit dem letzten Neustart.

| Wert | Bedeutung |
| --- | --- |
| Befehle | Anzahl der von loxHueBridge gesendeten logischen Lampenbefehle |
| Bestätigt | EventStream-Rückmeldungen, die zu `on` oder Helligkeit passen |
| Widersprüche | EventStream-Rückmeldungen oder Hue `communication_error`, die nicht zum erwarteten Zustand passen |
| Verifiziert | Aktive Nachprüfungen durch `Zustand nachlesen und korrigieren` |
| Nachgesteuert | Anzahl der erneut gesendeten Payloads nach bestätigter Abweichung |
| Mapping | Loxone-/Hue-Zuordnung mit Device, Multi-Sync-Gruppe und Ablauf-Cluster |

Diese Diagnose ersetzt keine echte Zigbee-Funkmessung, macht aber sichtbar, welche einzelne Lampe bei Szenen oder schnellen Farbwechseln auffällig reagiert.

Ein erfolgreicher HTTP-PUT ist nur eine Annahme durch die Bridge, kein bestätigter Lampenzustand. Dashboard, UDP und MQTT erhalten Istwerte aus Hue-Abfragen bzw. SSE, nicht aus dem angeforderten Payload. Die Diagnose-API trennt `angefordert` und `angenommenAt` davon. Nicht leere Hue-`errors[]` gelten auch bei HTTP 200 als Fehler.

### Automatisierte Prüfungen

`npm ci` und danach `npm test` führen ausschließlich `test/*.test.js` aus. Die Tests verwenden temporäre Datenordner und simulierte Hue-Antworten, einschließlich echter lokaler HTTP-/Auth-/SSE-Laufwege und Prozess-Shutdown. Manuelle Netzwerkdiagnosen unter `tools/manual/` sind nicht Teil des Testlaufs. Vor einem Docker-Release laufen Tests und Dependency-Audit in CI. Entwicklungs-Tags erhalten kein `latest`-Image.

Gespeichert wird über temporäre Dateien mit atomarem Austausch. Der gemeinsame Config-/Mapping-Restore verwendet zusätzlich ein Wiederherstellungsjournal; nach einem unterbrochenen Restore stellt der nächste Start beide vorherigen Dateien wieder her. Speicherfehler werden als Fehler an die UI zurückgegeben. Ein ungültiger Datenbestand wird nicht still durch eine leere Konfiguration ersetzt.

---

## 📡 MQTT Integration

Die Bridge kann Statuswerte parallel an einen MQTT Broker senden.
Die Konfiguration erfolgt im Web-Interface unter dem Tab **System**.

Ein leeres MQTT-Passwortfeld beim Speichern bedeutet: vorhandenes Passwort beibehalten. Ein gespeichertes Passwort wird nur über die separate Option **MQTT Passwort löschen** entfernt.

**Topic Struktur:**

```text
prefix/typ/name/attribut
```

**Beispiele:**

| Gerät | Topic | Wert (Beispiel) |
|---|---|---|
| **Licht (Ein/Aus)** | `loxhue/light/kueche/on` | `1` / `0` |
| **Licht (Helligkeit)** | `loxhue/light/kueche/bri` | `50.5` |
| **Sensor (Bewegung)** | `loxhue/sensor/flur/motion` | `1` / `0` |
| **Sensor (Temp)** | `loxhue/sensor/bad/temp` | `21.5` |
| **Taster (Event)** | `loxhue/button/taster1/button` | `short_release` |

---

## 🔌 Integration in Loxone (Smart Import)

Anstatt Befehle manuell einzutippen, kannst du deine konfigurierte loxHueBridge direkt in Loxone importieren.

### Schritt 1: Vorlagen exportieren

1. Öffne das **loxHueBridge Dashboard** (`http://<IP>:8555`).
2. Klicke auf **Auswählen / Exportieren** oben rechts bei **Aktiv**.
3. Wähle alle Geräte aus, die du in Loxone haben möchtest.
4. Klicke auf **📥 XML**.
5. Exportiere einmal im Tab **💡 Lichter** und einmal im Tab **📡 Sensoren**.

### Schritt 2: Vorlagen in Loxone Config importieren

1. Öffne **Loxone Config**.
2. Klicke im Menüband oben auf den Tab **Miniserver**.
3. Klicke auf **Gerätevorlagen** und wähle **Vorlage importieren...**.
4. Wähle die heruntergeladene XML-Datei aus.
5. Wiederhole das für Inputs und Outputs.

### Schritt 3: Geräte anlegen

**Für Lichter (Virtuelle Ausgänge):**

1. Klicke im Peripheriebaum auf **Virtuelle Ausgänge**.
2. Klicke auf **Vordefinierte Geräte**.
3. Wähle **LoxHueBridge Lights**.

**Für Sensoren (Virtuelle UDP Eingänge):**

1. Klicke im Peripheriebaum auf **Virtuelle UDP Eingänge**.
2. Klicke auf **Vordefinierte Geräte**.
3. Wähle **LoxHueBridge Sensors**.

Hinweis: Kontrolliere, ob der UDP Empfangsport, Standard `7000`, mit deiner loxHueBridge Einstellung übereinstimmt.

---

## 💡 Manuelle Konfiguration (Referenz)

**Lichter (Virtueller Ausgang):**
Adresse: `http://<IP-DER-BRIDGE>:8555`

| Funktion | Befehl bei EIN / Analog | Erklärung |
| --- | --- | --- |
| **Ausschalten** | `/kueche/<v>` | Schaltet aus bei Wert 0 |
| **Dimmen** | `/kueche/<v>` | Werte 2-100 % |
| **Warmweiß** | `/kueche/<v>` | Smart Actuator Logik im Format `20BBBKKKK`, z. B. `201002700` |
| **RGB** | `/kueche/<v>` | RGB Logik: R + G*1000 + B*1000000, jede Komponente 0-100 |

Warmweiß-Werte werden strikt als `20BBBKKKK` validiert: `BBB` ist die Helligkeit `000..100`, `KKKK` ist Kelvin `2000..6500`. Beispiel `201002700` bedeutet 100 % bei 2700 K. Ungültige Werte werden mit HTTP 400 abgelehnt.

RGB-Werte werden strikt validiert. R, G und B müssen jeweils im Bereich `0..100` liegen. Werte außerhalb dieses Bereichs werden abgelehnt, damit Hue keine ungültige Helligkeit größer als 100 erhält.

**Sensoren (UDP Eingang):**
Port: 7000, falls nicht geändert.

| Typ | Befehlserkennung |
| --- | --- |
| **Bewegung** | `hue.bwm_flur.motion \v` |
| **Helligkeit** | `hue.bwm_flur.lux \v` |
| **Temperatur** | `hue.bwm_flur.temp \v` |
| **Taster (Klick)** | `hue.taster.button short_release` |
| **Taster (Lang)** | `hue.taster.button long_press` |
| **Drehring (Rechts)** | `hue.dial.rotary cw` |
| **Drehring (Links)** | `hue.dial.rotary ccw` |

---

## 🧪 Prüfung

Syntaxprüfung lokal oder im Container:

```bash
node --check lib/hue.js
node --check lib/config.js
node --check lib/logger.js
node --check lib/routes.js
node --check public/app.js
node --check server.js
npm test
```

Logs prüfen:

```bash
docker logs -f loxhuebridge
```

Bei erfolgreichem SSE-Fix sollten die bisherigen EventStream-JSON-Fehler nicht mehr auftreten.

---

## 🤝 Hinweise

**#kiassisted** 🤖

Diese Dokumentation beschreibt die hier gepflegte Version mit Mehrlampensynchronisierung, Hue Effekt-Fallback, robuster SSE/EventStream-Verarbeitung und erweiterten Diagnosefunktionen.
