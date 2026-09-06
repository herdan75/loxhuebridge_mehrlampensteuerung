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
    const MULTI_SYNC_GROUP_IDS = ['a', 'b', 'c', 'd', 'e'];
    let multiLightControlSettings = { groups: MULTI_SYNC_GROUP_IDS.map(id => ({ id, name: `Gruppe ${id.toUpperCase()}` })) };
    let securitySettings = { authEnabled: false, authUser: 'admin', passwordConfigured: false };
    let detailsDraft = null;

    function debugLog(msg) { console.log(`[UI] ${msg}`); }

    async function init() {
        debugLog("Init...");
        await loadTargets();
        await loadMappings();
        loadMultiSyncSettingsCache();
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

    // --- Hilfsfunktion für einheitliche Batteriewarnungen ---
    function getBatteryHTML(bat) {
        if (bat === undefined || bat === null) return { badge: '', textStyle: '' };
        
        let color = '';
        let badgeStyle = '';
        let textStyle = '';
        let icon = '🔋';

        if (bat <= 10) {
            color = 'red';
            badgeStyle = 'background:#ffcdcd; color:red; font-weight:bold;';
            textStyle = 'color:red; font-weight:bold;';
            icon = '🪫';
        } else if (bat <= 20) {
            color = 'orange';
            badgeStyle = 'background:#fff3e0; color:orange; font-weight:bold;';
            textStyle = 'color:orange; font-weight:bold;';
            icon = '🔋';
        }

        const badge = `<span class="badge" style="${badgeStyle}">${icon} ${bat}%${bat <= 10 ? ' (Leer)' : ''}</span>`;
        return { badge, textStyle };
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
            const { badge, textStyle } = getBatteryHTML(st.bat);

            let lastVal = '';
            if (st.on !== undefined) lastVal += `On:${st.on} `;
            if (st.bri !== undefined) lastVal += `Bri:${Math.round(st.bri)} `;
            if (st.motion !== undefined) lastVal += `Mot:${st.motion} `;
            if (st.contact !== undefined) lastVal += `Con:${st.contact} `;
            if (st.temp !== undefined) lastVal += `${st.temp}°C `;
            const tConf = typeConfig[m.hue_type] || {icon:'❓', label: m.hue_type};
            html += `<tr>
                <td style="${textStyle}"><div style="font-weight:bold">${escapeHtml(m.loxone_name)}</div><div style="font-size:0.8em;color:#666">${escapeHtml(m.hue_name)}</div></td>
                <td><span class="badge" style="background:#f1f3f5;color:#333; border:1px solid #ddd">${escapeHtml(tConf.icon)} ${escapeHtml(tConf.label)}</span></td>
                <td>${badge || '-'}</td>
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
                        <td style="font-weight:bold">${escapeHtml(devName)}</td>
                        <td><span style="color:${statusColor}; font-weight:bold">● ${escapeHtml(status_val)}</span></td>
                        <td style="font-size:0.75em;color:#888;font-family:monospace">${escapeHtml(c.id)}</td>
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
                    const rawCaps = diagData.capabilities[m.hue_uuid] || {};
                    const caps = {
                        ...rawCaps,
                        supportedEffects: rawCaps.supportedEffects?.map(escapeHtml),
                        supportedTimedEffects: rawCaps.supportedTimedEffects?.map(escapeHtml)
                    };
                    const yes = '<span style="color:var(--success,#4caf50)">✅</span>';
                    const no  = '<span style="color:#ccc">❌</span>';
                    const effects = caps.supportedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#f0f0f0">${e}</span>`).join(' ') || '<span style="color:#ccc">–</span>';
                    const timedFx = caps.supportedTimedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#e8f5e9">${e}</span>`).join(' ') || '<span style="color:#ccc">–</span>';
                    capsHtml += `<tr>
                        <td><div style="font-weight:bold">${escapeHtml(m.loxone_name)}</div><div style="font-size:0.8em;color:#666">${escapeHtml(m.hue_name)}</div></td>
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
            div.innerHTML += `<div style="color:var(--text-muted);margin-top:20px;text-align:center;">⚠️ Bridge-Diagnose nicht verfügbar: ${escapeHtml(e.message)}</div>`;
        }

        try {
            const lampRes = await fetch('/api/diagnostics/lampen');
            if (!lampRes.ok) throw new Error('Lampendiagnose nicht verfügbar');
            const lampRows = await lampRes.json();
            let lampHtml = '<h3 style="margin-top: 30px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">📶 Zuverlässigkeit der Lampenbefehle</h3>';

            if (!lampRows.length) {
                lampHtml += `<p style="color:var(--text-muted)">Noch keine Lampenbefehle seit dem letzten Neustart erfasst.</p>`;
            } else {
                lampHtml += `<div class="diag-scroll"><table class="settings-table diag-table"><thead><tr>
                    <th>Loxone Name</th>
                    <th>Befehle</th>
                    <th>Bestätigt</th>
                    <th>Widersprüche</th>
                    <th>Quote</th>
                    <th>Verifiziert</th>
                    <th>Nachgesteuert</th>
                    <th>Communication Errors</th>
                    <th>Mapping</th>
                    <th>Letzter Widerspruch</th>
                </tr></thead><tbody>`;

                lampRows.forEach(row => {
                    const quote = Number(row.quote || 0);
                    const problem = (row.widersprueche || 0) > 0 || (row.communicationErrors || 0) > 0;
                    const color = !problem ? 'var(--success,#4caf50)' : (quote >= 10 ? 'red' : 'orange');
                    const mapping = row.mapping || {};
                    const mappingText = [
                        mapping.deviceName ? `Device: ${mapping.deviceName}` : '',
                        mapping.multiSync ? `Sync: ${mapping.multiSyncGroup || '-'} / ${mapping.syncCluster || '-'}` : 'Sync: aus'
                    ].filter(Boolean).join('<br>');
                    const last = row.letzterWiderspruch
                        ? `${escapeHtml(row.letzterWiderspruch.erwartet || '')} → ${escapeHtml(row.letzterWiderspruch.gemeldet || '')}<br><span style="color:var(--text-muted)">nach ${Math.round((row.letzterWiderspruch.nachMs || 0) / 1000)} s</span>`
                        : (row.letzterFehler ? escapeHtml(row.letzterFehler) : '<span style="color:#ccc">-</span>');

                    lampHtml += `<tr>
                        <td><div style="font-weight:bold">${escapeHtml(row.name || row.uuid)}</div><div style="font-size:0.75em;color:#888;font-family:monospace">${escapeHtml(row.uuid)}</div></td>
                        <td style="text-align:right">${row.befehle || 0}</td>
                        <td style="text-align:right">${row.bestaetigt || 0}</td>
                        <td style="text-align:right;color:${color};font-weight:bold">${row.widersprueche || 0}</td>
                        <td style="text-align:right;color:${color}">${quote} %</td>
                        <td style="text-align:right">${row.verifiziert || 0}</td>
                        <td style="text-align:right">${row.nachgesteuert || 0}</td>
                        <td style="text-align:right;color:${(row.communicationErrors || 0) ? 'orange' : 'inherit'}">${row.communicationErrors || 0}</td>
                        <td style="font-size:0.8em">${mappingText}</td>
                        <td style="font-size:0.8em">${last}</td>
                    </tr>`;
                });
                lampHtml += `</tbody></table></div>`;
            }

            div.innerHTML += lampHtml;
        } catch(e) {
            div.innerHTML += `<div style="color:var(--text-muted);margin-top:20px;text-align:center;">⚠️ Lampendiagnose nicht verfügbar: ${escapeHtml(e.message)}</div>`;
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
                div.innerHTML = `<span>📥</span> /${escapeHtml(d.name)}`;
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
            if(el) el.innerHTML = `<div style="color:red;text-align:center">Fehler: ${escapeHtml(e.message)}</div>`;
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
            const cat = escapeHtml(l.category || 'SYSTEM');
            const level = escapeHtml(l.level || '');
            const time = escapeHtml(l.time || '');
            const msg = escapeHtml(l.msg || '');
            let lvlColor = '#fff';
            if(l.level === 'INFO') lvlColor = '#61afef';
            if(l.level === 'SUCCESS') lvlColor = '#98c379';
            if(l.level === 'WARN') lvlColor = '#e5c07b';
            if(l.level === 'ERROR') lvlColor = '#e06c75';
            if(l.level === 'DEBUG') lvlColor = '#c678dd';
            return `<div class="log-entry" style="border-bottom:1px solid #333; margin-bottom:2px; font-family:monospace; font-size:0.85rem;">` +
                `<span class="log-time" style="color:#888; margin-right:10px;">${time}</span>` +
                `<span class="log-cat" style="background:#444; color:#fff; padding:1px 4px; border-radius:3px; margin-right:5px; font-size:0.8em">${cat}</span>` +
                `<span class="log-level" style="color:${lvlColor}; font-weight:bold; margin-right:10px;">${level}</span>` +
                `<span style="color:#ddd; white-space: pre-wrap;">${msg}</span>` +
            `</div>`;
        }).join('');
        if(consoleDiv.innerHTML !== html) consoleDiv.innerHTML = html;
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

        if (has(st.motion)) badges += `<span class="badge" style="background:var(--border)">${st.motion ? '🏃' : '🧘'}</span>`;
        if (has(st.temp)) badges += `<span class="badge">${escapeHtml(safeNumber(st.temp))}°C</span>`;
        if (has(st.lux)) badges += `<span class="badge">${escapeHtml(safeNumber(st.lux))} lx</span>`;
        if (has(st.contact)) badges += `<span class="badge" style="background:${st.contact ? '#ffcdcd' : '#e1ffe1'}">${st.contact ? 'OFFEN' : 'ZU'}</span>`;
        const { badge: batBadge, textStyle: batTextStyle } = getBatteryHTML(st.bat);
        if (batBadge) badges += batBadge;

        if (has(st.on)) {
            if (currentTab === 'light' || st.on) {
                const bg = st.on ? '#e1ffe1' : '#eee';
                const txt = st.on ? 'AN' : 'AUS';
                badges += `<span class="badge" style="background:${bg}">${txt}</span>`;
            }
        }

        if (has(st.bri) && st.on) badges += `<span class="badge">${escapeHtml(Math.round(safeNumber(st.bri, 0)))}%</span>`;
        if (st.hex && st.on) badges += `<span class="color-dot" style="background-color:${safeHexColor(st.hex)}"></span>`;
        if (st.rotary) {
            const val = (st.rotary === 'cw' || st.rotary === 'ccw') ? st.rotary.toUpperCase() : st.rotary;
            badges += `<span class="badge" style="background:#e1f5fe">${escapeHtml(val)}</span>`;
        }

        const div = document.createElement('div');
        div.className = `mapping-item type-${escapeHtml(m.hue_type)}`;
        div.onclick = () => showDetails(m.hue_uuid, m.loxone_name);

        div.innerHTML = `
            <div style="${batTextStyle}">
                <div class="mapping-lox">${escapeHtml(m.loxone_name)}</div>
                <div class="mapping-hue">${escapeHtml(m.hue_name)}</div>
            </div>
            <div style="display:flex; align-items:center">
                <div class="status-badges">${badges}</div>
                <button class="del-btn" onclick="event.stopPropagation(); deleteMapping(${jsArg(m.loxone_name)})">✖</button>
            </div>
        `;
        return div;
    }

    async function loadTargets() { try { targets = await apiRequest('/api/targets'); if(currentTab!=='system') renderDropdown(); } catch(e){ console.error("Fehler bei loadTargets:", e); } }
    async function loadMappings() { try { mappings = await apiRequest('/api/mapping'); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadMappings:", e); } }
    async function loadStatus() { try { status = await apiRequest('/api/status'); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadStatus:", e); } }
    async function loadMultiSyncSettingsCache() {
        try {
            const s = await (await fetch('/api/settings')).json();
            multiLightControlSettings = s.multiLightControl || multiLightControlSettings;
        } catch(e) { console.error("Fehler bei loadMultiSyncSettingsCache:", e); }
    }
    
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
            opt.value = t.uuid; opt.textContent = t.name; opt.dataset.type = t.type;
            select.appendChild(opt);
        });
    }

    async function apiRequest(url, options = {}) {
        const response = await fetch(url, { credentials: 'same-origin', ...options });
        const text = await response.text();
        let payload;
        try { payload = text ? JSON.parse(text) : null; }
        catch { throw new Error(`Ungültige Serverantwort (HTTP ${response.status}).`); }
        if (!response.ok || payload?.success === false ||
            (options.method === 'POST' && payload?.success !== true)) {
            throw new Error(payload?.error || `Anfrage fehlgeschlagen (HTTP ${response.status}).`);
        }
        return payload;
    }

    async function addMapping() {
        const nameIn = document.getElementById('inName');
        const hueSel = document.getElementById('hueTarget');
        if(!nameIn.value || !hueSel.value) return alert("Fehlende Daten");
        const candidate = [...mappings, {
            loxone_name: nameIn.value.toLowerCase(),
            hue_uuid: hueSel.value,
            hue_name: hueSel.options[hueSel.selectedIndex].text,
            hue_type: hueSel.options[hueSel.selectedIndex].dataset.type,
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: false,
            sync_cluster: '',
            sync_offset_ms: 0,
            verify_state: false,
            split_on: false,
            repeat_command: false
        }];
        try {
            await apiRequest('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(candidate)});
            mappings = candidate;
            nameIn.value=''; loadMappings(); loadTargets();
        } catch (error) { alert('Speichern fehlgeschlagen: ' + error.message); }
    }
    async function deleteMapping(name) {
        if(!confirm('Löschen?')) return;
        const candidate = mappings.filter(m=>m.loxone_name !== name);
        try {
            await apiRequest('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(candidate)});
            mappings = candidate;
            loadMappings(); loadTargets();
        } catch (error) { alert('Löschen fehlgeschlagen: ' + error.message); }
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function safeHexColor(value, fallback = '#cccccc') {
        const text = String(value ?? '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
    }

    function jsArg(value) {
        return JSON.stringify(String(value ?? ''))
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/'/g, '\\u0027');
    }

    function safeNumber(value, fallback = '') {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function infoLabel(label, tip) {
        return `<span class="setting-label">${escapeHtml(label)} <span class="setting-help" tabindex="0" data-tip="${escapeHtml(tip)}">i</span></span>`;
    }

    function getMultiSyncFormSettings(groupId = 'a') {
        const numberValue = (id, fallback) => {
            const el = document.getElementById(id);
            const value = el ? Number(el.value) : fallback;
            return Number.isFinite(value) ? value : fallback;
        };
        const nameEl = document.getElementById(`sys_multiName_${groupId}`);
        const defaultName = `Gruppe ${groupId.toUpperCase()}`;

        return {
            id: groupId,
            name: nameEl && nameEl.value.trim() ? nameEl.value.trim() : defaultName,
            syncWindowMs: numberValue(`sys_multiSyncWindowMs_${groupId}`, 120),
            batchSize: Math.max(1, numberValue(`sys_multiBatchSize_${groupId}`, 4)),
            batchDelayMs: Math.max(0, numberValue(`sys_multiBatchDelayMs_${groupId}`, 30)),
            maxCommandsPerSecond: Math.max(1, numberValue(`sys_multiMaxCommandsPerSecond_${groupId}`, 10)),
            sameClusterSpacingMs: Math.max(0, Math.min(50, numberValue(`sys_multiSameClusterSpacingMs_${groupId}`, 10)))
        };
    }

    function getBridgeMaxCommandsPerSecondFromForm() {
        const el = document.getElementById('sys_multiBridgeMaxCommandsPerSecond');
        const value = el ? Number(el.value) : 30;
        return Number.isFinite(value) ? Math.max(1, value) : 30;
    }

    function renderMultiSyncPreview(groupId = null) {
        const ids = groupId ? [groupId] : MULTI_SYNC_GROUP_IDS;

        ids.forEach(id => {
            const el = document.getElementById(`multiSyncPreview_${id}`);
            if (!el) return;

            const settings = getMultiSyncFormSettings(id);
            const items = mappings
                .filter(entry => entry.hue_type === 'light' && entry.multi_sync === true && (entry.multi_sync_group || 'a') === id)
                .map(entry => ({ entry, uuid: entry.hue_uuid }));
            const bridgeRate = getBridgeMaxCommandsPerSecondFromForm();
            const scheduleItems = MultiSyncTiming.buildSchedule(items, {
                ...settings, bridgeMaxCommandsPerSecond: bridgeRate
            }, item => {
                const cluster = normalizeSyncCluster(item.entry.sync_cluster);
                const target = targets.find(target => target.uuid === item.uuid);
                return {
                    key: cluster ? 'manual:' + cluster.toLowerCase() : 'auto:' + (target?.deviceId || item.uuid),
                    name: cluster || target?.deviceName || 'Einzel'
                };
            }).map(schedule => ({
                ...schedule, delay: schedule.delayMs,
                item: { ...schedule.item, offset: schedule.offset, clusterName: schedule.clusterName, originalIndex: schedule.originalIndex }
            }));
            const activeLights = items.length;
            const commandSpacingMs = Math.max(Math.ceil(1000 / bridgeRate), Math.ceil(1000 / settings.maxCommandsPerSecond));
            const sameClusterSpacingMs = Math.max(Math.ceil(1000 / bridgeRate), settings.sameClusterSpacingMs);
            const scheduleItemsSorted = scheduleItems;
            const lastCommandMs = scheduleItems.at(-1)?.delay || 0;
            const totalMs = settings.syncWindowMs + lastCommandMs;
            const effectiveRate = activeLights > 1 && lastCommandMs > 0
                ? ((activeLights - 1) / (lastCommandMs / 1000)).toFixed(1) : activeLights.toFixed(1);
            const smallestGap = scheduleItems.length > 1
                ? Math.min(...scheduleItems.slice(1).map((item, i) => item.delay - scheduleItems[i].delay))
                : commandSpacingMs;
            const fastestRate = 1000 / Math.max(1, smallestGap);
            const hint = fastestRate <= 10
                ? 'Hue-konservativ'
                : 'Experimentell';
            const scheduleHtml = scheduleItems.length
                ? `<div style="margin-top:8px; max-height:150px; overflow:auto; border-top:1px solid var(--border); padding-top:6px;">
                    ${scheduleItemsSorted.map(schedule => `
                        <div class="multi-sync-schedule-row" style="display:grid; grid-template-columns: minmax(70px,0.8fr) minmax(0,1.4fr) 70px 80px; gap:8px; font-size:0.75rem; padding:2px 0;">
                            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(schedule.item.clusterName)}</span>
                            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(schedule.item.entry.loxone_name)}</span>
                            <span>${schedule.item.offset > 0 ? '+' : ''}${schedule.item.offset} ms</span>
                            <span>${Math.round(settings.syncWindowMs + schedule.delay)} ms</span>
                        </div>
                    `).join('')}
                </div>`
                : '';

            el.innerHTML = `
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap:8px;">
                    <div><b>${activeLights}</b><br><span>aktive Lampen</span></div>
                    <div><b>${commandSpacingMs} ms</b><br><span>Mindestabstand</span></div>
                    <div><b>${sameClusterSpacingMs} ms</b><br><span>im Cluster</span></div>
                    <div><b>${Math.round(totalMs)} ms</b><br><span>Planzeit letzter Befehl</span></div>
                    <div><b>${effectiveRate}/s</b><br><span>geplante Rate</span></div>
                </div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;">
                    Modus: ${hint}. Globale Bridge-Grenze: ${getBridgeMaxCommandsPerSecondFromForm()}/s.
                </div>
                ${scheduleHtml}
            `;
        });
    }

    function renderMultiSyncGroupRows(settings) {
        const cfg = settings || {};
        const groups = cfg.groups || MULTI_SYNC_GROUP_IDS.map(id => ({ id, name: `Gruppe ${id.toUpperCase()}`, syncWindowMs: 120, batchSize: 4, batchDelayMs: 30, maxCommandsPerSecond: 10, sameClusterSpacingMs: 10 }));
        let html = `
            <tr>
                <td>${infoLabel('Max. Bridge-Befehle/s', 'Harte Mindestpause für alle Hue-PUTs, auch Cluster, Effekte, Retries und Funkmaßnahmen. Bei 20/s mindestens 50 ms zwischen Starts. Bei Hue 429 senken; zunächst 10/s testen.')}</td>
                <td>
                    <div class="slider-container">
                        <input type="range" id="sys_multiBridgeMaxCommandsPerSecond" min="1" max="100" step="1" value="${cfg.bridgeMaxCommandsPerSecond ?? 30}" oninput="document.getElementById('val_multiBridgeMaxRate').innerText = this.value + ' /s'; renderMultiSyncPreview();">
                        <span id="val_multiBridgeMaxRate" class="slider-val">${cfg.bridgeMaxCommandsPerSecond ?? 30} /s</span>
                    </div>
                    <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Globale Grenze einschließlich Cluster, Effekte und Wiederholungen.</div>
                </td>
            </tr>
        `;

        groups.forEach(group => {
            const id = group.id;
            const label = `Gruppe ${id.toUpperCase()}`;
            html += `
                <tr>
                    <td colspan="2">
                        <details style="border:1px solid var(--border); border-radius:6px; padding:10px; background:#fafafa;" ${id === 'a' ? 'open' : ''}>
                            <summary style="cursor:pointer; font-weight:bold;">${escapeHtml(group.name || label)}</summary>
                            <table class="settings-table" style="margin-top:10px;">
                                <tr><td>${infoLabel('Name', 'Freier Anzeigename der Multi-Sync-Gruppe. Der Name kann auch als Effektziel verwendet werden, wenn kein gleichnamiges Loxone-Mapping existiert.')}</td><td><input id="sys_multiName_${id}" value="${escapeHtml(group.name || label)}" oninput="renderMultiSyncPreview('${id}')"></td></tr>
                                <tr><td>${infoLabel('Sammelfenster', 'Zeitfenster, in dem schnell eintreffende Loxone-Befehle gesammelt werden. Höher = stabiler bei Szenen, aber etwas späterer Start.')}</td><td><div class="slider-container"><input type="range" id="sys_multiSyncWindowMs_${id}" min="50" max="500" step="10" value="${group.syncWindowMs ?? 120}" oninput="document.getElementById('val_multiSyncWindow_${id}').innerText = this.value + ' ms'; renderMultiSyncPreview('${id}');"><span id="val_multiSyncWindow_${id}" class="slider-val">${group.syncWindowMs ?? 120} ms</span></div></td></tr>
                                <tr><td>${infoLabel('Batchgröße', 'Anzahl Lampen, nach denen eine zusätzliche Batch-Pause eingeplant wird. Bei 10 Lampen und Batchgröße 10 gibt es praktisch keinen Zwischenstopp.')}</td><td><input type="number" id="sys_multiBatchSize_${id}" min="1" max="20" step="1" value="${group.batchSize ?? 4}" oninput="renderMultiSyncPreview('${id}')"></td></tr>
                                <tr><td>${infoLabel('Batch-Pause', 'Zusätzliche Pause nach jedem Batch. Hilft nur, wenn die Batchgröße kleiner ist als die Lampenanzahl. Bei Batchgröße 10 und 10 Lampen meist 0 ms sinnvoll.')}</td><td><div class="slider-container"><input type="range" id="sys_multiBatchDelayMs_${id}" min="0" max="300" step="10" value="${group.batchDelayMs ?? 30}" oninput="document.getElementById('val_multiBatchDelay_${id}').innerText = this.value + ' ms'; renderMultiSyncPreview('${id}');"><span id="val_multiBatchDelay_${id}" class="slider-val">${group.batchDelayMs ?? 30} ms</span></div></td></tr>
                                <tr><td>${infoLabel('Max. Lichtbefehle/s', 'Bestimmt den Abstand zwischen verschiedenen Clustern dieser Gruppe. Im Cluster gilt dessen Abstand. Die globale Grenze begrenzt beide; zunächst 10/s testen.')}</td><td><div class="slider-container"><input type="range" id="sys_multiMaxCommandsPerSecond_${id}" min="1" max="50" step="1" value="${group.maxCommandsPerSecond ?? 10}" oninput="document.getElementById('val_multiMaxRate_${id}').innerText = this.value + ' /s'; renderMultiSyncPreview('${id}');"><span id="val_multiMaxRate_${id}" class="slider-val">${group.maxCommandsPerSecond ?? 10} /s</span></div></td></tr>
                                <tr><td>${infoLabel('Abstand im Ablauf-Cluster', 'Sollabstand innerhalb eines Clusters. Die globale Bridge-Grenze hat Vorrang: Bei 20/s sind auch mit Sollwert 5 ms mindestens 50 ms nötig.')}</td><td><div class="slider-container"><input type="range" id="sys_multiSameClusterSpacingMs_${id}" min="0" max="50" step="1" value="${group.sameClusterSpacingMs ?? 10}" oninput="document.getElementById('val_multiSameClusterSpacing_${id}').innerText = this.value + ' ms'; renderMultiSyncPreview('${id}');"><span id="val_multiSameClusterSpacing_${id}" class="slider-val">${group.sameClusterSpacingMs ?? 10} ms</span></div></td></tr>
                                <tr><td>${infoLabel('Timing-Test', 'Rechnerischer Plan einschließlich globaler Grenze. Keine Live-Messung: spätere Eingänge, Warteschlangen, Bridge-Antwortzeiten und Retries können den Ablauf verlängern.')}</td><td><div id="multiSyncPreview_${id}" style="font-size:0.8rem; color:var(--text-main); background:#f8f9fa; border:1px solid var(--border); border-radius:6px; padding:10px;"></div></td></tr>
                            </table>
                        </details>
                    </td>
                </tr>
            `;
        });

        return html;
    }

    function renderSecurityRows(security) {
        const s = security || securitySettings;
        return `
            <tr><td colspan="2" style="background:#eee;font-weight:bold">Sicherheit / Zugriffsschutz</td></tr>
            <tr>
                <td>${infoLabel('Dashboard/API schützen', 'Schützt Webinterface und API mit Basic Auth. Loxone-Steuer-URLs bleiben bewusst frei, damit bestehende virtuelle Ausgänge weiter funktionieren.')}</td>
                <td>
                    <label style="display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" id="sys_authEnabled" ${s.authEnabled ? 'checked' : ''}>
                        Dashboard/API mit Passwort schützen
                    </label>
                </td>
            </tr>
            <tr><td>${infoLabel('Benutzername', 'Benutzername für den Browser-Login. Standard ist admin.')}</td><td><input id="sys_authUser" value="${escapeHtml(s.authUser || 'admin')}"></td></tr>
            <tr><td>${infoLabel('Neues Passwort', 'Leer lassen, wenn das bestehende Passwort beibehalten werden soll. Beim ersten Aktivieren ist ein Passwort erforderlich.')}</td><td><input type="password" id="sys_authPassword" autocomplete="new-password" placeholder="${s.passwordConfigured ? 'Passwort unverändert lassen' : 'Passwort setzen'}"></td></tr>
            <tr><td>${infoLabel('Passwort wiederholen', 'Muss mit dem neuen Passwort übereinstimmen.')}</td><td><input type="password" id="sys_authPasswordRepeat" autocomplete="new-password"></td></tr>
            <tr>
                <td></td>
                <td>
                    <button class="add-btn" style="width:auto; margin:0;" onclick="saveSecuritySettings()">Zugriffsschutz speichern</button>
                    <div id="securityStatusHint" style="font-size:0.75em; color:var(--text-muted); margin-top:6px;">
                        ${s.passwordConfigured ? 'Passwort ist gesetzt.' : 'Noch kein Passwort gesetzt.'}
                    </div>
                </td>
            </tr>
        `;
    }

    async function saveSecuritySettings() {
        const authEnabled = document.getElementById('sys_authEnabled').checked;
        const authUser = document.getElementById('sys_authUser').value.trim() || 'admin';
        const password = document.getElementById('sys_authPassword').value;
        const repeat = document.getElementById('sys_authPasswordRepeat').value;

        if (password !== repeat) {
            alert('Passwörter stimmen nicht überein.');
            return;
        }
        if (authEnabled && !securitySettings.passwordConfigured && !password) {
            alert('Bitte zuerst ein Passwort setzen.');
            return;
        }

        try {
        const result = await apiRequest('/api/security/settings', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ authEnabled, authUser, password })
        });

        securitySettings = {
            authEnabled: result.authEnabled,
            authUser: result.authUser,
            passwordConfigured: result.passwordConfigured
        };
        alert('Zugriffsschutz gespeichert. Beim nächsten Aufruf ist eine Anmeldung erforderlich.');
        loadSettings();
        } catch (error) { alert('Zugriffsschutz nicht gespeichert: ' + error.message); }
    }

    async function saveSettings() {
        const d = {};
        ['sys_loxIp', 'sys_loxPort', 'sys_mqttBroker', 'sys_mqttPort', 'sys_mqttUser', 'sys_mqttPass', 'sys_mqttPrefix'].forEach(id => d[id.replace('sys_','')] = document.getElementById(id).value);
        
        d.transitionTime = document.getElementById('sys_transition').value;
        d.throttleTime = document.getElementById('sys_throttle').value;
        d.eventStreamWatchdogTimeoutSeconds = document.getElementById('sys_eventStreamWatchdogTimeoutSeconds').value;
        d.multiBridgeMaxCommandsPerSecond = getBridgeMaxCommandsPerSecondFromForm();
        d.multiGroups = MULTI_SYNC_GROUP_IDS.map(id => getMultiSyncFormSettings(id));

        d.debug = document.getElementById('sys_debug').checked;
        d.mqttEnabled = document.getElementById('sys_mqttEnabled').checked;
        d.mqttPassClear = document.getElementById('sys_mqttPassClear')?.checked === true;
        d.disableLogDisk = document.getElementById('sys_disableLogDisk').checked;

        try {
            await apiRequest('/api/setup/loxone', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
                loxoneIp: d.loxIp, loxonePort: d.loxPort, debug: d.debug,
                transitionTime: d.transitionTime, throttleTime: d.throttleTime, eventStreamWatchdogTimeoutSeconds: d.eventStreamWatchdogTimeoutSeconds,
                mqttEnabled: d.mqttEnabled, mqttBroker: d.mqttBroker, mqttPort: d.mqttPort, mqttUser: d.mqttUser, mqttPass: d.mqttPass, mqttPassClear: d.mqttPassClear, mqttPrefix: d.mqttPrefix,
                disableLogDisk: d.disableLogDisk,
                multiLightControl: {
                    bridgeMaxCommandsPerSecond: d.multiBridgeMaxCommandsPerSecond,
                    groups: d.multiGroups
                }
            })});
            alert("Gespeichert!");
            loadSettings();
        } catch(e) { alert('Speichern fehlgeschlagen: ' + e.message); }
    }

    async function loadSettings() {
        try {
            const [s, security] = await Promise.all([
                apiRequest('/api/settings'),
                apiRequest('/api/security/status')
            ]);
            securitySettings = security;
            multiLightControlSettings = s.multiLightControl || multiLightControlSettings;
            const table = document.getElementById('settingsTable');
            const v = (val) => val !== undefined ? val : '';
            
            table.innerHTML = `
                <tr><td colspan="2" style="background:#eee;font-weight:bold">Allgemein</td></tr>
                <tr><td>Version</td><td><span class="badge" style="background:#333;color:#fff">${s.version}</span></td></tr>
                <tr><td>${infoLabel('Loxone IP', 'IP-Adresse des Loxone Miniservers für UDP-Rückmeldungen von Hue Statusänderungen.')}</td><td><input id="sys_loxIp" value="${v(s.loxone_ip)}"></td></tr>
                <tr><td>${infoLabel('UDP Port', 'UDP-Port am Loxone Miniserver, auf den Statusmeldungen gesendet werden. Muss zur virtuellen UDP-Eingangskonfiguration passen.')}</td><td><input type="number" id="sys_loxPort" value="${v(s.loxone_port)}"></td></tr>
                
                <tr>
                    <td>${infoLabel('Übergangszeit', 'Hue Dynamics Dauer für weiche Übergänge. Höher wirkt sanfter, aber träger. Für schnelle Szenen eher 0-100 ms testen.')}</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_transition" min="0" max="1000" step="50" value="${v(s.transitionTime)}" oninput="document.getElementById('val_trans').innerText = this.value + ' ms'">
                            <span id="val_trans" class="slider-val">${v(s.transitionTime)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>${infoLabel('Drosselung', 'Pause der normalen Hue-Queue außerhalb Multi-Sync. Höher reduziert Last, betrifft normale Einzel- und Gruppenbefehle.')}</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_throttle" min="0" max="1000" step="50" value="${v(s.throttleTime)}" oninput="document.getElementById('val_thro').innerText = this.value + ' ms'">
                            <span id="val_thro" class="slider-val">${v(s.throttleTime)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>${infoLabel('EventStream Watchdog', 'Startet den Hue EventStream neu, wenn längere Zeit keine Daten kommen. 10 min ist Standard; niedriger nur bei echten Aussetzern.')}</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_eventStreamWatchdogTimeoutSeconds" min="60" max="3600" step="60" value="${v(s.eventStreamWatchdogTimeoutSeconds ?? 600)}" oninput="document.getElementById('val_eventWatchdog').innerText = Math.round(this.value / 60) + ' min'">
                            <span id="val_eventWatchdog" class="slider-val">${Math.round((s.eventStreamWatchdogTimeoutSeconds ?? 600) / 60)} min</span>
                        </div>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Neustart des Hue EventStreams nach Ruhezeit ohne Daten. Standard: 10 min; niedriger nur bei echten Aussetzern.</div>
                    </td>
                </tr>

                <tr><td colspan="2" style="background:#eee;font-weight:bold">Mehrlampensynchronisierung</td></tr>
                ${renderMultiSyncGroupRows(s.multiLightControl)}
                <!-- legacy single-group controls disabled by grouped scheduler
                <tr>
                    <td>Sammelfenster</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_multiSyncWindowMs" min="50" max="500" step="10" value="${v(s.multiLightControl?.syncWindowMs ?? 120)}" oninput="document.getElementById('val_multiSyncWindow').innerText = this.value + ' ms'; renderMultiSyncPreview();">
                            <span id="val_multiSyncWindow" class="slider-val">${v(s.multiLightControl?.syncWindowMs ?? 120)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>Batchgröße</td>
                    <td><input type="number" id="sys_multiBatchSize" min="1" max="20" step="1" value="${v(s.multiLightControl?.batchSize ?? 4)}" oninput="renderMultiSyncPreview()"></td>
                </tr>
                <tr>
                    <td>Batch-Pause</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_multiBatchDelayMs" min="0" max="300" step="10" value="${v(s.multiLightControl?.batchDelayMs ?? 30)}" oninput="document.getElementById('val_multiBatchDelay').innerText = this.value + ' ms'; renderMultiSyncPreview();">
                            <span id="val_multiBatchDelay" class="slider-val">${v(s.multiLightControl?.batchDelayMs ?? 30)} ms</span>
                        </div>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Gilt nur für Lampen mit aktivierter Mehrlampensynchronisierung.</div>
                    </td>
                </tr>
                <tr>
                    <td>Max. Lichtbefehle/s</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_multiMaxCommandsPerSecond" min="1" max="50" step="1" value="${v(s.multiLightControl?.maxCommandsPerSecond ?? 10)}" oninput="document.getElementById('val_multiMaxRate').innerText = this.value + ' /s'; renderMultiSyncPreview();">
                            <span id="val_multiMaxRate" class="slider-val">${v(s.multiLightControl?.maxCommandsPerSecond ?? 10)} /s</span>
                        </div>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">10/s entspricht der Hue-Empfehlung. Höhere Werte vorsichtig je Lampenmenge testen.</div>
                    </td>
                </tr>
                <tr>
                    <td>Timing-Test</td>
                    <td>
                        <div id="multiSyncPreview" style="font-size:0.8rem; color:var(--text-main); background:#f8f9fa; border:1px solid var(--border); border-radius:6px; padding:10px;"></div>
                    </td>
                </tr>
                -->

                <tr><td>${infoLabel('Debug Modus', 'Schreibt detaillierte IN/OUT/Event-Logs. Hilfreich zum Testen, im Dauerbetrieb bei vielen Befehlen eher deaktivieren.')}</td><td><input type="checkbox" id="sys_debug" ${s.debug?'checked':''}></td></tr>
                <tr>
                    <td>${infoLabel('SD-Card Mode', 'Deaktiviert Schreibzugriffe auf logs.db und hält Logs nur im RAM. Sinnvoll auf SD-Karten-Systemen.')}</td>
                    <td>
                        <input type="checkbox" id="sys_disableLogDisk" ${s.disableLogDisk?'checked':''}>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Deaktiviert Schreibzugriffe auf logs.db.</div>
                    </td>
                </tr>

                ${renderSecurityRows(securitySettings)}

                <tr><td colspan="2" style="background:#eee;font-weight:bold">MQTT</td></tr>
                <tr><td>${infoLabel('Aktivieren', 'Aktiviert parallele Statusausgabe an einen MQTT Broker.')}</td><td><input type="checkbox" id="sys_mqttEnabled" ${s.mqttEnabled?'checked':''}></td></tr>
                <tr><td>${infoLabel('Broker IP', 'Adresse des MQTT Brokers, z. B. Mosquitto oder Home Assistant MQTT.')}</td><td><input id="sys_mqttBroker" value="${v(s.mqttBroker)}"></td></tr>
                <tr><td>${infoLabel('Port', 'MQTT-Port. Standard ist 1883 ohne TLS.')}</td><td><input type="number" id="sys_mqttPort" value="${v(s.mqttPort)||1883}"></td></tr>
                <tr><td>${infoLabel('User', 'Optionaler MQTT Benutzername.')}</td><td><input id="sys_mqttUser" value="${v(s.mqttUser)}"></td></tr>
                <tr><td>${infoLabel('Passwort', 'Optionales MQTT Passwort. Leer lassen, um ein bereits gesetztes Passwort beizubehalten.')}</td><td><input type="password" id="sys_mqttPass" value="" placeholder="${s.mqttPassSet ? 'Passwort unverändert lassen' : ''}"></td></tr>
                <tr style="${s.mqttPassSet ? '' : 'display:none'}"><td>${infoLabel('Passwort löschen', 'Entfernt das gespeicherte MQTT Passwort beim Speichern.')}</td><td><label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" id="sys_mqttPassClear"> MQTT Passwort löschen</label></td></tr>
                <tr><td>${infoLabel('Prefix', 'Topic-Prefix für MQTT Statusmeldungen, z. B. loxhue/light/wohnzimmer/on.')}</td><td><input id="sys_mqttPrefix" value="${v(s.mqttPrefix)||'loxhue'}"></td></tr>
            `;
            renderMultiSyncPreview();
        } catch(e){ console.error("Fehler bei loadSettings:", e); }
    }

    function createDetailsDraft(entry) {
        const offset = normalizeSyncOffset(entry.sync_offset_ms, 0);
        return {
            loxoneName: entry.loxone_name,
            original: {
                sync_lox: entry.sync_lox === true,
                ignore_dynamics: entry.ignore_dynamics === true,
                multi_sync: entry.multi_sync === true,
                multi_sync_group: normalizeMultiSyncGroup(entry.multi_sync_group),
                sync_cluster: normalizeSyncCluster(entry.sync_cluster),
                sync_offset_ms: offset,
                verify_state: entry.verify_state === true,
                split_on: entry.split_on === true,
                repeat_command: entry.repeat_command === true
            },
            values: {
                sync_lox: entry.sync_lox === true,
                ignore_dynamics: entry.ignore_dynamics === true,
                multi_sync: entry.multi_sync === true,
                multi_sync_group: normalizeMultiSyncGroup(entry.multi_sync_group),
                sync_cluster: normalizeSyncCluster(entry.sync_cluster),
                sync_offset_ms: offset,
                verify_state: entry.verify_state === true,
                split_on: entry.split_on === true,
                repeat_command: entry.repeat_command === true
            }
        };
    }

    function getReliabilityMode(values) {
        if (values.verify_state) return 'verify_state';
        if (values.split_on) return 'split_on';
        if (values.repeat_command) return 'repeat_command';
        return 'none';
    }

    function normalizeMultiSyncGroup(value) {
        const group = String(value || 'a').toLowerCase();
        return MULTI_SYNC_GROUP_IDS.includes(group) ? group : 'a';
    }

    function normalizeSyncCluster(value) {
        return String(value || '').trim().substring(0, 40);
    }

    function normalizeSyncOffset(value, fallback = null) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        const rounded = Math.round(number / 10) * 10;
        return Math.max(-500, Math.min(1000, rounded));
    }

    function describeSyncOffset(offset) {
        if (offset < 0) return `Diese Lampe wird ${Math.abs(offset)} ms früher gesendet.`;
        if (offset > 0) return `Diese Lampe wird ${offset} ms später gesendet.`;
        return 'Diese Lampe wird ohne zusätzlichen Offset gesendet.';
    }

    function updateDetailsDraft(key, value) {
        if (!detailsDraft) return;
        if (key === 'sync_offset_ms') {
            const offset = normalizeSyncOffset(value, null);
            const statusEl = document.getElementById('detailsSaveStatus');
            if (offset === null) {
                if (statusEl) statusEl.textContent = 'Sync-Offset ist ungültig.';
                return;
            }
            detailsDraft.values.sync_offset_ms = offset;
            const input = document.getElementById('details_syncOffset');
            if (input) input.value = offset;
            const effect = document.getElementById('details_syncOffsetEffect');
            if (effect) effect.textContent = describeSyncOffset(offset);
            if (statusEl) statusEl.textContent = '';
            return;
        }
        if (key === 'multi_sync_group') {
            detailsDraft.values.multi_sync_group = normalizeMultiSyncGroup(value);
            return;
        }
        if (key === 'sync_cluster') {
            detailsDraft.values.sync_cluster = normalizeSyncCluster(value);
            return;
        }
        if (key === 'reliability_mode') {
            detailsDraft.values.verify_state = value === 'verify_state';
            detailsDraft.values.split_on = value === 'split_on';
            detailsDraft.values.repeat_command = value === 'repeat_command';
            return;
        }
        detailsDraft.values[key] = value === true;
    }

    function adjustSyncOffset(delta) {
        if (!detailsDraft) return;
        updateDetailsDraft('sync_offset_ms', detailsDraft.values.sync_offset_ms + delta);
    }

    function setSyncOffset(value) {
        updateDetailsDraft('sync_offset_ms', value);
    }

    function detailsDraftChanged() {
        if (!detailsDraft) return false;
        return JSON.stringify(detailsDraft.original) !== JSON.stringify(detailsDraft.values);
    }

    function showToast(message) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2600);
    }

    async function saveDetailsSettings() {
        if (!detailsDraft) return closeModal('detailsModal');
        const statusEl = document.getElementById('detailsSaveStatus');
        const offset = normalizeSyncOffset(detailsDraft.values.sync_offset_ms, null);
        if (offset === null) {
            if (statusEl) statusEl.textContent = 'Sync-Offset ist ungültig.';
            return;
        }

        const body = { ...detailsDraft.values, sync_offset_ms: offset };
        if (statusEl) statusEl.textContent = 'Speichere...';

        try {
            const payload = await apiRequest(`/api/mapping/${encodeURIComponent(detailsDraft.loxoneName)}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const index = mappings.findIndex(m => m.loxone_name === detailsDraft.loxoneName);
            if (index >= 0) mappings[index] = payload.mapping;
            renderMappings();
            if (currentTab === 'system') renderMultiSyncPreview();
            detailsDraft = null;
            closeModal('detailsModal');
            showToast('Einstellungen gespeichert');
        } catch (error) {
            if (statusEl) statusEl.textContent = error.message;
        }
    }

    function closeDetailsModal() {
        if (detailsDraftChanged() && !confirm('Änderungen verwerfen?')) return;
        detailsDraft = null;
        closeModal('detailsModal');
    }

    function showDetails(uuid, loxoneName) {
        const target = targets.find(t => t.uuid === uuid);
        const entry = mappings.find(m => m.loxone_name === loxoneName);
        const currentStatus = status[loxoneName] || {};
        if(!target || !entry) return;
        detailsDraft = createDetailsDraft(entry);
        const safeHex = safeHexColor(currentStatus.hex);

        let content = `<div style="margin-bottom:20px;">`;

        // 1. SETTINGS (nur für Lichter/Gruppen)
        if (entry.hue_type === 'light' || entry.hue_type === 'group') {
            const caps = target.capabilities || {};
            const supportsDimming = entry.hue_type === 'group' ? true : !!caps.supportsDimming; 
            
            const isStrictOnOff = entry.hue_type === 'light' && !supportsDimming;
            if (isStrictOnOff) {
                detailsDraft.original.ignore_dynamics = true;
                detailsDraft.values.ignore_dynamics = true;
            }
            const ignoreDyn = isStrictOnOff ? true : detailsDraft.values.ignore_dynamics;
            const disableIgnoreDyn = isStrictOnOff ? 'disabled' : '';
            const groupOptions = (multiLightControlSettings.groups || MULTI_SYNC_GROUP_IDS.map(id => ({ id, name: `Gruppe ${id.toUpperCase()}` })))
                .map(group => `<option value="${group.id}" ${detailsDraft.values.multi_sync_group === group.id ? 'selected' : ''}>${escapeHtml(group.name || `Gruppe ${group.id.toUpperCase()}`)}</option>`)
                .join('');
            const clusterOptions = Array.from(new Set(
                mappings
                    .filter(m => m.hue_type === 'light' && normalizeMultiSyncGroup(m.multi_sync_group) === detailsDraft.values.multi_sync_group)
                    .map(m => normalizeSyncCluster(m.sync_cluster))
                    .filter(Boolean)
            )).sort((a, b) => a.localeCompare(b));
            const clusterOptionsHtml = clusterOptions
                .map(cluster => `<option value="${escapeHtml(cluster)}"></option>`)
                .join('');

            content += `
                <h3 style="margin-top:0; font-size:1rem; color:var(--text-main);">⚙️ Einstellungen</h3>
                
                <div class="settings-card">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" ${detailsDraft.values.sync_lox ? 'checked' : ''} onchange="updateDetailsDraft('sync_lox', this.checked)"> 
                        <span style="font-weight:500;">Loxone Sync</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">Sendet Statusänderungen per UDP an Loxone zurück.</div>
                </div>

                <div class="settings-card" style="opacity: ${isStrictOnOff ? '0.6' : '1'};">
                    <label style="display:flex; align-items:center; gap:10px; cursor:${isStrictOnOff ? 'not-allowed' : 'pointer'};">
                        <input type="checkbox" ${ignoreDyn ? 'checked' : ''} ${disableIgnoreDyn} onchange="updateDetailsDraft('ignore_dynamics', this.checked)"> 
                        <span style="font-weight:500;">Dynamics ignorieren</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">
                        ${isStrictOnOff ? 'Dieses Gerät ist ein reiner On/Off Schalter und unterstützt kein Dimmen. Parameter ist erzwungen aktiv.' : 'Deaktiviert weiche Übergangszeiten (Transition) beim Schalten für dieses Gerät.'}
                    </div>
                </div>

                <div class="settings-card" style="display:${entry.hue_type === 'light' ? 'block' : 'none'};">
                    <div style="font-weight:500; margin-bottom:6px;">Bei unzuverlässiger Übertragung</div>
                    <select onchange="updateDetailsDraft('reliability_mode', this.value)" style="width:100%; padding:8px;">
                        <option value="none" ${getReliabilityMode(detailsDraft.values) === 'none' ? 'selected' : ''}>Keine - Befehl einmal senden</option>
                        <option value="verify_state" ${getReliabilityMode(detailsDraft.values) === 'verify_state' ? 'selected' : ''}>Zustand nachlesen und korrigieren (empfohlen)</option>
                        <option value="split_on" ${getReliabilityMode(detailsDraft.values) === 'split_on' ? 'selected' : ''}>Einschalten aufteilen</option>
                        <option value="repeat_command" ${getReliabilityMode(detailsDraft.values) === 'repeat_command' ? 'selected' : ''}>Befehl wiederholen</option>
                    </select>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:6px;">
                        Für einzelne Lampen mit Funkproblemen. Nachlesen prüft später on/Helligkeit und sendet nur bei Abweichung erneut. Aufteilen sendet erst on=true und kurz danach Helligkeit/Farbe. Wiederholen sendet denselben Befehl einmal erneut.
                    </div>
                </div>
                
                <div class="settings-card" style="display:${entry.hue_type === 'light' ? 'block' : 'none'};">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" ${detailsDraft.values.multi_sync === true ? 'checked' : ''} onchange="updateDetailsDraft('multi_sync', this.checked)"> 
                        <span style="font-weight:500;">Mehrlampensynchronisierung</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">
                        Nimmt diese Lampe in den gemeinsamen Sammel-/Batch-Ablauf auf. Nur einzelne Hue-Lampen werden hier synchronisiert, keine Gruppen.
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-left:24px; margin-top:10px;">
                        <span style="font-size:0.85rem; color:var(--text-muted); min-width:90px;">Gruppe</span>
                        <select onchange="updateDetailsDraft('multi_sync_group', this.value)" style="max-width:180px;">
                            ${groupOptions}
                        </select>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-left:24px; margin-top:10px; flex-wrap:wrap;">
                        <span style="font-size:0.85rem; color:var(--text-muted); min-width:90px;">Ablauf-Cluster</span>
                        <input id="details_syncCluster" list="details_syncClusterOptions" maxlength="40" value="${escapeHtml(detailsDraft.values.sync_cluster)}" oninput="updateDetailsDraft('sync_cluster', this.value)" placeholder="z. B. Deckenlampe" style="max-width:180px;">
                        <datalist id="details_syncClusterOptions">${clusterOptionsHtml}</datalist>
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-left:24px; margin-top:4px;">
                        Lampen mit gleichem Ablauf-Cluster werden im Zeitplan eng nacheinander gesendet.
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-left:24px; margin-top:10px; flex-wrap:wrap;">
                        <span style="font-size:0.85rem; color:var(--text-muted); min-width:90px;">Sync-Offset</span>
                        <input id="details_syncOffset" type="number" min="-500" max="1000" step="10" value="${escapeHtml(detailsDraft.values.sync_offset_ms)}" oninput="updateDetailsDraft('sync_offset_ms', this.value)" style="max-width:120px;">
                        <span style="font-size:0.85rem; color:var(--text-muted);">ms</span>
                    </div>
                    <div class="offset-controls">
                        <button type="button" class="offset-btn" onclick="adjustSyncOffset(-50)">-50</button>
                        <button type="button" class="offset-btn" onclick="adjustSyncOffset(-10)">-10</button>
                        <button type="button" class="offset-btn" onclick="setSyncOffset(0)">0</button>
                        <button type="button" class="offset-btn" onclick="adjustSyncOffset(10)">+10</button>
                        <button type="button" class="offset-btn" onclick="adjustSyncOffset(50)">+50</button>
                    </div>
                    <div class="offset-hint">Negativ = früher senden, positiv = später senden. Bereich: -500 bis +1000 ms, in 10-ms-Schritten.</div>
                    <div id="details_syncOffsetEffect" class="offset-effect">${escapeHtml(describeSyncOffset(detailsDraft.values.sync_offset_ms))}</div>
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
            if (currentStatus.hex) content += `<tr><td>Farbe</td><td><span class="color-dot" style="background-color:${safeHex}"></span> <span style="font-family:monospace">${escapeHtml(safeHex)}</span></td></tr>`;
        }

        // Sensor Stats
        if (currentStatus.bat !== undefined) content += `<tr><td>Batterie</td><td>${currentStatus.bat} %</td></tr>`;
        if (currentStatus.temp !== undefined) content += `<tr><td>Temperatur</td><td>${currentStatus.temp} °C</td></tr>`;
        if (currentStatus.lux !== undefined) content += `<tr><td>Helligkeit</td><td>${currentStatus.lux} lx</td></tr>`;
        if (currentStatus.contact !== undefined) content += `<tr><td>Kontakt</td><td>${currentStatus.contact === 1 ? '🔓 Offen' : '🔒 Geschlossen'}</td></tr>`;
        if (currentStatus.motion !== undefined) content += `<tr><td>Bewegung</td><td>${currentStatus.motion === 1 ? '🏃 Ja' : '🧘 Nein'}</td></tr>`;

        content += `<tr><td colspan="2" style="border-bottom:none; padding-top:20px; color:var(--text-muted); font-weight:bold;">📋 Technische Daten</td></tr>`;
        content += `<tr><td>Name</td><td>${escapeHtml(target.name)}</td></tr>`;
        content += `<tr><td>Loxone ID</td><td>${escapeHtml(loxoneName)}</td></tr>`;
        content += `<tr><td>Typ</td><td><span class="badge" style="background:#eee;color:#333">${escapeHtml(entry.hue_type)}</span></td></tr>`;
        content += `<tr><td>UUID</td><td style="font-size:0.8em; font-family:monospace">${escapeHtml(target.uuid)}</td></tr>`;
        content += `</table></div>`;

        const statusEl = document.getElementById('detailsSaveStatus');
        if (statusEl) statusEl.textContent = '';
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
    
    async function restartServer() {
        if (!confirm('Neustart?')) return;
        try { await apiRequest('/api/system/restart', {method:'POST'}); }
        catch (error) { alert('Neustart fehlgeschlagen: ' + error.message); }
    }
    function downloadLog() { window.location.href = '/api/system/logdownload'; }
    function downloadBackup() { window.location.href = '/api/system/backup'; }
    function downloadBackupRedacted() { window.location.href = '/api/system/backup?redactSecrets=true'; }
    function triggerRestore() { document.getElementById('restoreInput').click(); }
    async function restoreBackup(input) {
        if(!input.files.length) return;
        const file = input.files[0];
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const json = JSON.parse(e.target.result);
                await apiRequest('/api/system/restore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(json)});
                alert("Wiederhergestellt! Neustart...");
                setTimeout(() => location.reload(), 3000);
            } catch(err) { alert("Fehler: " + err.message); }
        };
        reader.onerror = () => alert('Backup-Datei konnte nicht gelesen werden.');
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
            item.innerHTML = `<input type="checkbox" class="modal-checkbox" value="${escapeHtml(m.loxone_name)}"><div><div style="font-weight:bold">${escapeHtml(m.loxone_name)}</div></div>`;
            list.appendChild(item);
        });
    }

    init();
