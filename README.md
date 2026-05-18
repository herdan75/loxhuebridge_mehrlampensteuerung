# loxHueBridge Mehrlampensteuerung 🇦🇹

**loxHueBridge** ist eine bidirektionale Schnittstelle zwischen dem **Loxone Miniserver**, der **Philips Hue Bridge (V2 / API)** und optional **MQTT**.

Dieser Fork erweitert loxHueBridge um eine **gruppierte Mehrlampensynchronisierung pro Lampe**, einen **Effekt-Fallback fuer Hue Gruppen/Raeume/Zonen** und behebt das **robuste SSE/EventStream Parsing** bei großen Hue Events.

Sie ermöglicht eine extrem schnelle, lokale Steuerung ohne Cloud-Verzögerung und nutzt die moderne Hue Event-Schnittstelle (SSE), um Statusänderungen in Echtzeit an Loxone (UDP) und MQTT Broker zurückzumelden.

> Originalprojekt: https://github.com/bausi2k/loxhuebridge  
> Fork: https://github.com/herdan75/loxhuebridge_mehrlampensteuerung

---

## 🚀 Features V2.5.1-dev Mehrlampensteuerung

### Neu in diesem Fork

* **Mehrlampensynchronisierung pro Lampe:** Einzelne Hue-Lampen können gezielt in einen gemeinsamen Sammel-/Batch-Ablauf aufgenommen werden.
* **Multi-Sync Gruppen A-E:** Lampen können einer von fünf neutralen Gruppen zugeordnet werden, z. B. für Wohnzimmer, Büro oder Küche.
* **Freie Gruppennamen:** Gruppe A-E können im Systembereich individuell benannt werden.
* **Eigene Einstellungen pro Gruppe:** Sammelfenster, Batchgröße, Batch-Pause, Lichtbefehle/s und Timing-Test sind pro Gruppe separat einstellbar.
* **Globale Bridge-Sicherheitsgrenze:** `Max. Bridge-Befehle/s` begrenzt die Gesamtlast über alle Gruppen hinweg, falls mehrere Räume gleichzeitig schalten.
* **Hue Effekt-Fallback fuer Gruppen/Raeume/Zonen:** Effektbefehle wie `candle`, `fire`, `prism`, `sparkle`, `opal`, `glisten`, `noeffect` und `sunrise` werden bei Hue Gruppen/Raeumen/Zonen intern auf die enthaltenen einzelnen Hue-Lampen verteilt.
* **Multi-Sync Timing auch fuer Gruppen-Effekte:** Wenn enthaltene Lampen einer loxHueBridge Gruppe A-E zugeordnet sind, werden deren Timing-/Rate-Einstellungen auch beim Effekt-Fallback verwendet.
* **Direkte Multi-Sync Effektziele:** loxHueBridge Gruppen koennen direkt per URL angesprochen werden, z. B. `/gruppe_a/candle`, `/group_b/fire` oder ueber den frei vergebenen Gruppennamen.
* **Sync-Offset pro Lampe:** Jede Lampe kann zeitlich feinjustiert werden.
    * negativer Offset = früher senden
    * positiver Offset = später senden
    * sinnvoller Bereich: ca. -500 ms bis +1000 ms
* **Sammelfenster für gleichzeitige Szenen:** Mehrere Loxone-Kommandos werden kurz gesammelt und dann gebündelt an die Hue Bridge gesendet.
* **Batch-Steuerung:** Mehrere Lampen werden in kleinen Gruppen nahezu parallel gesendet, ohne die Hue Bridge unnötig zu überlasten.
* **Einstellbares Hue-Limit:** Die maximale Anzahl Lichtbefehle pro Sekunde kann angepasst werden, um je nach Lampenanzahl das schnellste stabile Limit der eigenen Bridge zu finden.
* **Timing-Test im UI:** Das Webinterface zeigt für die aktivierten Multi-Sync-Lampen Lampenanzahl, Mindestabstand, geschätzte Gesamtdauer und effektive Befehlsrate.
* **Queue-Bypass nur für Multi-Sync-Lampen:** Die bestehende Queue bleibt für normale Lampen erhalten. Nur Lampen mit aktivierter Mehrlampensynchronisierung nutzen den neuen Ablauf.
* **Robuster SSE/EventStream Parser:** Behebt sporadische Fehler wie:
    * `Unexpected end of JSON input`
    * `Unterminated string in JSON`
    * `Expected double-quoted property name in JSON`
* **Globale Multi-Sync Feineinstellungen:** Sammelfenster, Batchgröße und Batch-Pause sind konfigurierbar.

### Bestehende Features

* **Nativer „Alles" Befehl:** Nutzt die Hue `bridge_home` API für blitzschnelles Ausschalten des gesamten Hauses.
* **Hue Effekte & Alert:** Steuere Lampen, Hue Raeume/Zonen und loxHueBridge Multi-Sync-Lampen mit atmosphärischen Effekten direkt aus Loxone:
    * `/{name}/alert` → Einmaliges Blinken (Alarmmeldung, Türklingel)
    * `/{name}/candle` / `/fire` / `/prism` / `/sparkle` → Persistente Atmosphäre-Effekte
    * `/{name}/noeffect` → Effekt stoppen
    * `/{name}/sunrise/30` → 30-Sekunden Sonnenaufgang (oder beliebige Dauer)
