// Test script for battery logic
function getBatteryBadge(bat) {
    let badges = '';
    const has = (v) => v !== undefined && v !== null;
    
    if (has(bat)) {
        if (bat <= 10) {
            badges += `<span class="badge" style="background:#ffcdcd; color:red; font-weight:bold;">🪫 ${bat}% (Leer)</span>`;
        } else {
            badges += `<span class="badge">🔋 ${bat}%</span>`;
        }
    }
    return badges;
}

// Test Cases
const tests = [
    { input: 100, expected: '🔋' },
    { input: 50, expected: '🔋' },
    { input: 10, expected: '🪫' },
    { input: 5, expected: '🪫' },
    { input: 0, expected: '🪫' }
];

let passed = true;
tests.forEach(t => {
    const res = getBatteryBadge(t.input);
    const success = res.includes(t.expected) && (t.input <= 10 ? res.includes('red') : !res.includes('red'));
    if (success) {
        console.log(`✅ Test passed for ${t.input}% -> ${res}`);
    } else {
        console.log(`❌ Test failed for ${t.input}% -> ${res}`);
        passed = false;
    }
});

if (passed) {
    console.log("All tests passed!");
    process.exit(0);
} else {
    console.log("Tests failed!");
    process.exit(1);
}
