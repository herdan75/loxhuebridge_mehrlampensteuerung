const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Frontend escaped Log-Ausgaben vor innerHTML', () => {
    assert.match(appJs, /const msg = escapeHtml\(l\.msg \|\| ''\);/);
    assert.match(appJs, /const cat = escapeHtml\(l\.category \|\| 'SYSTEM'\);/);
    assert.match(appJs, /const level = escapeHtml\(l\.level \|\| ''\);/);
});

test('Frontend validiert Hex-Farben vor style background-color', () => {
    assert.match(appJs, /function safeHexColor/);
    assert.match(appJs, /background-color:\$\{safeHexColor\(st\.hex\)\}/);
    assert.match(appJs, /background-color:\$\{safeHex\}/);
});
