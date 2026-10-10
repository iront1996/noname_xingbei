/**
 * V3-only, fail-closed player-execution serialization audit.
 * Audits every field before accepting a candidate. The reason code never
 * contains player IDs, card text, storage, event content or exception messages.
 * This is NOT an event/Promise continuation or a restorable checkpoint.
 */
import { auditV3Serialization } from "./v3-serialization-integrity.mjs";

const FIELDS = Object.freeze([
  ["stat", "STAT"],
  ["actionHistory", "ACTION"],
  ["skipList", "SKIP"],
]);
const AUDIT_CODES = new Set([
  "ITEMTYPE_UNAVAILABLE", "DEPTH_OR_NODE_LIMIT",
  "EXECUTABLE_FUNCTION_NOT_RESTORABLE", "NUMBER_LOSS",
  "PRIMITIVE_VALUE_CHANGED", "SPECIAL_ARRAY_SHAPE_INVALID",
  "SPECIAL_ARRAY_ITEM_INVALID", "ENGINE_REF_ENCODING_INVALID",
  "LIVE_EVENT_NOT_RESTORABLE", "VIRTUAL_CARD_NOT_RESTORABLE",
  "ARRAY_LENGTH_CHANGED", "ARRAY_UNDEFINED_OR_HOLE",
  "UNSUPPORTED_OBJECT", "STRUCTURE_TYPE_CHANGED",
  "DEFINED_FIELD_TRUNCATED", "UNDEFINED_PROPERTY_CHANGED",
  "UNEXPECTED_OUTPUT_FIELD", "AUDIT_FAILED"
]);

export function auditV3PlayerHistory({stat, actionHistory, skipList}, serialize, itemtype) {
  if (typeof serialize !== "function" || typeof itemtype !== "function") {
    return {ok:false,code:"HIST_ENGINE_SERIALIZER_UNAVAILABLE",execution:null};
  }
  const raw={stat,actionHistory,skipList};
  const execution={};
  for (const [field,label] of FIELDS) {
    if (!Array.isArray(raw[field])) {
      return {ok:false,code:"HIST_"+label+"_NOT_ARRAY",execution:null};
    }
    let encoded;
    try {
      // Deep-copy the stringified engine representation; never store raw
      // live objects or execute serialized functions/events.
      encoded=JSON.parse(JSON.stringify(serialize(raw[field])));
    } catch {
      return {ok:false,code:"HIST_"+label+"_ENCODING_FAILED",execution:null};
    }
    let audit;
    try {
      audit=auditV3Serialization(raw[field],encoded,itemtype);
    } catch {
      return {ok:false,code:"HIST_"+label+"_AUDIT_FAILED",execution:null};
    }
    if (!audit.ok) {
      const detail=AUDIT_CODES.has(audit.code) ? audit.code : "AUDIT_FAILED";
      return {ok:false,code:"HIST_"+label+"_"+detail,execution:null};
    }
    execution[field]=encoded;
  }
  return {ok:true,code:null,execution,restorable:false};
}
