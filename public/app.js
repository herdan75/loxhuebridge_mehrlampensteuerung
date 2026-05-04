    let currentTab = 'light';
    let targets = [];
    let mappings = [];
    let status = {};
    let detectedHistory = [];
    let logInterval = null;
    let allSelected = false;
    let currentLogFilter = 'ALL';
    let cachedLogs = [];
    let searchTimeout = null; 

    function debugLog(msg) { console.log(`[UI] ${msg}`); }

    async function init() {
        debugLog("Init...");
        await loadTargets();
        await loadMappings();
        loadDetected(); 
        loadStatus();
        setInterval(loadDetected, 3000);
        setInterval(loadStatus, 2000);
        loadLogs();
    }

    function setTab(tab) {
        debugLog(`Tab: ${tab}`);
        currentTab = tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
        const hint = document.getElementById('hintAll');
        if(hint) hint.style.display = tab === 'light' ? 'block' : 'none';

        document.getElementById('main-interface').classList.remove('active');
        document.getElementById('system-interface').classList.remove('active');
        document.getElementById('diag-interface').classList.remove('active');
        
        if(logInterval) { clearInterval(logInterval); logInterval = null; }

        if (tab === 'system') {
            document.getElementById('system-interface').classList.add('active');
            loadSettings();
            loadLogs();
            if(!logInterval) logInterval = setInterval(loadLogs, 2000);
        } else if (tab === 'diag') {
            document.getElementById('diag-interface').classList.add('active');
            loadDiagnostics();
        } else {
            document.getElementById('main-interface').classList.add('active');
            renderDropdown(); 
            renderMappings();
        }
    }

    async function loadDiagnostics() {
        const div = document.getElementById('diagContent');
        if(!div) return;
        div.innerHTML = '<div style="text-align:center">Lade Daten...</div>';
        
        await loadMappings();
        await loadStatus();

        const typeConfig = {
            'light':  { icon: '💡', label: 'Licht', order: 1 },
            'group':  { icon: '📦', label: 'Gruppe', order: 2 },
            'sensor': { icon: '📡', label: 'Sensor', order: 3 },
            'button': { icon: '🔘', label: 'Schalter', order: 4 }
        };

        const sorted = [...mappings].sort((a,b) => {
            const tA = typeConfig[a.hue_type] ? typeConfig[a.hue_type].order : 99;
            const tB = typeConfig[b.hue_type] ? typeConfig[b.hue_type].order : 99;
            if (tA !== tB) return tA - tB; 
            const sA = status[a.loxone_name] || {};
            const sB = status[b.loxone_name] || {};
            const batA = sA.bat !== undefined ? sA.bat : 100;
            const batB = sB.bat !== undefined ? sB.bat : 100;
            if (batA !== batB) return batA - batB; 
            return a.loxone_name.localeCompare(b.loxone_name);
        });

        // --- Abschnitt 1: Mapping Status-Tabelle ---
        let html = '<h3 style="margin-top:0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">📋 Geräte & Batterien</h3>';
        html += '<table class="settings-table"><thead><tr><th>Name</th><th>Typ</th><th>Batterie</th><th>Letzter Wert</th></tr></thead><tbody>';
        
        sorted.forEach(m => {
            const st = status[m.loxone_name] || {};
            let bat = '-';
            let batStyle = '';
            if (st.bat !== undefined) {
                bat = st.bat + '%';
                if (st.bat <= 10) batStyle = 'color:red; font-weight:bold';
                else if (st.bat <= 20) batStyle = 'color:orange';
            }
            let lastVal = '';
            if (st.on !== undefined) lastVal += `On:${st.on} `;
            if (st.bri !== undefined) lastVal += `Bri:${Math.round(st.bri)} `;
            if (st.motion !== undefined) lastVal += `Mot:${st.motion} `;
            if (st.contact !== undefined) lastVal += `Con:${st.contact} `;
            if (st.temp !== undefined) lastVal += `${st.temp}°C `;
            const tConf = typeConfig[m.hue_type] || {icon:'❓', label: m.hue_type};
            html += `<tr>
                <td><div style="font-weight:bold">${m.loxone_name}</div><div style="font-size:0.8em;color:#666">${m.hue_name}</div></td>
                <td><span class="badge" style="background:#f1f3f5;color:#333; border:1px solid #ddd">${tConf.icon} ${tConf.label}</span></td>
                <td style="${batStyle}">${bat}</td>
                <td style="font-size:0.8em; font-family:monospace; color:#555">${lastVal}</td>
            </tr>`;
        });
        html += '</tbody></table>';
        div.innerHTML = html;

        // --- Abschnitt 2 & 3: Bridge-Diagnose asynchron nachladen ---
        try {
            const bridgeRes = await fetch('/api/diagnostics/bridge');
            if (!bridgeRes.ok) throw new Error('Bridge API nicht verfügbar');
            const diagData = await bridgeRes.json();
            if (!diagData) throw new Error('Keine Daten');

            // Zigbee Bridge-Info
            let bridgeHtml = '<h3 style="margin-top: 30px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">🌐 Bridge & Zigbee Netzwerk</h3>';
            if (diagData.zigbee?.bridge) {
                const b = diagData.zigbee.bridge;
                bridgeHtml += `<table class="settings-table"><tbody>`;
                if (b.bridge_id)    bridgeHtml += `<tr><td>Bridge ID</td><td style="font-family:monospace">${b.bridge_id}</td></tr>`;
                if (b.time_zone?.time_zone) bridgeHtml += `<tr><td>Zeitzone</td><td>${b.time_zone.time_zone}</td></tr>`;
                bridgeHtml += `</tbody></table>`;
            }

            // Zigbee Konnektivität pro Gerät
            if (diagData.zigbee?.connectivity?.length > 0) {
                bridgeHtml += `<table class="settings-table" style="margin-top:10px"><thead><tr><th>Gerät</th><th>Zigbee Status</th><th>UUID</th></tr></thead><tbody>`;
                diagData.zigbee.connectivity.forEach(c => {
                    const status_val = c.status || '?';
                    let statusColor = '#888';
                    if (status_val === 'connected') statusColor = 'var(--success,#4caf50)';
                    else if (status_val === 'connectivity_issue') statusColor = 'red';
                    else if (status_val === 'unidirectional_incoming') statusColor = 'orange';
                    const devName = diagData.serviceToDeviceMap?.[c.id]?.deviceName || '–';
                    bridgeHtml += `<tr>
                        <td style="font-weight:bold">${devName}</td>
                        <td><span style="color:${statusColor}; font-weight:bold">● ${status_val}</span></td>
                        <td style="font-size:0.75em;color:#888;font-family:monospace">${c.id}</td>
                    </tr>`;
                });
                bridgeHtml += `</tbody></table>`;
            }

            // Lampen-Capabilities
            let capsHtml = '<h3 style="margin-top: 30px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">🎭 Lampen-Fähigkeiten & Effekte</h3>';
            const lightMappings = mappings.filter(m => m.hue_type === 'light' || m.hue_type === 'group');
            if (lightMappings.length > 0 && diagData.capabilities) {
                capsHtml += `<table class="settings-table"><thead><tr><th>Loxone Name</th><th>Dimm</th><th>Farbe</th><th>Weiß</th><th>Effekte (persistent)</th><th>Zeiteffekte</th></tr></thead><tbody>`;
                lightMappings.sort((a,b) => a.loxone_name.localeCompare(b.loxone_name)).forEach(m => {
                    const caps = diagData.capabilities[m.hue_uuid] || {};
                    const yes = '<span style="color:var(--success,#4caf50)">✅</span>';
                    const no  = '<span style="color:#ccc">❌</span>';
                    const effects = caps.supportedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#f0f0f0">${e}</span>`).join(' ') || '<span style="color:#ccc">–</span>';
                    const timedFx = caps.supportedTimedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#e8f5e9">${e}</span>`).join(' ') || '<span style="color:#ccc">–</span>';
                    capsHtml += `<tr>
                        <td><div style="font-weight:bold">${m.loxone_name}</div><div style="font-size:0.8em;color:#666">${m.hue_name}</div></td>
                        <td style="text-align:center">${caps.supportsDimming ? yes : no}</td>
                        <td style="text-align:center">${caps.supportsColor  ? yes : no}</td>
                        <td style="text-align:center">${caps.supportsCt     ? yes : no}</td>
                        <td>${effects}</td>
                        <td>${timedFx}</td>
                    </tr>`;
                });
                capsHtml += `</tbody></table>`;
            } else {
                capsHtml += `<p style="color:var(--text-muted)">Keine Licht-Mappings vorhanden oder Bridge nicht erreichbar.</p>`;
            }

            div.innerHTML += bridgeHtml + capsHtml;

        } catch(e) {
            div.innerHTML += `<div style="color:var(--text-muted);margin-top:20px;text-align:center;">⚠️ Bridge-Diagnose nicht verfügbar: ${e.message}</div>`;
        }
    }

    async function loadDetected() {
        try {
            const res = await fetch('/api/detected');
            const detected = await res.json();
            const filteredDetected = detected.filter(d => d.type === 'command')
                                             .filter((v, i, a) => a.findIndex(t => t.name === v.name) === i);
            if (JSON.stringify(filteredDetected) === JSON.stringify(detectedHistory)) return;
            detectedHistory = filteredDetected;
            const list = document.getElementById('detectedList');
            const container = document.getElementById('detectedContainer');
            if (filteredDetected.length === 0) { container.style.display = 'none'; return; }
            container.style.display = 'block';
            list.innerHTML = '';
            filteredDetected.forEach(d => {
                const div = document.createElement('div');
                div.className = `chip command`;
                div.innerHTML = `<span>📥</span> /${d.name}`;
                div.onclick = () => {
                    if (currentTab !== 'light') setTab('light');
                    document.getElementById('inName').value = d.name;
                    document.getElementById('inName').focus();
                };
                list.appendChild(div);
            });
        } catch(e) { console.error("Fehler bei loadDetected:", e); }
    }

    function setLogFilter(filter) {
        currentLogFilter = filter;
        document.querySelectorAll('.filter-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.filter === filter);
        });
        loadLogs(); 
    }

    function delaySearch() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(loadLogs, 400); 
    }

    async function loadLogs() {
        try {
            let url = '/api/logs?limit=100';
            if (currentLogFilter !== 'ALL') url += `&category=${currentLogFilter}`;
            const searchInput = document.getElementById('logSearch');
            if (searchInput && searchInput.value.trim()) url += `&search=${encodeURIComponent(searchInput.value.trim())}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("Netzwerkfehler");
            cachedLogs = await res.json();
            renderLogs();
        } catch(e) {
            const el = document.getElementById('logConsole');
            if(el) el.innerHTML = `<div style="color:red;text-align:center">Fehler: ${e.message}</div>`;
        }
    }

    function renderLogs() {
        const consoleDiv = document.getElementById('logConsole');
        if(!consoleDiv) return;
        if (!cachedLogs || cachedLogs.length === 0) {
            consoleDiv.innerHTML = '<div style="text-align:center; color:#555; padding-top:20px;">Keine Einträge gefunden.</div>';
            return;
        }
        const html = cachedLogs.map(l => {
            const cat = l.category || 'SYSTEM';
            let lvlColor = '#fff';
            if(l.level === 'INFO') lvlColor = '#61afef';
            if(l.level === 'SUCCESS') lvlColor = '#98c379';
            if(l.level === 'WARN') lvlColor = '#e5c07b';
            if(l.level === 'ERROR') lvlColor = '#e06c75';
            if(l.level === 'DEBUG') lvlColor = '#c678dd';
            return `<div class="log-entry" style="border-bottom:1px solid #333; margin-bottom:2px; font-family:monospace; font-size:0.85rem;">` +
                `<span class="log-time" style="color:#888; margin-right:10px;">${l.time}</span>` +
                `<span class="log-cat" style="background:#444; color:#fff; padding:1px 4px; border-radius:3px; margin-right:5px; font-size:0.8em">${cat}</span>` +
                `<span class="log-level" style="color:${lvlColor}; font-weight:bold; margin-right:10px;">${l.level}</span>` +
                `<span style="color:#ddd; white-space: pre-wrap;">${l.msg}</span>` +
            `</div>`;
        }).join('');
        if(consoleDiv.innerHTML.length !== html.length) consoleDiv.innerHTML = html;
    }

    function renderMappings() {
        const list = document.getElementById('mappingList');
        if(!list) return;
        list.innerHTML = '';
        const filtered = mappings.filter(m => {
            if (currentTab === 'light') return m.hue_type === 'light' || m.hue_type === 'group';
            if (currentTab === 'sensor') return m.hue_type === 'sensor';
            if (currentTab === 'button') return m.hue_type === 'button';
            return false;
        });
        
        const appendGroup = (title, items, color) => {
            if(items.length===0) return;
            items.sort((a,b) => {
                const sA = status[a.loxone_name] || {};
                const sB = status[b.loxone_name] || {};
                const batA = sA.bat !== undefined ? sA.bat : 100;
                const batB = sB.bat !== undefined ? sB.bat : 100;
                if (batA !== batB) return batA - batB; 
                const actA = (sA.motion || sA.contact) ? 1 : 0;
                const actB = (sB.motion || sB.contact) ? 1 : 0;
                if (actA !== actB) return actB - actA; 
                return a.loxone_name.localeCompare(b.loxone_name);
            });

            const h = document.createElement('div');
            h.innerText = title; h.style.cssText = `font-weight:bold; color:${color}; margin:15px 0 5px 0; border-bottom:1px solid #ddd;`;
            list.appendChild(h);
            items.forEach(m=>list.appendChild(createMappingItem(m)));
        };

        if(currentTab === 'sensor') {
            const motion = [], contact = [], other = [];
            filtered.forEach(m => {
                const st = status[m.loxone_name] || {};
                if(st.contact !== undefined) contact.push(m);
                else if(st.motion !== undefined) motion.push(m);
                else other.push(m);
            });
            appendGroup(`🚪 Kontakte (${contact.length})`, contact, 'var(--danger)');
            appendGroup(`🏃 Bewegung (${motion.length})`, motion, 'var(--sensor)');
            appendGroup(`📡 Sonstige (${other.length})`, other, 'var(--text-muted)');
        } else if(currentTab === 'light') {
            const on = [], off = [];
            filtered.forEach(m => {
                const st = status[m.loxone_name] || {};
                (st.on === 1 || st.on === true ? on : off).push(m);
            });
            on.sort((a,b)=>a.loxone_name.localeCompare(b.loxone_name));
            off.sort((a,b)=>a.loxone_name.localeCompare(b.loxone_name));
            appendGroup(`💡 Ein (${on.length})`, on, 'var(--accent)');
            appendGroup(`🌑 Aus (${off.length})`, off, 'var(--text-muted)');
        } else {
            // FIX: Schalter nach Batterie sortieren (leer zuerst), danach alphabetisch
            filtered.sort((a,b) => {
                const sA = status[a.loxone_name] || {};
                const sB = status[b.loxone_name] || {};
                const batA = sA.bat !== undefined ? sA.bat : 100;
                const batB = sB.bat !== undefined ? sB.bat : 100;
                
                if (batA !== batB) return batA - batB; // Batterie aufsteigend
                return a.loxone_name.localeCompare(b.loxone_name); // Name alphabetisch
            });
            filtered.forEach(m => list.appendChild(createMappingItem(m)));
        }
        if(filtered.length === 0) list.innerHTML = '<div style="padding:10px; color:#999; text-align:center">Leer</div>';
    }

    function createMappingItem(m) {
        const st = status[m.loxone_name] || {};
        let badges = '';
        const has = (v) => v !== undefined && v !== null;

        if (has(st.motion)) badges += `<span class="badge" style="background:var(--border)">${st.motion?'🏃':'🧘'}</span>`;
        if (has(st.temp)) badges += `<span class="badge">${st.temp}°C</span>`;
        if (has(st.lux)) badges += `<span class="badge">${st.lux} lx</span>`;
        if (has(st.contact)) badges += `<span class="badge" style="background:${st.contact?'#ffcdcd':'#e1ffe1'}">${st.contact?'🔓 OFFEN':'🔒 ZU'}</span>`;
        if (has(st.bat)) {
            if (st.bat <= 10) {
                badges += `<span class="badge" style="background:#ffcdcd; color:red; font-weight:bold;">🪫 ${st.bat}% (Leer)</span>`;
            } else {
                badges += `<span class="badge">🔋 ${st.bat}%</span>`;
            }
        }
        
        if (has(st.on)) {
            if(currentTab === 'light' || st.on) {
                const bg = st.on ? '#e1ffe1' : '#eee';
                const txt = st.on ? 'AN' : 'AUS';
                badges += `<span class="badge" style="background:${bg}">${txt}</span>`;
            }
        }
        
        if (has(st.bri) && st.on) badges += `<span class="badge">${Math.round(st.bri)}%</span>`;
        if (st.hex && st.on) badges += `<span class="color-dot" style="background-color:${st.hex}"></span>`;
        if (st.rotary) { 
            const val = (st.rotary === 'cw' || st.rotary === 'ccw') ? st.rotary.toUpperCase() : st.rotary;
            badges += `<span class="badge" style="background:#e1f5fe">🔄 ${val}</span>`; 
        }

        const div = document.createElement('div');
        div.className = `mapping-item type-${m.hue_type}`;
        
        // Modal Trigger
        div.onclick = () => showDetails(m.hue_uuid, m.loxone_name);

        div.innerHTML = `
            <div>
                <div class="mapping-lox">${m.loxone_name}</div>
                <div class="mapping-hue">${m.hue_name}</div>
            </div>
            <div style="display:flex; align-items:center">
                <div class="status-badges">${badges}</div>
                <button class="del-btn" onclick="event.stopPropagation(); deleteMapping('${m.loxone_name}')">✖</button>
            </div>
        `;
        return div;
    }

    async function loadTargets() { try { targets = await (await fetch('/api/targets')).json(); if(currentTab!=='system') renderDropdown(); } catch(e){ console.error("Fehler bei loadTargets:", e); } }
    async function loadMappings() { try { mappings = await (await fetch('/api/mapping')).json(); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadMappings:", e); } }
    async function loadStatus() { try { status = await (await fetch('/api/status')).json(); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadStatus:", e); } }
    
    function renderDropdown() {
        const select = document.getElementById('hueTarget');
        if(!select) return;
        select.innerHTML = '<option value="">-- Wählen --</option>';

        // Füge "Alle Lichter" als spezielle Option hinzu (nur im Lichter-Tab und wenn noch kein 'all'-Mapping existiert)
        if (currentTab === 'light' && !mappings.some(m => m.hue_uuid === 'pseudo-all' || m.loxone_name === 'all')) {
            const allOpt = document.createElement('option');
            allOpt.value = 'pseudo-all';
            allOpt.innerHTML = '🏠 Alle Lichter (bridge_home)';
            allOpt.dataset.type = 'group';
            select.appendChild(allOpt);
        }

        targets.forEach(t => {
            if(mappings.some(m=>m.hue_uuid === t.uuid)) return;
            if(currentTab === 'light' && (t.type !== 'light' && t.type !== 'group')) return;
            if(currentTab === 'sensor' && t.type !== 'sensor') return;
            if(currentTab === 'button' && t.type !== 'button') return;
            const opt = document.createElement('option');
            opt.value = t.uuid; opt.innerHTML = t.name; opt.dataset.type = t.type;
            select.appendChild(opt);
        });
    }

    async function addMapping() {
        const nameIn = document.getElementById('inName');
        const hueSel = document.getElementById('hueTarget');
        if(!nameIn.value || !hueSel.value) return alert("Fehlende Daten");
        mappings.push({loxone_name: nameIn.value.toLowerCase(), hue_uuid: hueSel.value, hue_name: hueSel.options[hueSel.selectedIndex].text, hue_type: hueSel.options[hueSel.selectedIndex].dataset.type});
        await fetch('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(mappings)});
        nameIn.value=''; loadMappings(); loadTargets();
    }
    async function deleteMapping(name) {
        if(!confirm('Löschen?')) return;
        mappings = mappings.filter(m=>m.loxone_name !== name);
        await fetch('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(mappings)});
        loadMappings(); loadTargets();
    }

    // --- NEU: DYNAMISCHES SPEICHERN FÜR CHECKBOXEN IM MODAL ---
    async function updateMappingSetting(loxName, key, val) {
        const entry = mappings.find(m => m.loxone_name === loxName);
        if (entry) {
            entry[key] = val;
            await fetch('/api/mapping', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(mappings) });
            renderMappings();
        }
    }

    async function saveSettings() {
        const d = {};
        ['sys_loxIp', 'sys_loxPort', 'sys_mqttBroker', 'sys_mqttPort', 'sys_mqttUser', 'sys_mqttPass', 'sys_mqttPrefix'].forEach(id => d[id.replace('sys_','')] = document.getElementById(id).value);
        
        d.transitionTime = document.getElementById('sys_transition').value;
        d.throttleTime = document.getElementById('sys_throttle').value;

        d.debug = document.getElementById('sys_debug').checked;
        d.mqttEnabled = document.getElementById('sys_mqttEnabled').checked;
        d.disableLogDisk = document.getElementById('sys_disableLogDisk').checked;

        try {
            await fetch('/api/setup/loxone', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
                loxoneIp: d.loxIp, loxonePort: d.loxPort, debug: d.debug,
                transitionTime: d.transitionTime, throttleTime: d.throttleTime,
                mqttEnabled: d.mqttEnabled, mqttBroker: d.mqttBroker, mqttPort: d.mqttPort, mqttUser: d.mqttUser, mqttPass: d.mqttPass, mqttPrefix: d.mqttPrefix,
                disableLogDisk: d.disableLogDisk
            })});
            alert("Gespeichert!");
            loadSettings();
        } catch(e) { alert("Fehler!"); }
    }

    async function loadSettings() {
        try {
            const s = await (await fetch('/api/settings')).json();
            const table = document.getElementById('settingsTable');
            const v = (val) => val !== undefined ? val : '';
            
            table.innerHTML = `
                <tr><td colspan="2" style="background:#eee;font-weight:bold">Allgemein</td></tr>
                <tr><td>Version</td><td><span class="badge" style="background:#333;color:#fff">${s.version}</span></td></tr>
                <tr><td>Loxone IP</td><td><input id="sys_loxIp" value="${v(s.loxone_ip)}"></td></tr>
                <tr><td>UDP Port</td><td><input type="number" id="sys_loxPort" value="${v(s.loxone_port)}"></td></tr>
                
                <tr>
                    <td>Übergangszeit</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_transition" min="0" max="1000" step="50" value="${v(s.transitionTime)}" oninput="document.getElementById('val_trans').innerText = this.value + ' ms'">
                            <span id="val_trans" class="slider-val">${v(s.transitionTime)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>Drosselung</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_throttle" min="0" max="1000" step="50" value="${v(s.throttleTime)}" oninput="document.getElementById('val_thro').innerText = this.value + ' ms'">
                            <span id="val_thro" class="slider-val">${v(s.throttleTime)} ms</span>
                        </div>
                    </td>
                </tr>
                
                <tr><td>Debug Modus</td><td><input type="checkbox" id="sys_debug" ${s.debug?'checked':''}></td></tr>
                <tr>
                    <td>SD-Card Mode</td>
                    <td>
                        <input type="checkbox" id="sys_disableLogDisk" ${s.disableLogDisk?'checked':''}>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Deaktiviert Schreibzugriffe auf logs.db.</div>
                    </td>
                </tr>

                <tr><td colspan="2" style="background:#eee;font-weight:bold">MQTT</td></tr>
                <tr><td>Aktivieren</td><td><input type="checkbox" id="sys_mqttEnabled" ${s.mqttEnabled?'checked':''}></td></tr>
                <tr><td>Broker IP</td><td><input id="sys_mqttBroker" value="${v(s.mqttBroker)}"></td></tr>
                <tr><td>Port</td><td><input type="number" id="sys_mqttPort" value="${v(s.mqttPort)||1883}"></td></tr>
                <tr><td>User</td><td><input id="sys_mqttUser" value="${v(s.mqttUser)}"></td></tr>
                <tr><td>Passwort</td><td><input type="password" id="sys_mqttPass" value="${v(s.mqttPass)}"></td></tr>
                <tr><td>Prefix</td><td><input id="sys_mqttPrefix" value="${v(s.mqttPrefix)||'loxhue'}"></td></tr>
            `;
        } catch(e){ console.error("Fehler bei loadSettings:", e); }
    }

    function showDetails(uuid, loxoneName) {
        const target = targets.find(t => t.uuid === uuid);
        const entry = mappings.find(m => m.loxone_name === loxoneName);
        const currentStatus = status[loxoneName] || {};
        if(!target || !entry) return;

        let content = `<div style="margin-bottom:20px;">`;

        // 1. SETTINGS (nur für Lichter/Gruppen)
        if (entry.hue_type === 'light' || entry.hue_type === 'group') {
            const caps = target.capabilities || {};
            const supportsDimming = entry.hue_type === 'group' ? true : !!caps.supportsDimming; 
            
            const isStrictOnOff = entry.hue_type === 'light' && !supportsDimming;
            const ignoreDyn = isStrictOnOff ? true : !!entry.ignore_dynamics;
            const disableIgnoreDyn = isStrictOnOff ? 'disabled' : '';

            content += `
                <h3 style="margin-top:0; font-size:1rem; color:var(--text-main);">⚙️ Einstellungen</h3>
                
                <div class="settings-card">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" ${entry.sync_lox ? 'checked' : ''} onchange="updateMappingSetting('${loxoneName}', 'sync_lox', this.checked)"> 
                        <span style="font-weight:500;">Loxone Sync</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">Sendet Statusänderungen per UDP an Loxone zurück.</div>
                </div>

                <div class="settings-card" style="opacity: ${isStrictOnOff ? '0.6' : '1'};">
                    <label style="display:flex; align-items:center; gap:10px; cursor:${isStrictOnOff ? 'not-allowed' : 'pointer'};">
                        <input type="checkbox" ${ignoreDyn ? 'checked' : ''} ${disableIgnoreDyn} onchange="updateMappingSetting('${loxoneName}', 'ignore_dynamics', this.checked)"> 
                        <span style="font-weight:500;">Dynamics ignorieren</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">
                        ${isStrictOnOff ? 'Dieses Gerät ist ein reiner On/Off Schalter und unterstützt kein Dimmen. Parameter ist erzwungen aktiv.' : 'Deaktiviert weiche Übergangszeiten (Transition) beim Schalten für dieses Gerät.'}
                    </div>
                </div>
                
                <hr style="border:0; border-top:1px solid var(--border); margin: 20px 0;">
            `;
        }

        // 2. STATUS & SPECS (für alle Geräte)
        content += `<h3 style="margin-top:0; font-size:1rem; color:var(--text-main);">⚡ Aktueller Status</h3><table class="details-table">`;
        const isOn = currentStatus.on === 1 || currentStatus.on === true;
        
        if (currentStatus.on !== undefined) {
            content += `<tr><td>Zustand</td><td>${isOn ? '<span class="status-ok">AN</span>' : '<span style="color:#888">AUS</span>'}</td></tr>`;
        }
        
        if (isOn) {
            if (currentStatus.bri !== undefined) content += `<tr><td>Helligkeit</td><td>${Math.round(currentStatus.bri)} %</td></tr>`;
            if (currentStatus.mirek) content += `<tr><td>Temperatur</td><td>${Math.round(1000000 / currentStatus.mirek)} K</td></tr>`;
            if (currentStatus.hex) content += `<tr><td>Farbe</td><td><span class="color-dot" style="background-color:${currentStatus.hex}"></span> <span style="font-family:monospace">${currentStatus.hex}</span></td></tr>`;
        }

        // Sensor Stats
        if (currentStatus.bat !== undefined) content += `<tr><td>Batterie</td><td>${currentStatus.bat} %</td></tr>`;
        if (currentStatus.temp !== undefined) content += `<tr><td>Temperatur</td><td>${currentStatus.temp} °C</td></tr>`;
        if (currentStatus.lux !== undefined) content += `<tr><td>Helligkeit</td><td>${currentStatus.lux} lx</td></tr>`;
        if (currentStatus.contact !== undefined) content += `<tr><td>Kontakt</td><td>${currentStatus.contact === 1 ? '🔓 Offen' : '🔒 Geschlossen'}</td></tr>`;
        if (currentStatus.motion !== undefined) content += `<tr><td>Bewegung</td><td>${currentStatus.motion === 1 ? '🏃 Ja' : '🧘 Nein'}</td></tr>`;

        content += `<tr><td colspan="2" style="border-bottom:none; padding-top:20px; color:var(--text-muted); font-weight:bold;">📋 Technische Daten</td></tr>`;
        content += `<tr><td>Name</td><td>${target.name}</td></tr>`;
        content += `<tr><td>Loxone ID</td><td>${loxoneName}</td></tr>`;
        content += `<tr><td>Typ</td><td><span class="badge" style="background:#eee;color:#333">${entry.hue_type}</span></td></tr>`;
        content += `<tr><td>UUID</td><td style="font-size:0.8em; font-family:monospace">${target.uuid}</td></tr>`;
        content += `</table></div>`;

        document.getElementById('detailsContent').innerHTML = content;
        document.getElementById('detailsModal').style.display = 'flex';
    }

    function toggleSelectAll() { allSelected = !allSelected; document.querySelectorAll('.modal-checkbox').forEach(cb => cb.checked = allSelected); }
    function doExport() {
        const checked = document.querySelectorAll('.modal-checkbox:checked');
        if(checked.length === 0) return alert("Bitte wählen.");
        const names = Array.from(checked).map(cb => cb.value).join(',');
        const type = currentTab === 'light' ? 'outputs' : 'inputs';
        window.location.href = `/api/download/${type}?names=${names}`;
        closeModal('exportModal');
    }
    
    async function restartServer() { if(confirm("Neustart?")) await fetch('/api/system/restart', {method:'POST'}); }
    function downloadLog() { window.location.href = '/api/system/logdownload'; }
    function downloadBackup() { window.location.href = '/api/system/backup'; }
    function triggerRestore() { document.getElementById('restoreInput').click(); }
    async function restoreBackup(input) {
        if(!input.files.length) return;
        const file = input.files[0];
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const json = JSON.parse(e.target.result);
                await fetch('/api/system/restore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(json)});
                alert("Wiederhergestellt! Neustart...");
                setTimeout(() => location.reload(), 3000);
            } catch(err) { alert("Fehler: " + err.message); }
        };
        reader.readAsText(file);
    }
    function updateTransLabel(val, id, unit) { document.getElementById(id).innerText = val + ' ' + unit; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function openExportModal() { document.getElementById('exportModal').style.display = 'flex'; loadExportList(); allSelected = false; }
    function loadExportList() {
        const list = document.getElementById('exportList');
        list.innerHTML = '';
        const filtered = mappings.filter(m => {
            if (currentTab === 'light') return m.hue_type === 'light' || m.hue_type === 'group';
            if (currentTab === 'sensor') return m.hue_type === 'sensor';
            if (currentTab === 'button') return m.hue_type === 'button';
            return false;
        });
        filtered.sort((a,b) => a.loxone_name.localeCompare(b.loxone_name));
        filtered.forEach(m => {
            const item = document.createElement('div');
            item.className = 'modal-item';
            item.innerHTML = `<input type="checkbox" class="modal-checkbox" value="${m.loxone_name}"><div><div style="font-weight:bold">${m.loxone_name}</div></div>`;
            list.appendChild(item);
        });
    }

    init();
