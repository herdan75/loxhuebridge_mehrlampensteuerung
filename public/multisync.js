(function(root) {
    const MULTI_SYNC_DEFAULTS = { maxCommandsPerSecond: 10, batchSize: 4, sameClusterSpacingMs: 10 };
    function clampNumber(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    }
    function getSyncOffsetMs(entry) { return clampNumber(entry?.sync_offset_ms, 0, -500, 1000); }
    function buildSchedule(items, settings = {}, getCluster) {
        if (!Array.isArray(items) || !items.length) return [];

        const maxCommandsPerSecond = Math.max(1, Number(settings.maxCommandsPerSecond) || MULTI_SYNC_DEFAULTS.maxCommandsPerSecond);
        const globalSpacingMs = settings.bridgeMaxCommandsPerSecond > 0 ? Math.ceil(1000 / settings.bridgeMaxCommandsPerSecond) : 0;
        const commandSpacingMs = Math.max(globalSpacingMs, Math.ceil(1000 / maxCommandsPerSecond));
        const sameClusterSpacingMs = Math.max(globalSpacingMs, clampNumber(settings.sameClusterSpacingMs, MULTI_SYNC_DEFAULTS.sameClusterSpacingMs, 0, 50));
        const batchSize = Math.max(1, Number(settings.batchSize) || MULTI_SYNC_DEFAULTS.batchSize);
        const batchDelayMs = Math.max(0, Number(settings.batchDelayMs) || 0);
        const offsets = items.map(item => getSyncOffsetMs(item.entry));
        const baseDelayMs = Math.max(0, -Math.min(...offsets));

        const clusters = new Map();
        items.forEach((item, index) => {
            const offset = offsets[index];
            const cluster = getCluster(item, settings);
            if (!clusters.has(cluster.key)) {
                clusters.set(cluster.key, {
                    key: cluster.key,
                    name: cluster.name,
                    firstIndex: index,
                    minOffset: offset,
                    items: []
                });
            }

            const clusterEntry = clusters.get(cluster.key);
            clusterEntry.minOffset = Math.min(clusterEntry.minOffset, offset);
            clusterEntry.items.push({
                item,
                offset,
                originalIndex: index,
                clusterKey: cluster.key,
                clusterName: cluster.name
            });
        });

        const sortedClusters = Array.from(clusters.values())
            .sort((a, b) => {
                if (a.minOffset !== b.minOffset) return a.minOffset - b.minOffset;
                return a.firstIndex - b.firstIndex;
            });

        let lastDelay = -commandSpacingMs;
        let previousClusterKey = null;
        let commandIndex = 0;
        const schedule = [];

        sortedClusters.forEach((cluster, clusterIndex) => {
            cluster.items
                .sort((a, b) => {
                    if (a.offset !== b.offset) return a.offset - b.offset;
                    return a.originalIndex - b.originalIndex;
                })
                .forEach((scheduleItem, withinClusterIndex) => {
                    const spacingFromPrevious = previousClusterKey === scheduleItem.clusterKey
                        ? sameClusterSpacingMs
                        : commandSpacingMs;
                    const batchDelay = previousClusterKey === scheduleItem.clusterKey
                        ? 0
                        : Math.floor(commandIndex / batchSize) * batchDelayMs;
                    const requestedDelay = baseDelayMs
                        + cluster.minOffset
                        + (clusterIndex * commandSpacingMs)
                        + Math.max(0, scheduleItem.offset - cluster.minOffset)
                        + (withinClusterIndex * sameClusterSpacingMs)
                        + batchDelay;
                    const delayMs = Math.max(
                        Math.max(0, Math.round(requestedDelay)),
                        lastDelay + spacingFromPrevious
                    );

                    schedule.push({
                        ...scheduleItem,
                        requestedDelay: Math.max(0, Math.round(requestedDelay)),
                        delayMs,
                        commandSpacingMs,
                        sameClusterSpacingMs
                    });

                    lastDelay = delayMs;
                    previousClusterKey = scheduleItem.clusterKey;
                    commandIndex += 1;
                });
        });

        schedule.forEach((scheduleItem, index) => {
            const nextItem = schedule[index + 1];
            scheduleItem.schedulerSpacingMs = nextItem && nextItem.clusterKey === scheduleItem.clusterKey
                ? sameClusterSpacingMs
                : commandSpacingMs;
        });

        return schedule;
    }
    const api = { buildSchedule };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MultiSyncTiming = api;
})(globalThis);
