// Per-light startup jobs never sleep inside the shared Hue PUT scheduler.
class PowerStart {
    constructor() {
        this.lights = new Map();
        this.stopped = false;
    }

    state(uuid) {
        if (!this.lights.has(uuid)) this.lights.set(uuid, { ready: false, connected: null, busy: false, job: null, timer: null });
        return this.lights.get(uuid);
    }

    submit(uuid, request) {
        if (this.stopped) return;
        const state = this.state(uuid);
        const now = Date.now();
        const previous = state.job;
        const cold = request.isOn && (request.verifyFirst || !state.ready || state.connected === false);
        const continuing = cold && previous?.isOn && previous.deadline > now;
        clearTimeout(state.timer);
        state.job = {
            ...request, cold, attempts: 0, phase: request.verifyFirst ? 'verify' : 'send',
            deadline: continuing ? previous.deadline : now + request.windowMs,
            nextAt: request.verifyFirst ? now + request.verifyDelayMs : continuing ? previous.nextAt : now + (cold ? request.delayMs : 0)
        };
        if (!request.isOn) state.ready = false;
        request.onState?.(cold && state.job.nextAt > now ? 'waiting' : 'queued', 0);
        this.arm(uuid);
    }

    current(state, job) {
        return !this.stopped && state.job === job && job.isCurrent();
    }

    arm(uuid) {
        if (this.stopped) return;
        const state = this.state(uuid);
        const job = state.job;
        if (state.busy || !job) return;
        if (!this.current(state, job)) {
            clearTimeout(state.timer);
            state.job = null;
            job.onState?.('cancelled', job.attempts);
            return;
        }
        clearTimeout(state.timer);
        state.timer = setTimeout(() => this.run(uuid), Math.max(0, job.nextAt - Date.now()));
        state.timer.unref?.();
    }

    finish(state, job, phase) {
        if (!this.current(state, job)) return;
        job.onState?.(phase, job.attempts);
        state.job = null;
        if (phase === 'confirmed' || phase === 'accepted') state.ready = job.isOn;
    }

    retry(state, job) {
        if (!this.current(state, job)) return;
        const delay = Math.min(1000, 250 * job.attempts);
        if (!job.isOn || job.attempts >= 8 || Date.now() + delay >= job.deadline) {
            this.finish(state, job, job.isOn ? 'expired' : 'failed');
            return;
        }
        state.ready = false;
        job.cold = true;
        job.phase = 'send';
        job.nextAt = Date.now() + delay;
        job.onState?.('retrying', job.attempts);
    }

    async run(uuid) {
        const state = this.state(uuid);
        const job = state.job;
        if (!job || state.busy) return;
        if (!this.current(state, job)) return this.arm(uuid);
        if ((job.attempts > 0 || job.verifyFirst) && job.isConfirmed?.()) return this.finish(state, job, 'confirmed');
        if (Date.now() >= job.deadline) return this.finish(state, job, 'expired');
        state.busy = true;
        try {
            if (job.phase === 'verify') {
                if (job.isConfirmed?.() || await job.verify(job.deadline)) this.finish(state, job, 'confirmed');
                else this.retry(state, job);
            } else {
                job.attempts += 1;
                job.onState?.('sending', job.attempts);
                const result = await job.send(job.attempts, job.deadline);
                if (!this.current(state, job)) return;
                if (result === false) return this.finish(state, job, 'cancelled');
                if (!job.isOn) return this.finish(state, job, 'off');
                if (job.isConfirmed?.()) return this.finish(state, job, 'confirmed');
                if (job.verify) {
                    job.phase = 'verify';
                    job.nextAt = Date.now() + job.verifyDelayMs;
                    job.onState?.('checking', job.attempts);
                } else {
                    this.finish(state, job, 'accepted');
                }
            }
        } catch (error) {
            if (this.current(state, job)) {
                job.onError?.(error);
                if (job.shouldRetry(error)) this.retry(state, job);
                else this.finish(state, job, 'failed');
            }
        } finally {
            state.busy = false;
            this.arm(uuid);
        }
    }

    connectivity(uuid, connected) {
        const state = this.state(uuid);
        const becameConnected = connected === true && state.connected === false;
        state.connected = connected;
        if (!connected) state.ready = false;
        // A real reconnect may end an optional startup wait early.
        if (becameConnected && state.job?.phase === 'send') {
            state.job.nextAt = Date.now();
            this.arm(uuid);
        }
    }

    close() {
        this.stopped = true;
        for (const state of this.lights.values()) clearTimeout(state.timer);
        this.lights.clear();
    }
}

module.exports = PowerStart;
