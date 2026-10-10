/**
 * V3-only decision guard for a rejected room creation.
 * Status is returned by the authenticated V3 room broker; never turn an
 * unverified/unknown state into room deletion or host takeover.
 */
export function evaluateV3BlockedRoomStatus(status, hasOwnerToken) {
  if (status === "room_absent") {
    return Object.freeze({ action:"RELOAD_HALL", canAbandon:false });
  }
  if (status === "owner_disconnected" && hasOwnerToken === true) {
    return Object.freeze({ action:"CONFIRM_ABANDON", canAbandon:true });
  }
  return Object.freeze({ action:"RECHECK_ONLY", canAbandon:false });
}
