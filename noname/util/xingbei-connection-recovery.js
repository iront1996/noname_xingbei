/**
 * Session-bound recovery of an already identified player.
 * A WebSocket open is never proof of gameplay restoration.
 * This transport coordinator deliberately does NOT attempt room membership
 * or accept an arbitrary player id as proof of ownership.
 */
export class ConnectionRecovery {
  constructor({connect, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    onState = () => {}, onExhausted = () => {}, maxElapsedMs = 120000,
    handshakeTimeoutMs = 45000, connectTimeoutMs = 15000,
    delaysMs = [1000, 2000, 4000, 8000, 15000, 30000]} = {}) {
    if (typeof connect !== 'function') throw new Error('connect function required');
    this.connect = connect;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onState = onState;
    this.onExhausted = onExhausted;
    this.maxElapsedMs = maxElapsedMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.delaysMs = delaysMs;
    this.active = false;
    this.generation = 0;
    this.phase = 'IDLE';
    this.timer = null;
    this.startedAt = 0;
    this.attempt = 0;
    this.attemptSerial = 0;
  }
  change(phase, details = {}) {
    if (this.phase === phase && !Object.keys(details).length) return;
    this.phase = phase;
    try { this.onState(phase, details); } catch (_) {}
  }
  clearPending() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  start(endpoint, {wasInGame = true} = {}) {
    if (this.active) return false;
    if (typeof endpoint !== 'string' || !endpoint) return false;
    this.active = true;
    this.generation += 1;
    this.attempt = 0;
    this.startedAt = this.now();
    this.wasInGame = wasInGame;
    this.endpoint = endpoint;
    this.change('RECONNECTING');
    this.retrySoon(0);
    return true;
  }
  retrySoon(delayOverride) {
    if (!this.active) return;
    this.clearPending();
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.maxElapsedMs) return this.exhaust();
    const index = Math.min(this.attempt, this.delaysMs.length - 1);
    const delay = Math.min(delayOverride === undefined ? this.delaysMs[index] : delayOverride, this.maxElapsedMs - elapsed);
    this.change('RECONNECTING', {attempt: this.attempt + 1, delayMs: delay});
    const serial = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.active && serial === this.generation) {
        if (this.now() - this.startedAt >= this.maxElapsedMs) this.exhaust();
        else this.tryConnect(serial);
      }
    }, delay);
  }
  tryConnect(serial) {
    if (!this.active || serial !== this.generation) return;
    this.attempt++;
    const attemptSerial = ++this.attemptSerial;
    this.change('CONNECTING', {attempt: this.attempt});
    let settled = false;
    const report = ok => {
      if (settled || !this.active || serial !== this.generation || this.phase !== 'CONNECTING' || attemptSerial !== this.attemptSerial) return;
      settled = true;
      this.clearPending();
      if (!ok) return this.retrySoon();
      this.change('SYNCING', {attempt: this.attempt});
      this.timer = this.setTimer(() => {
        if (this.active && serial === this.generation && this.phase === 'SYNCING') this.retrySoon();
      }, this.handshakeTimeoutMs);
    };
    this.timer = this.setTimer(() => report(false), this.connectTimeoutMs);
    try { this.connect(this.endpoint, report); } catch (_) { report(false); }
  }
  connectionLost() {
    if (!this.active) return false;
    if (this.phase === 'CONNECTING' || this.phase === 'SYNCING') this.retrySoon();
    return true;
  }
  synchronized(kind = 'reinit') {
    if (!this.active || this.phase !== 'SYNCING') return false;
    if (kind !== 'reinit' && kind !== 'owner_resume' && !(kind === 'roomlist' && !this.wasInGame)) return false;
    this.clearPending();
    this.active = false;
    this.generation++;
    this.change('RECOVERED', {kind});
    return true;
  }
  reject(reason) {
    if (!this.active) return false;
    this.clearPending();
    this.active = false;
    this.generation++;
    this.change('REJECTED', {reason});
    return true;
  }
  exhaust() {
    this.clearPending();
    this.active = false;
    this.generation++;
    this.change('EXHAUSTED');
    try { this.onExhausted(); } catch (_) {}
  }
}
