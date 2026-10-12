/**
 * Tracks the current unresolved choice on each host-owned player seat.
 * A lease is an event-local generation, not an authentication credential.
 */
export class ChoiceLeaseRegistry {
  constructor({now = Date.now} = {}) {
    this.now = now;
    this.sequence = 0;
    this.currentLeases = new Map();
  }
  open(seatId, {socket = null, timeoutMs = 0} = {}) {
    if (typeof seatId !== "string" || !seatId) throw new Error("seat id required");
    const old = this.currentLeases.get(seatId);
    if (old) old.state = "SUPERSEDED";
    const lease = {
      id: ++this.sequence,
      seatId,
      socket,
      startedAt: this.now(),
      deadlineAt: this.now() + Math.max(0, Number(timeoutMs) || 0),
      state: "WAITING"
    };
    this.currentLeases.set(seatId, lease);
    return lease;
  }
  current(seatId) {
    return this.currentLeases.get(seatId) || null;
  }
  isCurrent(seatId, lease) {
    return !!lease && lease.state === "WAITING" && this.currentLeases.get(seatId) === lease;
  }
  settle(seatId, expectedLease = null) {
    const lease = this.currentLeases.get(seatId);
    if (!lease || lease.state !== "WAITING" || (expectedLease && expectedLease !== lease)) return false;
    lease.state = "SETTLED";
    this.currentLeases.delete(seatId);
    return true;
  }
  cancel(seatId, expectedLease = null) {
    const lease = this.currentLeases.get(seatId);
    if (!lease || (expectedLease && expectedLease !== lease)) return false;
    lease.state = "CANCELLED";
    this.currentLeases.delete(seatId);
    return true;
  }
}