* **Modularer Kern:** Hochperformante und wartbare Backend-Architektur durch saubere Modul-Trennung (`lib/`).
* **Smart Setup:** Automatische Suche der Hue Bridge und Pairing per Web-Interface.
* **Live Dashboard:** Echtzeit-Anzeige aller Lichter, Sensoren und Batteriestände.
* **Smart Mapping:** Einfache Zuordnung per „Klick & Wähl" mit automatischer Duplikatsfilterung bei erkannten Befehlen.
* **Erweiterter Diagnose-Tab:** Zeigt Gerätestatus, Zigbee-Konnektivität pro Gerät und eine vollständige Übersicht aller Lampen-Fähigkeiten.
* **Persistent Logging (SQLite):** Logs bleiben nach Neustarts erhalten und sind durchsuchbar.
* **Backup & Restore:** Lade deine komplette Konfiguration inkl. Mappings als Backup herunter und stelle sie bei Bedarf wieder her.
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

---

## Main oder Develop?

Dieses Repository verwendet zwei Branches:

| Branch | Zweck |
| --- | --- |
| `main` | Stabiler Stand fuer den normalen Betrieb, inkl. Mehrlampengruppen und Effekt-Fallback |
| `develop` | Test-/Weiterentwicklungsstand fuer neue Funktionen vor der Uebernahme nach `main` |

Wenn kein Branch angegeben wird, wird normalerweise `main` installiert. Das ist die empfohlene Variante fuer den normalen Betrieb.

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
Version: 2.5.1-dev
```

### Zurück auf main

```bash
cd loxhuebridge_mehrlampensteuerung
git checkout main
git pull
docker compose down
docker compose up -d --build
```

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

---

## 💡 Mehrlampensynchronisierung verwenden

Die Mehrlampensynchronisierung wird **pro einzelner Hue-Lampe** aktiviert. Nur Lampen mit aktivierter Option **Mehrlampensynchronisierung** laufen bei normalen Schalt-, Dimm- und Farbwerten in den gemeinsamen Sammel-/Timing-Ablauf.

Hue Gruppen, Räume und Zonen werden bei normalen numerischen Befehlen weiterhin direkt ueber `grouped_light` gesteuert. Bei Hue Effekten ist das anders: Da die Hue API v2 Effekte wie `candle` oder `fire` nur am Endpunkt `light` akzeptiert, loest loxHueBridge Gruppen/Raeume/Zonen fuer Effektbefehle automatisch in einzelne Lampen auf.

Empfohlene Einstellung für Ambient-Szenen mit mehreren einzelnen Hue-Lampen:

```text
[x] Sync
[ ] Dynamics ignorieren, falls weiche Übergänge gewünscht sind
[x] Mehrlampensynchronisierung
Sync-Offset: 0 ms
```

### Einstellungen pro Lampe

| Einstellung | Wirkung |
| --- | --- |
| Loxone Sync | Statusänderungen dieser Lampe werden per UDP an Loxone zurückgemeldet |
| Dynamics ignorieren | Sendet Hue-Befehle ohne `dynamics.duration`. Das ist sinnvoll für reine Schaltaktoren oder wenn ein Gerät mit Hue Dynamics Probleme macht |
| Mehrlampensynchronisierung | Diese einzelne Lampe nimmt am gemeinsamen Sammel-/Timing-Ablauf teil |
| Gruppe | Zuordnung zu Gruppe A-E. Die Gruppennamen koennen in den globalen Einstellungen frei benannt werden, z. B. Wohnzimmer, Buero oder Kueche |
| Sync-Offset | Feinjustierung nur für diese Lampe. Negativ = früher, positiv = später |

Den Sync-Offset erst nach einem Testlauf anpassen:

```text
Lampe reagiert später  → Offset z. B. -30 ms oder -50 ms
Lampe reagiert früher  → Offset z. B. +30 ms oder +50 ms
```

### Gruppen und globale Multi-Sync Einstellungen

Die Werte können über das Webinterface angepasst werden:

| Einstellung | Empfehlung | Erklärung |
| --- | ---: | --- |
| Max. Bridge-Befehle/s | 30 | Sicherheitsgrenze über alle Multi-Sync-Gruppen hinweg. Wichtig, wenn mehrere Räume gleichzeitig schalten |
| Gruppenname | Gruppe A-E | Frei benennbarer Anzeigename pro Gruppe |
| Sammelfenster | 120 ms | Zeitfenster, in dem mehrere Loxone-Kommandos gesammelt werden |
| Batchgröße | 4-10 | Anzahl Lampen pro logischem Block. Der Wert beeinflusst die zusätzliche Batch-Pause, die maximale Befehlsrate bleibt aber die wichtigste Grenze |
| Batch-Pause | 30 ms | Zusätzliche Pause nach jedem Batch. Hilft, wenn die Bridge bei großen Gruppen kurz ins Stolpern kommt |
| Max. Lichtbefehle/s | 10 | Limit der jeweiligen Gruppe. Für die eigene Bridge schrittweise erhöhen, z. B. 15, 20, 25/s |

Es gibt fünf neutrale Gruppen A-E. Alte Installationen ohne Gruppenzuordnung laufen automatisch in Gruppe A weiter. Jede Gruppe hat eigene Timingwerte, zusätzlich begrenzt **Max. Bridge-Befehle/s** die Gesamtlast über alle Gruppen.

### Hue Effekte auf Gruppen, Raeume und Zonen

Effekte koennen wie bisher ueber dieselben URLs aus Loxone aufgerufen werden:

```text
/{name}/candle
/{name}/fire
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

