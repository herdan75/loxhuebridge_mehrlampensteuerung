// test-temp.js
const DAIKIN_IP = "192.168.1.21"; // ⚠️ Hier die IP deiner Daikin eintragen!

async function fetchRawDaikinData() {
    const endpoints = [
        '/aircon/get_sensor_info',
        '/aircon/get_control_info',
        '/domestic/get_sensor_info' // Spezieller Endpunkt bei manchen Altherma-Modellen für Warmwasser
    ];

    console.log(`Starte Daikin-Abfrage für IP: ${DAIKIN_IP}...\n`);

    for (const endpoint of endpoints) {
        try {
            console.log(`--- Prüfe Endpunkt: ${endpoint} ---`);
            const res = await fetch(`http://${DAIKIN_IP}${endpoint}`);

            if (!res.ok) {
                console.log(`❌ Fehler: HTTP ${res.status}`);
                continue;
            }

            const rawData = await res.text();
            console.log("Raw Response String:");
            console.log(rawData);

            // Daikin sendet oft im Format "ret=OK,htemp=25.0,otemp=14.0"
            // Wir zerlegen das für eine bessere Lesbarkeit in eine schöne Tabelle
            if (rawData.includes(',')) {
                const dataObj = Object.fromEntries(
                    rawData.split(',').map(pair => pair.split('='))
                );
                console.log("\nFormatierte Werte:");
                console.table(dataObj);
            } else {
                // Falls die Anlage JSON sendet (bei neueren Modellen)
                try {
                    const jsonObj = JSON.parse(rawData);
                    console.log("\nJSON Daten:");
                    console.table(jsonObj);
                } catch (e) {
                    // War kein JSON, bleibt einfach der rohe String
                }
            }
            console.log("\n");

        } catch (error) {
            console.log(`❌ Endpunkt ${endpoint} nicht erreichbar oder existiert nicht.\n`);
        }
    }
}

fetchRawDaikinData();