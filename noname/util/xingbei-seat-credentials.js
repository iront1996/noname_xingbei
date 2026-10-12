/**
 * Persist room-bound reconnect credentials only in this browser tab's
 * session storage. Credentials are secrets: never log or send them to telemetry.
 * Storage failures must not interrupt gameplay.
 */
const PREFIX = "xingbei:seat-recovery:v1:";
export function validSeatCredentials(value) {
  return value && typeof value === "object" &&
    typeof value.roomId === "string" && value.roomId.length > 0 && value.roomId.length <= 256 &&
    typeof value.seatId === "string" && value.seatId.length > 0 && value.seatId.length <= 256 &&
    typeof value.token === "string" && /^[0-9a-f]{64}$/i.test(value.token);
}
function key(endpoint) {
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return null;
  return PREFIX + endpoint;
}
export function saveSeatCredentials(storage, endpoint, roomId, seatId, token) {
  const value = {roomId,seatId,token};
  const k=key(endpoint);
  if(!k || !validSeatCredentials(value))return false;
  try {storage?.setItem(k,JSON.stringify(value));return true;}catch(_){return false;}
}
export function loadSeatCredentials(storage,endpoint) {
  const k=key(endpoint);
  if(!k)return null;
  try {
    const stored=storage?.getItem(k);
    const v=stored?JSON.parse(stored):null;
    return validSeatCredentials(v)?v:null;
  } catch(_) {return null;}
}
export function clearSeatCredentials(storage,endpoint) {
  const k=key(endpoint);
  if(!k)return;
  try{storage?.removeItem(k);}catch(_){}
}
