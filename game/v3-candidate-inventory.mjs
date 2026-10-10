/** Independent metadata-only verification of each locally encrypted V3 candidate.
 * Callers supply the AES-GCM decryptor; this module never returns plaintext.
 * A verified candidate is NOT a restorable engine checkpoint.
 */
export async function inspectV3EncryptedRecord({record,roomId,kind,now,maxAgeMs=600000,decrypt}) {
  const fail = (status, code) => ({status, ...(code ? {code} : {})});
  if (!record) return fail("NOT_FOUND");
  if (kind !== "periodic" && kind !== "turn_boundary") return fail("UNAVAILABLE","INVALID_KIND");
  if (!record || !Number.isSafeInteger(record.capturedAt) ||
      !Number.isSafeInteger(record.playerCount) || record.playerCount < 1 ||
      typeof record.ciphertext !== "string" || typeof record.iv !== "string" ||
      typeof decrypt !== "function") return fail("UNAVAILABLE","RECORD_SHAPE_INVALID");
  const ageMs=now-record.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < -60000) return fail("UNAVAILABLE","RECORD_TIMESTAMP_INVALID");
  if (ageMs > maxAgeMs) return fail("EXPIRED");
  try {
    const data=await decrypt(record);
    if (!data || data.schema !== "xingbei-v3-candidate-1" ||
        data.roomId !== roomId || data.observationKind !== kind ||
        data.restorable !== false || data.safeCheckpointCertified !== false ||
        data.eventContinuationCaptured !== false ||
        data.playerHistoryCompletenessVerified !== false ||
        data.capturedAt !== record.capturedAt ||
        !data.arena?.players || Array.isArray(data.arena.players) ||
        Object.keys(data.arena.players).length !== record.playerCount) {
      return fail("UNAVAILABLE","CANDIDATE_SCHEMA_INVALID");
    }
    return {status:"ENCRYPTED_CANDIDATE_VERIFIED",
      ageSeconds:Math.floor(Math.max(0,ageMs)/1000),playerCount:record.playerCount};
  } catch {
    // Deliberately don't surface error messages from WebCrypto or parsed user data.
    return fail("UNAVAILABLE","DECRYPT_OR_PARSE_FAILED");
  }
}
