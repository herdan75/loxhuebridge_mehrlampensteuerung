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

    // --- Hilfsfunktion fÃ¼r einheitliche Batteriewarnungen ---
    function getBatteryHTML(bat) {
        if (bat === undefined || bat === null) return { badge: '', textStyle: '' };
        
        let color = '';
        let badgeStyle = '';
        let textStyle = '';
        let icon = 'ðŸ”‹';

        if (bat <= 10) {
            color = 'red';
            badgeStyle = 'background:#ffcdcd; color:red; font-weight:bold;';
            textStyle = 'color:red; font-weight:bold;';
            icon = 'ðŸª«';
        } else if (bat <= 20) {
            color = 'orange';
            badgeStyle = 'background:#fff3e0; color:orange; font-weight:bold;';
            textStyle = 'color:orange; font-weight:bold;';
            icon = 'ðŸ”‹';
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
            'light':  { icon: 'ðŸ’¡', label: 'Licht', order: 1 },
            'group':  { icon: 'ðŸ“¦', label: 'Gruppe', order: 2 },
            'sensor': { icon: 'ðŸ“¡', label: 'Sensor', order: 3 },
            'button': { icon: 'ðŸ”˜', label: 'Schalter', order: 4 }
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
        let html = '<h3 style="margin-top:0; border-bottom: 1px solid var(--border); padding-bottom: 8px;">ðŸ“‹ GerÃ¤te & Batterien</h3>';
        html += '<table class="settings-table"><thead><tr><th>Name</th><th>Typ</th><th>Batterie</th><th>Letzter Wert</th></tr></thead><tbody>';
        
        sorted.forEach(m => {
            const st = status[m.loxone_name] || {};
            const { badge, textStyle } = getBatteryHTML(st.bat);

            let lastVal = '';
            if (st.on !== undefined) lastVal += `On:${st.on} `;
            if (st.bri !== undefined) lastVal += `Bri:${Math.round(st.bri)} `;
            if (st.motion !== undefined) lastVal += `Mot:${st.motion} `;
            if (st.contact !== undefined) lastVal += `Con:${st.contact} `;
            if (st.temp !== undefined) lastVal += `${st.temp}Â°C `;
            const tConf = typeConfig[m.hue_type] || {icon:'â“', label: m.hue_type};
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
            if (!bridgeRes.ok) throw new Error('Bridge API nicht verfÃ¼gbar');
            const diagData = await bridgeRes.json();
            if (!diagData) throw new Error('Keine Daten');

            // Zigbee Bridge-Info
            let bridgeHtml = '<h3 style="margin-top: 30px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">ðŸŒ Bridge & Zigbee Netzwerk</h3>';
            if (diagData.zigbee?.bridge) {
                const b = diagData.zigbee.bridge;
                bridgeHtml += `<table class="settings-table"><tbody>`;
                if (b.bridge_id)    bridgeHtml += `<tr><td>Bridge ID</td><td style="font-family:monospace">${b.bridge_id}</td></tr>`;
                if (b.time_zone?.time_zone) bridgeHtml += `<tr><td>Zeitzone</td><td>${b.time_zone.time_zone}</td></tr>`;
                bridgeHtml += `</tbody></table>`;
            }

            // Zigbee KonnektivitÃ¤t pro GerÃ¤t
            if (diagData.zigbee?.connectivity?.length > 0) {
                bridgeHtml += `<table class="settings-table" style="margin-top:10px"><thead><tr><th>GerÃ¤t</th><th>Zigbee Status</th><th>UUID</th></tr></thead><tbody>`;
                diagData.zigbee.connectivity.forEach(c => {
                    const status_val = c.status || '?';
                    let statusColor = '#888';
                    if (status_val === 'connected') statusColor = 'var(--success,#4caf50)';
                    else if (status_val === 'connectivity_issue') statusColor = 'red';
                    else if (status_val === 'unidirectional_incoming') statusColor = 'orange';
                    const devName = diagData.serviceToDeviceMap?.[c.id]?.deviceName || 'â€“';
                    bridgeHtml += `<tr>
                        <td style="font-weight:bold">${escapeHtml(devName)}</td>
                        <td><span style="color:${statusColor}; font-weight:bold">â— ${status_val}</span></td>
                        <td style="font-size:0.75em;color:#888;font-family:monospace">${escapeHtml(c.id)}</td>
                    </tr>`;
                });
                bridgeHtml += `</tbody></table>`;
            }

            // Lampen-Capabilities
            let capsHtml = '<h3 style="margin-top: 30px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">ðŸŽ­ Lampen-FÃ¤higkeiten & Effekte</h3>';
            const lightMappings = mappings.filter(m => m.hue_type === 'light' || m.hue_type === 'group');
            if (lightMappings.length > 0 && diagData.capabilities) {
                capsHtml += `<table class="settings-table"><thead><tr><th>Loxone Name</th><th>Dimm</th><th>Farbe</th><th>WeiÃŸ</th><th>Effekte (persistent)</th><th>Zeiteffekte</th></tr></thead><tbody>`;
                lightMappings.sort((a,b) => a.loxone_name.localeCompare(b.loxone_name)).forEach(m => {
                    const rawCaps = diagData.capabilities[m.hue_uuid] || {};
                    const caps = {
                        ...rawCaps,
                        supportedEffects: rawCaps.supportedEffects?.map(escapeHtml),
                        supportedTimedEffects: rawCaps.supportedTimedEffects?.map(escapeHtml)
                    };
                    const yes = '<span style="color:var(--success,#4caf50)">âœ…</span>';
                    const no  = '<span style="color:#ccc">âŒ</span>';
                    const effects = caps.supportedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#f0f0f0">${e}</span>`).join(' ') || '<span style="color:#ccc">â€“</span>';
                    const timedFx = caps.supportedTimedEffects?.filter(e => e !== 'no_effect').map(e =>
                        `<span class="badge" style="font-size:0.75em;background:#e8f5e9">${e}</span>`).join(' ') || '<span style="color:#ccc">â€“</span>';
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
            div.innerHTML += `<div style="color:var(--text-muted);margin-top:20px;text-align:center;">âš ï¸ Bridge-Diagnose nicht verfÃ¼gbar: ${e.message}</div>`;
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
                div.innerHTML = `<span>ðŸ“¥</span> /${escapeHtml(d.name)}`;
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
            consoleDiv.innerHTML = '<div style="text-align:center; color:#555; padding-top:20px;">Keine EintrÃ¤ge gefunden.</div>';
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
            appendGroup(`ðŸšª Kontakte (${contact.length})`, contact, 'var(--danger)');
            appendGroup(`ðŸƒ Bewegung (${motion.length})`, motion, 'var(--sensor)');
            appendGroup(`ðŸ“¡ Sonstige (${other.length})`, other, 'var(--text-muted)');
        } else if(currentTab === 'light') {
            const on = [], off = [];
            filtered.forEach(m => {
                const st = status[m.loxone_name] || {};
                (st.on === 1 || st.on === true ? on : off).push(m);
            });
            on.sort((a,b)=>a.loxone_name.localeCompare(b.loxone_name));
            off.sort((a,b)=>a.loxone_name.localeCompare(b.loxone_name));
            appendGroup(`ðŸ’¡ Ein (${on.length})`, on, 'var(--accent)');
            appendGroup(`ðŸŒ‘ Aus (${off.length})`, off, 'var(--text-muted)');
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

        if (has(st.motion)) badges += `<span class="badge" style="background:var(--border)">${st.motion ? 'ðŸƒ' : 'ðŸ§˜'}</span>`;
        if (has(st.temp)) badges += `<span class="badge">${escapeHtml(safeNumber(st.temp))}Â°C</span>`;
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
                <button class="del-btn" onclick="event.stopPropagation(); deleteMapping(${jsArg(m.loxone_name)})">âœ–</button>
            </div>
        `;
        return div;
    }

    async function loadTargets() { try { targets = await (await fetch('/api/targets')).json(); if(currentTab!=='system') renderDropdown(); } catch(e){ console.error("Fehler bei loadTargets:", e); } }
    async function loadMappings() { try { mappings = await (await fetch('/api/mapping')).json(); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadMappings:", e); } }
    async function loadStatus() { try { status = await (await fetch('/api/status')).json(); if(currentTab!=='system') renderMappings(); } catch(e){ console.error("Fehler bei loadStatus:", e); } }
    async function loadMultiSyncSettingsCache() {
        try {
            const s = await (await fetch('/api/settings')).json();
            multiLightControlSettings = s.multiLightControl || multiLightControlSettings;
        } catch(e) { console.error("Fehler bei loadMultiSyncSettingsCache:", e); }
    }
    
    function renderDropdown() {
        const select = document.getElementById('hueTarget');
        if(!select) return;
        select.innerHTML = '<option value="">-- WÃ¤hlen --</option>';

        // FÃ¼ge "Alle Lichter" als spezielle Option hinzu (nur im Lichter-Tab und wenn noch kein 'all'-Mapping existiert)
        if (currentTab === 'light' && !mappings.some(m => m.hue_uuid === 'pseudo-all' || m.loxone_name === 'all')) {
            const allOpt = document.createElement('option');
            allOpt.value = 'pseudo-all';
            allOpt.innerHTML = 'ðŸ  Alle Lichter (bridge_home)';
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

    async function addMapping() {
        const nameIn = document.getElementById('inName');
        const hueSel = document.getElementById('hueTarget');
        if(!nameIn.value || !hueSel.value) return alert("Fehlende Daten");
        mappings.push({
            loxone_name: nameIn.value.toLowerCase(),
            hue_uuid: hueSel.value,
            hue_name: hueSel.options[hueSel.selectedIndex].text,
            hue_type: hueSel.options[hueSel.selectedIndex].dataset.type,
            sync_lox: true,
            ignore_dynamics: false,
            multi_sync: false,
            sync_offset_ms: 0
        });
        await fetch('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(mappings)});
        nameIn.value=''; loadMappings(); loadTargets();
    }
    async function deleteMapping(name) {
        if(!confirm('LÃ¶schen?')) return;
        mappings = mappings.filter(m=>m.loxone_name !== name);
        await fetch('/api/mapping', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(mappings)});
        loadMappings(); loadTargets();
    }

    // --- NEU: DYNAMISCHES SPEICHERN FÃœR CHECKBOXEN IM MODAL ---
    async function updateMappingSetting(loxName, key, val) {
        const entry = mappings.find(m => m.loxone_name === loxName);
        if (entry) {
            entry[key] = val;
            await fetch('/api/mapping', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(mappings) });
            renderMappings();
        }
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
            maxCommandsPerSecond: Math.max(1, numberValue(`sys_multiMaxCommandsPerSecond_${groupId}`, 10))
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
                .filter(m => m.hue_type === 'light' && m.multi_sync === true && (m.multi_sync_group || 'a') === id)
                .map((entry, index) => {
                    const offset = Math.max(-500, Math.min(1000, Number(entry.sync_offset_ms) || 0));
                    const batchDelay = Math.floor(index / settings.batchSize) * settings.batchDelayMs;

                    return { entry, offset, batchDelay, index };
                });

            const activeLights = items.length;
            const commandSpacingMs = Math.ceil(1000 / settings.maxCommandsPerSecond);
            const baseDelayMs = activeLights ? Math.max(0, -Math.min(...items.map(item => item.offset))) : 0;
            let lastDelay = -commandSpacingMs;
            const delays = items
                .map(item => ({
                    requestedDelay: Math.max(0, Math.round(baseDelayMs + item.offset + (item.index * commandSpacingMs) + item.batchDelay))
                }))
                .sort((a, b) => a.requestedDelay - b.requestedDelay)
                .map(item => {
                    const delay = Math.max(item.requestedDelay, lastDelay + commandSpacingMs);
                    lastDelay = delay;
                    return delay;
                });

            const lastCommandMs = delays.length ? Math.max(...delays) : 0;
            const totalMs = settings.syncWindowMs + lastCommandMs;
            const effectiveRate = activeLights > 1 && lastCommandMs > 0
                ? ((activeLights - 1) / (lastCommandMs / 1000)).toFixed(1)
                : activeLights.toFixed(1);
            const hint = settings.maxCommandsPerSecond <= 10
                ? 'Hue-konservativ'
                : (settings.maxCommandsPerSecond <= 25 ? 'Schnell testen' : 'Experimentell');

            el.innerHTML = `
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap:8px;">
                    <div><b>${activeLights}</b><br><span>aktive Lampen</span></div>
                    <div><b>${commandSpacingMs} ms</b><br><span>Mindestabstand</span></div>
                    <div><b>${Math.round(totalMs)} ms</b><br><span>bis letzter Befehl</span></div>
                    <div><b>${effectiveRate}/s</b><br><span>effektiv</span></div>
                </div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;">
                    Modus: ${hint}. Globale Bridge-Grenze: ${getBridgeMaxCommandsPerSecondFromForm()}/s.
                </div>
            `;
        });
    }

    function renderMultiSyncGroupRows(settings) {
        const cfg = settings || {};
        const groups = cfg.groups || MULTI_SYNC_GROUP_IDS.map(id => ({ id, name: `Gruppe ${id.toUpperCase()}`, syncWindowMs: 120, batchSize: 4, batchDelayMs: 30, maxCommandsPerSecond: 10 }));
        let html = `
            <tr>
                <td>${infoLabel('Max. Bridge-Befehle/s', 'Globale Obergrenze fÃ¼r alle Hue-Befehle aus Multi-Sync-Gruppen. Senken, wenn HUE RATE LIMIT 429 erscheint oder mehrere Gruppen gleichzeitig schalten.')}</td>
                <td>
                    <div class="slider-container">
                        <input type="range" id="sys_multiBridgeMaxCommandsPerSecond" min="1" max="100" step="1" value="${cfg.bridgeMaxCommandsPerSecond ?? 30}" oninput="document.getElementById('val_multiBridgeMaxRate').innerText = this.value + ' /s'; renderMultiSyncPreview();">
                        <span id="val_multiBridgeMaxRate" class="slider-val">${cfg.bridgeMaxCommandsPerSecond ?? 30} /s</span>
                    </div>
                    <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Sicherheitsgrenze Ã¼ber alle Multi-Sync-Gruppen hinweg.</div>
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
                                <tr><td>${infoLabel('Sammelfenster', 'Zeitfenster, in dem schnell eintreffende Loxone-Befehle gesammelt werden. HÃ¶her = stabiler bei Szenen, aber etwas spÃ¤terer Start.')}</td><td><div class="slider-container"><input type="range" id="sys_multiSyncWindowMs_${id}" min="50" max="500" step="10" value="${group.syncWindowMs ?? 120}" oninput="document.getElementById('val_multiSyncWindow_${id}').innerText = this.value + ' ms'; renderMultiSyncPreview('${id}');"><span id="val_multiSyncWindow_${id}" class="slider-val">${group.syncWindowMs ?? 120} ms</span></div></td></tr>
                                <tr><td>${infoLabel('BatchgrÃ¶ÃŸe', 'Anzahl Lampen, nach denen eine zusÃ¤tzliche Batch-Pause eingeplant wird. Bei 10 Lampen und BatchgrÃ¶ÃŸe 10 gibt es praktisch keinen Zwischenstopp.')}</td><td><input type="number" id="sys_multiBatchSize_${id}" min="1" max="20" step="1" value="${group.batchSize ?? 4}" oninput="renderMultiSyncPreview('${id}')"></td></tr>
                                <tr><td>${infoLabel('Batch-Pause', 'ZusÃ¤tzliche Pause nach jedem Batch. Hilft nur, wenn die BatchgrÃ¶ÃŸe kleiner ist als die Lampenanzahl. Bei BatchgrÃ¶ÃŸe 10 und 10 Lampen meist 0 ms sinnvoll.')}</td><td><div class="slider-container"><input type="range" id="sys_multiBatchDelayMs_${id}" min="0" max="300" step="10" value="${group.batchDelayMs ?? 30}" oninput="document.getElementById('val_multiBatchDelay_${id}').innerText = this.value + ' ms'; renderMultiSyncPreview('${id}');"><span id="val_multiBatchDelay_${id}" class="slider-val">${group.batchDelayMs ?? 30} ms</span></div></td></tr>
                                <tr><td>${infoLabel('Max. Lichtbefehle/s', 'Obergrenze fÃ¼r diese Gruppe. Wichtigster Wert gegen Hue 429. Niedriger = stabiler, hÃ¶her = schneller. Typisch 15-20/s testen.')}</td><td><div class="slider-container"><input type="range" id="sys_multiMaxCommandsPerSecond_${id}" min="1" max="50" step="1" value="${group.maxCommandsPerSecond ?? 10}" oninput="document.getElementById('val_multiMaxRate_${id}').innerText = this.value + ' /s'; renderMultiSyncPreview('${id}');"><span id="val_multiMaxRate_${id}" class="slider-val">${group.maxCommandsPerSecond ?? 10} /s</span></div></td></tr>
                                <tr><td>${infoLabel('Timing-Test', 'Simulation fÃ¼r diese Gruppe: Anzahl aktiver Lampen, Mindestabstand, Zeitpunkt des letzten Befehls und effektive Befehlsrate.')}</td><td><div id="multiSyncPreview_${id}" style="font-size:0.8rem; color:var(--text-main); background:#f8f9fa; border:1px solid var(--border); border-radius:6px; padding:10px;"></div></td></tr>
                            </table>
                        </details>
                    </td>
                </tr>
            `;
        });

        return html;
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
        d.disableLogDisk = document.getElementById('sys_disableLogDisk').checked;

        try {
            await fetch('/api/setup/loxone', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
                loxoneIp: d.loxIp, loxonePort: d.loxPort, debug: d.debug,
                transitionTime: d.transitionTime, throttleTime: d.throttleTime, eventStreamWatchdogTimeoutSeconds: d.eventStreamWatchdogTimeoutSeconds,
                mqttEnabled: d.mqttEnabled, mqttBroker: d.mqttBroker, mqttPort: d.mqttPort, mqttUser: d.mqttUser, mqttPass: d.mqttPass, mqttPrefix: d.mqttPrefix,
                disableLogDisk: d.disableLogDisk,
                multiLightControl: {
                    bridgeMaxCommandsPerSecond: d.multiBridgeMaxCommandsPerSecond,
                    groups: d.multiGroups
                }
            })});
            alert("Gespeichert!");
            loadSettings();
        } catch(e) { alert("Fehler!"); }
    }

    async function loadSettings() {
        try {
            const s = await (await fetch('/api/settings')).json();
            multiLightControlSettings = s.multiLightControl || multiLightControlSettings;
            const table = document.getElementById('settingsTable');
            const v = (val) => val !== undefined ? val : '';
            
            table.innerHTML = `
                <tr><td colspan="2" style="background:#eee;font-weight:bold">Allgemein</td></tr>
                <tr><td>Version</td><td><span class="badge" style="background:#333;color:#fff">${s.version}</span></td></tr>
                <tr><td>${infoLabel('Loxone IP', 'IP-Adresse des Loxone Miniservers fÃ¼r UDP-RÃ¼ckmeldungen von Hue StatusÃ¤nderungen.')}</td><td><input id="sys_loxIp" value="${v(s.loxone_ip)}"></td></tr>
                <tr><td>${infoLabel('UDP Port', 'UDP-Port am Loxone Miniserver, auf den Statusmeldungen gesendet werden. Muss zur virtuellen UDP-Eingangskonfiguration passen.')}</td><td><input type="number" id="sys_loxPort" value="${v(s.loxone_port)}"></td></tr>
                
                <tr>
                    <td>${infoLabel('Ãœbergangszeit', 'Hue Dynamics Dauer fÃ¼r weiche ÃœbergÃ¤nge. HÃ¶her wirkt sanfter, aber trÃ¤ger. FÃ¼r schnelle Szenen eher 0-100 ms testen.')}</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_transition" min="0" max="1000" step="50" value="${v(s.transitionTime)}" oninput="document.getElementById('val_trans').innerText = this.value + ' ms'">
                            <span id="val_trans" class="slider-val">${v(s.transitionTime)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>${infoLabel('Drosselung', 'Pause der normalen Hue-Queue auÃŸerhalb Multi-Sync. HÃ¶her reduziert Last, betrifft normale Einzel- und Gruppenbefehle.')}</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_throttle" min="0" max="1000" step="50" value="${v(s.throttleTime)}" oninput="document.getElementById('val_thro').innerText = this.value + ' ms'">
                            <span id="val_thro" class="slider-val">${v(s.throttleTime)} ms</span>
                        </div>
                    </td>
                </tr>
                <tr>
                    <td>${infoLabel('EventStream Watchdog', 'Startet den Hue EventStream neu, wenn lÃ¤ngere Zeit keine Daten kommen. 10 min ist Standard; niedriger nur bei echten Aussetzern.')}</td>
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
                    <td>BatchgrÃ¶ÃŸe</td>
                    <td><input type="number" id="sys_multiBatchSize" min="1" max="20" step="1" value="${v(s.multiLightControl?.batchSize ?? 4)}" oninput="renderMultiSyncPreview()"></td>
                </tr>
                <tr>
                    <td>Batch-Pause</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_multiBatchDelayMs" min="0" max="300" step="10" value="${v(s.multiLightControl?.batchDelayMs ?? 30)}" oninput="document.getElementById('val_multiBatchDelay').innerText = this.value + ' ms'; renderMultiSyncPreview();">
                            <span id="val_multiBatchDelay" class="slider-val">${v(s.multiLightControl?.batchDelayMs ?? 30)} ms</span>
                        </div>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Gilt nur fÃ¼r Lampen mit aktivierter Mehrlampensynchronisierung.</div>
                    </td>
                </tr>
                <tr>
                    <td>Max. Lichtbefehle/s</td>
                    <td>
                        <div class="slider-container">
                            <input type="range" id="sys_multiMaxCommandsPerSecond" min="1" max="50" step="1" value="${v(s.multiLightControl?.maxCommandsPerSecond ?? 10)}" oninput="document.getElementById('val_multiMaxRate').innerText = this.value + ' /s'; renderMultiSyncPreview();">
                            <span id="val_multiMaxRate" class="slider-val">${v(s.multiLightControl?.maxCommandsPerSecond ?? 10)} /s</span>
                        </div>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">10/s entspricht der Hue-Empfehlung. HÃ¶here Werte vorsichtig je Lampenmenge testen.</div>
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
                    <td>${infoLabel('SD-Card Mode', 'Deaktiviert Schreibzugriffe auf logs.db und hÃ¤lt Logs nur im RAM. Sinnvoll auf SD-Karten-Systemen.')}</td>
                    <td>
                        <input type="checkbox" id="sys_disableLogDisk" ${s.disableLogDisk?'checked':''}>
                        <div style="font-size:0.7em; color:var(--text-muted); margin-top:2px">Deaktiviert Schreibzugriffe auf logs.db.</div>
                    </td>
                </tr>

                <tr><td colspan="2" style="background:#eee;font-weight:bold">MQTT</td></tr>
                <tr><td>${infoLabel('Aktivieren', 'Aktiviert parallele Statusausgabe an einen MQTT Broker.')}</td><td><input type="checkbox" id="sys_mqttEnabled" ${s.mqttEnabled?'checked':''}></td></tr>
                <tr><td>${infoLabel('Broker IP', 'Adresse des MQTT Brokers, z. B. Mosquitto oder Home Assistant MQTT.')}</td><td><input id="sys_mqttBroker" value="${v(s.mqttBroker)}"></td></tr>
                <tr><td>${infoLabel('Port', 'MQTT-Port. Standard ist 1883 ohne TLS.')}</td><td><input type="number" id="sys_mqttPort" value="${v(s.mqttPort)||1883}"></td></tr>
                <tr><td>${infoLabel('User', 'Optionaler MQTT Benutzername.')}</td><td><input id="sys_mqttUser" value="${v(s.mqttUser)}"></td></tr>
                <tr><td>${infoLabel('Passwort', 'Optionales MQTT Passwort.')}</td><td><input type="password" id="sys_mqttPass" value="${v(s.mqttPass)}"></td></tr>
                <tr><td>${infoLabel('Prefix', 'Topic-Prefix fÃ¼r MQTT Statusmeldungen, z. B. loxhue/light/wohnzimmer/on.')}</td><td><input id="sys_mqttPrefix" value="${v(s.mqttPrefix)||'loxhue'}"></td></tr>
            `;
            renderMultiSyncPreview();
        } catch(e){ console.error("Fehler bei loadSettings:", e); }
    }

    function showDetails(uuid, loxoneName) {
        const target = targets.find(t => t.uuid === uuid);
        const entry = mappings.find(m => m.loxone_name === loxoneName);
        const currentStatus = status[loxoneName] || {};
        if(!target || !entry) return;
        const safeLoxoneName = jsArg(loxoneName);
        const safeHex = safeHexColor(currentStatus.hex);

        let content = `<div style="margin-bottom:20px;">`;

        // 1. SETTINGS (nur fÃ¼r Lichter/Gruppen)
        if (entry.hue_type === 'light' || entry.hue_type === 'group') {
            const caps = target.capabilities || {};
            const supportsDimming = entry.hue_type === 'group' ? true : !!caps.supportsDimming; 
            
            const isStrictOnOff = entry.hue_type === 'light' && !supportsDimming;
            const ignoreDyn = isStrictOnOff ? true : !!entry.ignore_dynamics;
            const disableIgnoreDyn = isStrictOnOff ? 'disabled' : '';
            const groupOptions = (multiLightControlSettings.groups || MULTI_SYNC_GROUP_IDS.map(id => ({ id, name: `Gruppe ${id.toUpperCase()}` })))
                .map(group => `<option value="${group.id}" ${(entry.multi_sync_group || 'a') === group.id ? 'selected' : ''}>${escapeHtml(group.name || `Gruppe ${group.id.toUpperCase()}`)}</option>`)
                .join('');

            content += `
                <h3 style="margin-top:0; font-size:1rem; color:var(--text-main);">âš™ï¸ Einstellungen</h3>
                
                <div class="settings-card">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" ${entry.sync_lox ? 'checked' : ''} onchange="updateMappingSetting(${safeLoxoneName}, 'sync_lox', this.checked)"> 
                        <span style="font-weight:500;">Loxone Sync</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">Sendet StatusÃ¤nderungen per UDP an Loxone zurÃ¼ck.</div>
                </div>

                <div class="settings-card" style="opacity: ${isStrictOnOff ? '0.6' : '1'};">
                    <label style="display:flex; align-items:center; gap:10px; cursor:${isStrictOnOff ? 'not-allowed' : 'pointer'};">
                        <input type="checkbox" ${ignoreDyn ? 'checked' : ''} ${disableIgnoreDyn} onchange="updateMappingSetting(${safeLoxoneName}, 'ignore_dynamics', this.checked)"> 
                        <span style="font-weight:500;">Dynamics ignorieren</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">
                        ${isStrictOnOff ? 'Dieses GerÃ¤t ist ein reiner On/Off Schalter und unterstÃ¼tzt kein Dimmen. Parameter ist erzwungen aktiv.' : 'Deaktiviert weiche Ãœbergangszeiten (Transition) beim Schalten fÃ¼r dieses GerÃ¤t.'}
                    </div>
                </div>
                
                <div class="settings-card" style="display:${entry.hue_type === 'light' ? 'block' : 'none'};">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" ${entry.multi_sync === true ? 'checked' : ''} onchange="updateMappingSetting(${safeLoxoneName}, 'multi_sync', this.checked)"> 
                        <span style="font-weight:500;">Mehrlampensynchronisierung</span>
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-left:24px; margin-top:2px;">
                        Nimmt diese Lampe in den gemeinsamen Sammel-/Batch-Ablauf auf. Nur einzelne Hue-Lampen werden hier synchronisiert, keine Gruppen.
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-left:24px; margin-top:10px;">
                        <span style="font-size:0.85rem; color:var(--text-muted); min-width:90px;">Gruppe</span>
                        <select onchange="updateMappingSetting(${safeLoxoneName}, 'multi_sync_group', this.value)" style="max-width:180px;">
                            ${groupOptions}
                        </select>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-left:24px; margin-top:10px;">
                        <span style="font-size:0.85rem; color:var(--text-muted); min-width:90px;">Sync-Offset</span>
                        <input type="number" min="-500" max="1000" step="10" value="${escapeHtml(entry.sync_offset_ms || 0)}" onchange="updateMappingSetting(${safeLoxoneName}, 'sync_offset_ms', parseInt(this.value) || 0)" style="max-width:120px;">
                        <span style="font-size:0.85rem; color:var(--text-muted);">ms</span>
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-left:24px; margin-top:4px;">
                        Negativ = frÃ¼her senden, positiv = spÃ¤ter senden. Empfohlen: zuerst 0 ms, danach in 10-ms-Schritten abstimmen.
                    </div>
                </div>

                <hr style="border:0; border-top:1px solid var(--border); margin: 20px 0;">
            `;
        }

        // 2. STATUS & SPECS (fÃ¼r alle GerÃ¤te)
        content += `<h3 style="margin-top:0; font-size:1rem; color:var(--text-main);">âš¡ Aktueller Status</h3><table class="details-table">`;
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
        if (currentStatus.temp !== undefined) content += `<tr><td>Temperatur</td><td>${currentStatus.temp} Â°C</td></tr>`;
        if (currentStatus.lux !== undefined) content += `<tr><td>Helligkeit</td><td>${currentStatus.lux} lx</td></tr>`;
        if (currentStatus.contact !== undefined) content += `<tr><td>Kontakt</td><td>${currentStatus.contact === 1 ? 'ðŸ”“ Offen' : 'ðŸ”’ Geschlossen'}</td></tr>`;
        if (currentStatus.motion !== undefined) content += `<tr><td>Bewegung</td><td>${currentStatus.motion === 1 ? 'ðŸƒ Ja' : 'ðŸ§˜ Nein'}</td></tr>`;

        content += `<tr><td colspan="2" style="border-bottom:none; padding-top:20px; color:var(--text-muted); font-weight:bold;">ðŸ“‹ Technische Daten</td></tr>`;
        content += `<tr><td>Name</td><td>${escapeHtml(target.name)}</td></tr>`;
        content += `<tr><td>Loxone ID</td><td>${escapeHtml(loxoneName)}</td></tr>`;
        content += `<tr><td>Typ</td><td><span class="badge" style="background:#eee;color:#333">${escapeHtml(entry.hue_type)}</span></td></tr>`;
        content += `<tr><td>UUID</td><td style="font-size:0.8em; font-family:monospace">${escapeHtml(target.uuid)}</td></tr>`;
        content += `</table></div>`;

        document.getElementById('detailsContent').innerHTML = content;
        document.getElementById('detailsModal').style.display = 'flex';
    }

    function toggleSelectAll() { allSelected = !allSelected; document.querySelectorAll('.modal-checkbox').forEach(cb => cb.checked = allSelected); }
    function doExport() {
        const checked = document.querySelectorAll('.modal-checkbox:checked');
        if(checked.length === 0) return alert("Bitte wÃ¤hlen.");
        const names = Array.from(checked).map(cb => cb.value).join(',');
        const type = currentTab === 'light' ? 'outputs' : 'inputs';
        window.location.href = `/api/download/${type}?names=${names}`;
        closeModal('exportModal');
    }
    
    async function restartServer() { if(confirm("Neustart?")) await fetch('/api/system/restart', {method:'POST'}); }
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
            item.innerHTML = `<input type="checkbox" class="modal-checkbox" value="${escapeHtml(m.loxone_name)}"><div><div style="font-weight:bold">${escapeHtml(m.loxone_name)}</div></div>`;
            list.appendChild(item);
        });
    }

    init();
