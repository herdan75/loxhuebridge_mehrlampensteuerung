// Test script for deduplication logic
const detected = [
    { type: 'command', name: 'haengelampenBuero' },
    { type: 'command', name: 'haengelampenBuero' },
    { type: 'command', name: 'haengelampenLBuero' },
    { type: 'command', name: 'haengelampenLBuero' },
    { type: 'event', name: 'someEvent' }
];

const filteredDetected = detected.filter(d => d.type === 'command')
                                 .filter((v, i, a) => a.findIndex(t => t.name === v.name) === i);

console.log("Original command count:", detected.filter(d => d.type === 'command').length);
console.log("Deduplicated command count:", filteredDetected.length);

if (filteredDetected.length === 2 && filteredDetected[0].name === 'haengelampenBuero' && filteredDetected[1].name === 'haengelampenLBuero') {
    console.log("✅ Deduplication works!");
    process.exit(0);
} else {
    console.log("❌ Deduplication failed!");
    process.exit(1);
}
