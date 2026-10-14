/**
 * EXPERIMENTAL ONLY. Pure decision logic, NOT wired into HALL or production A1.
 * Distinguishes application-heartbeat stalls from observed transport liveness.
 * It does not mistake a successful Pong for completed gameplay.
 */
'use strict';
const DEFAULTS = Object.freeze({
  appAckTimeoutMs:45000,
  pongFreshMs:45000,
  maxApplicationSilenceMs:120000,
});
function classify(state, p=DEFAULTS) {
  if (!state.isCurrentSocket) return {action:'IGNORE_STALE_SOCKET'};
  if (state.readyState!==1) return {action:'STOP_CLOSED_SOCKET'};
  const now=state.now;
  if (!(Number.isFinite(now)&&Number.isFinite(state.lastAppResponseAt))) {
    return {action:'NO_DECISION',reason:'missing timestamps'};
  }
  if (!state.pendingSince) return {action:'WAIT',reason:'no outstanding heartbeat'};
  const pendingMs=now-state.pendingSince;
  if (pendingMs<p.appAckTimeoutMs) return {action:'WAIT',reason:'within app deadline'};
  const silenceMs=now-state.lastAppResponseAt;
  const observedPongAfterProbe=Number.isFinite(state.lastPongAt) &&
      Number.isFinite(state.lastProbeAt) &&
      state.lastPongAt>=state.lastProbeAt &&
      now-state.lastPongAt<=p.pongFreshMs;
  if (observedPongAfterProbe && silenceMs < p.maxApplicationSilenceMs) {
    return {action:'APPLICATION_STALL_GRACE',reason:'fresh transport pong; stale app ack',
      remainingMs:p.maxApplicationSilenceMs-silenceMs};
  }
  return {action:'TERMINATE_SOCKET',reason:
    observedPongAfterProbe?'bounded app stall exceeded':'no fresh pong after probe'};
}
module.exports={classify,DEFAULTS};
