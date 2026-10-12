/**
 * Bind a choice-result object to the operation that created it.
 * The metadata is intentionally non-enumerable: it is client-local and must
 * not be serialized into the ordinary game result payload.
 */
export function bindOriginChoice(result, originWireId) {
  if (!result || typeof result !== "object" ||
      typeof originWireId !== "string" ||
      !/^c2:[0-9a-z]+$/.test(originWireId)) return result;
  if (typeof result._xingbeiChoiceWireId === "string" &&
      /^c2:[0-9a-z]+$/.test(result._xingbeiChoiceWireId)) return result;
  try {
    Object.defineProperty(result, "_xingbeiChoiceWireId", {
      value: originWireId, enumerable: false, configurable: true
    });
  } catch (_) {
    // Do not crash a legacy GameEvent when it uses a sealed result.
  }
  return result;
}
