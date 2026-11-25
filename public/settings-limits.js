(function(root) {
    const limits = {
        transitionTime: { min: 0, max: 60000, default: 400 },
        throttleTime: { min: 0, max: 5000, default: 100 },
        eventStreamWatchdogTimeoutSeconds: { min: 60, max: 3600, default: 600 },
        syncWindowMs: { min: 10, max: 2000, default: 120 },
        batchSize: { min: 1, max: 50, default: 4 },
        batchDelayMs: { min: 0, max: 2000, default: 30 },
        maxCommandsPerSecond: { min: 1, max: 50, default: 10 },
        bridgeMaxCommandsPerSecond: { min: 1, max: 100, default: 30 },
        sameClusterSpacingMs: { min: 0, max: 50, default: 10 }
    };
    if (typeof module === 'object' && module.exports) module.exports = limits;
    else root.SettingsLimits = limits;
})(globalThis);
