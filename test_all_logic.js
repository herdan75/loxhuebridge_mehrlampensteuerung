// Test script for native bridge_home 'all' logic
const axios = require('axios');

// Mock data
const config = { bridgeIp: '192.168.1.100', appKey: 'dummy' };
const mapping = [];

// Mocking axios
axios.get = async (url) => {
    if (url.includes('bridge_home')) {
        return {
            data: {
                data: [{
                    services: [{ rtype: 'grouped_light', rid: 'home-group-123' }]
                }]
            }
        };
    }
    throw new Error('Not found');
};

let executedRid = null;

// Mocking executeCommand
async function executeCommand(entry, value, delay) {
    executedRid = entry.hue_uuid;
    console.log(`Executed command on RID: ${executedRid} with value ${value}`);
}

async function testAllRoute() {
    console.log("Testing native '/all' logic...");
    try {
        const homeRes = await axios.get(`https://${config.bridgeIp}/clip/v2/resource/bridge_home`, { headers: { 'hue-application-key': config.appKey } });
        const homeSvc = homeRes.data.data[0]?.services.find(s => s.rtype === 'grouped_light');
        if (homeSvc) {
            await executeCommand({ hue_uuid: homeSvc.rid, hue_type: 'group', loxone_name: 'all' }, '0', 0);
            if (executedRid === 'home-group-123') {
                console.log("✅ Native All command passed!");
                process.exit(0);
            }
        }
        console.log("❌ Failed to find homeSvc");
        process.exit(1);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

testAllRoute();