Die Hue-Gruppe bleibt also das bequeme Ziel in Loxone, technisch wird aber jede enthaltene Lampe ueber `/resource/light` angesprochen. Das ist noetig, weil Hue Effekte nicht zuverlaessig direkt auf `grouped_light` ausgefuehrt werden.

Wenn eine enthaltene Lampe in loxHueBridge einer Multi-Sync-Gruppe A-E zugeordnet ist, nutzt der Effekt-Fallback die Timingwerte dieser Gruppe. Nicht zugeordnete Lampen werden mit einem sicheren Standard verteilt. Dadurch koennen mehrere Lampen sehr zeitnah starten, ohne die Hue Bridge mit einem harten Request-Stoss zu ueberfahren.

Alternativ koennen die loxHueBridge Multi-Sync-Gruppen direkt angesprochen werden. Das ist praktisch, wenn die Hue-Raumstruktur nicht exakt der gewuenschten Loxone-Steuerung entspricht:

```text
/gruppe_a/candle
/gruppe_b/fire
/group_c/noeffect
/wohnzimmer_ambient/candle
```

Unterstuetzt werden die Aliase `gruppe_a` bis `gruppe_e`, `group_a` bis `group_e`, `multisync_a` bis `multisync_e`, `sync_a` bis `sync_e` sowie der frei vergebene Gruppenname. Bestehende Mappings haben Vorrang, falls ein Loxone-Name gleich heisst.

### Timing-Test / Simulation lesen

Der Bereich **Timing-Test** im Webinterface simuliert den Ablauf je Gruppe für alle dort aktivierten Multi-Sync-Lampen:

| Anzeige | Bedeutung |
| --- | --- |
| aktive Lampen | Anzahl einzelner Hue-Lampen mit aktivierter Mehrlampensynchronisierung |
| Mindestabstand | rechnerischer Abstand zwischen zwei REST-Befehlen, abgeleitet aus `Max. Lichtbefehle/s` |
| bis letzter Befehl | geschätzte Zeit vom Auslösen bis zum letzten gesendeten Lampenbefehl |
| effektiv | effektive Befehlsrate des geplanten Ablaufs |

Beispiel mit 10 aktiven Lampen, `Sammelfenster 120 ms`, `Batchgröße 10`, `Batch-Pause 30 ms`, `Max. Lichtbefehle/s 10`: Der Mindestabstand beträgt 100 ms und der letzte Befehl wird nach ca. 1020 ms gesendet. Das ist Hue-konservativ. Mit 20/s sinkt der Mindestabstand auf 50 ms und derselbe Ablauf wirkt deutlich zeitnäher.

### Praxiswerte zum Finden des Limits

Für 10-11 einzelne Lampen:

```text
Start:       20/s
Wenn stabil: 25/s
Optional:    30/s
Bei Problemen: zurück auf 20/s oder 15/s
```

Typische Zeichen für ein zu hohes Limit sind 429-Fehler im Log, einzelne Lampen reagieren spürbar später, Farben werden nicht sauber übernommen oder der EventStream meldet auffällig viele Folgeupdates. In diesem Fall `Max. Lichtbefehle/s` reduzieren oder die Batch-Pause erhöhen.

---

## 📡 MQTT Integration

Die Bridge kann Statuswerte parallel an einen MQTT Broker senden.
Die Konfiguration erfolgt im Web-Interface unter dem Tab **System**.

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
| **Warmweiß** | `/kueche/<v>` | Smart Actuator Logik, z. B. `201002700` |
| **RGB** | `/kueche/<v>` | RGB Logik: R + G*1000 + B*1000000 |

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
node --check lib/routes.js
node --check public/app.js
npm test
```

Logs prüfen:

```bash
docker logs -f loxhuebridge
```

Bei erfolgreichem SSE-Fix sollten die bisherigen EventStream-JSON-Fehler nicht mehr auftreten.

---

## 🤝 Credits

**#kiassisted** 🤖

Dieses Projekt basiert auf dem Originalprojekt von **bausi2k** und wurde in diesem Fork um Mehrlampensynchronisierung und robustes SSE-Parsing erweitert.

Originalprojekt: https://github.com/bausi2k/loxhuebridge

<a href="https://www.buymeacoffee.com/bausi2k" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
