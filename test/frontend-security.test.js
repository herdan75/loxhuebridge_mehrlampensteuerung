const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const checkedTextFiles = [
    ['public/app.js', path.join(__dirname, '..', 'public', 'app.js')],
    ['public/index.html', path.join(__dirname, '..', 'public', 'index.html')],
    ['public/setup.html', path.join(__dirname, '..', 'public', 'setup.html')],
    ['README.md', path.join(__dirname, '..', 'README.md')],
    ['CHANGELOG.md', path.join(__dirname, '..', 'CHANGELOG.md')]
].map(([name, filePath]) => [name, fs.readFileSync(filePath, 'utf8')]);

const appJs = checkedTextFiles.find(([name]) => name === 'public/app.js')[1];

test('Frontend escaped Log-Ausgaben vor innerHTML', () => {
    assert.match(appJs, /const msg = escapeHtml\(l\.msg \|\| ''\);/);
    assert.match(appJs, /const cat = escapeHtml\(l\.category \|\| 'SYSTEM'\);/);
    assert.match(appJs, /const level = escapeHtml\(l\.level \|\| ''\);/);
});

test('Geräte-Details-Modal ist scrollbar und speichert per Save-Button', () => {
    const indexHtml = checkedTextFiles.find(([name]) => name === 'public/index.html')[1];
    const styleCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

    assert.match(indexHtml, /id="detailsModal"/);
    assert.match(indexHtml, /class="modal-body"/);
    assert.match(indexHtml, /Speichern & schließen/);
    assert.match(indexHtml, /saveDetailsSettings\(\)/);
    assert.match(styleCss, /\.modal-body\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(styleCss, /\.modal-box\s*\{[^}]*max-height:\s*calc\(100dvh - 32px\)/);
});

test('Sync-Offset wird nicht mehr per parseInt onchange direkt gespeichert', () => {
    assert.doesNotMatch(appJs, /parseInt\(this\.value\)\s*\|\|\s*0/);
    assert.doesNotMatch(appJs, /updateMappingSetting\([^)]*sync_offset_ms/);
    assert.match(appJs, /function normalizeSyncOffset/);
    assert.match(appJs, /fetch\(`\/api\/mapping\/\$\{encodeURIComponent\(detailsDraft\.loxoneName\)\}\/settings`/);
});

test('Frontend validiert Hex-Farben vor style background-color', () => {
    assert.match(appJs, /function safeHexColor/);
    assert.match(appJs, /background-color:\$\{safeHexColor\(st\.hex\)\}/);
    assert.match(appJs, /background-color:\$\{safeHex\}/);
});

test('Frontend und Dokumentation enthalten keine typischen Mojibake-Sequenzen', () => {
    const mojibakePatterns = [
        ['Ãƒ', /\u00c3\u0192/u],
        ['Ã‚', /\u00c3\u201a/u],
        ['Ã°Å¸', /\u00c3\u00b0\u00c5\u0178/u],
        ['Ã¢Å“', /\u00c3\u00a2\u00c5\u201c/u],
        ['Ã¢â‚¬', /\u00c3\u00a2\u00e2\u201a\u00ac/u],
        ['replacement character', /\ufffd/u],
        ['C1 control character', /[\u0080-\u009f]/u],
        ['Â°C', /\u00c2\u00b0C/u]
    ];

    for (const [fileName, text] of checkedTextFiles) {
        for (const [label, pattern] of mojibakePatterns) {
            assert.doesNotMatch(text, pattern, `${fileName} enthält Mojibake-Sequenz ${label}`);
        }
    }

    assert.match(appJs, /Wählen/);
    assert.match(appJs, /Löschen/);
});
