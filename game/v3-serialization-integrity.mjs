/**
 * V3 cold-host candidate integrity audit.
 * Checks loss of defined nested fields caused by get.stringifiedResult's
 * level=8 recursion limit. Does not return or log confidential contents.
 * Unlike a permissive JSON roundtrip, it rejects truncated live structures.
 */
const MAX_NODES = 100000;
const MAX_DEPTH = 32;
const SPECIAL_ITEM_TYPES = new Map([
  ["card", "_noname_card:"],
  ["player", "_noname_player:"],
  ["event", "_noname_event:"],
  ["vcard", "_noname_vcard:"],
]);

function reject(code, totals) {
  return {ok:false,code,...totals,restorable:false};
}
function valuesToAudit(base, keys) {
  return keys.every(k=>base && Object.prototype.hasOwnProperty.call(base,k));
}
/**
 * @param {*} original unconverted get.arenaState/get.skillState/etc
 * @param {*} encoded get.stringifiedResult(original) before JSON roundtrip
 * @param {(value:unknown)=>string} itemtype engine get.itemtype
 */
export function auditV3Serialization(original, encoded, itemtype) {
  const totals={
    checkedNodes:0,
    omittedUndefinedProperties:0,
    encodedCardRefs:0,
    encodedPlayerRefs:0,
    encodedOtherSpecial:0,
    lostDefinedFields:0,
    unsupportedFunctions:0,
    maxObservedDepth:0
  };
  if (typeof itemtype !== "function") return reject("ITEMTYPE_UNAVAILABLE",totals);
  function scan(raw,out,depth) {
    totals.checkedNodes++;
    totals.maxObservedDepth=Math.max(depth,totals.maxObservedDepth);
    if(totals.checkedNodes>MAX_NODES||depth>MAX_DEPTH)throw Error("DEPTH_OR_NODE_LIMIT");
    if (raw === undefined) return;
    if (typeof raw==="function") {
      totals.unsupportedFunctions++;
      throw Error("EXECUTABLE_FUNCTION_NOT_RESTORABLE");
    }
    if (typeof raw==="number" && !Number.isFinite(raw)) {
      if(raw===Infinity && out==="_noname_infinity")return;
      throw Error("NUMBER_LOSS");
    }
    if(raw===null||typeof raw!=="object"){
      if(!Object.is(raw,out))throw Error("PRIMITIVE_VALUE_CHANGED");
      return;
    }
    const type=itemtype(raw);
    if(type==="cards"||type==="players"||type==="vcards"){
      if(!Array.isArray(out)||out.length!==raw.length)throw Error("SPECIAL_ARRAY_SHAPE_INVALID");
      const expected=type.slice(0,-1);
      for(let i=0;i<raw.length;i++){
        if(itemtype(raw[i])!==expected)throw Error("SPECIAL_ARRAY_ITEM_INVALID");
        scan(raw[i],out[i],depth+1);
      }
      return;
    }
    if(SPECIAL_ITEM_TYPES.has(type)){
      const tag=SPECIAL_ITEM_TYPES.get(type);
      if(typeof out!=="string"||!out.startsWith(tag))throw Error("ENGINE_REF_ENCODING_INVALID");
      if(type==="event")throw Error("LIVE_EVENT_NOT_RESTORABLE");
      if(type==="vcard")throw Error("VIRTUAL_CARD_NOT_RESTORABLE");
      totals[type==="card"?"encodedCardRefs":"encodedPlayerRefs"]++;
      return;
    }
    if(Array.isArray(raw)){
      if(!Array.isArray(out)||raw.length!==out.length)throw Error("ARRAY_LENGTH_CHANGED");
      for(let i=0;i<raw.length;i++){
        if(!Object.prototype.hasOwnProperty.call(raw,i)||raw[i]===undefined){
          throw Error("ARRAY_UNDEFINED_OR_HOLE");
        }
        scan(raw[i],out[i],depth+1);
      }
      return;
    }
    if(Object.prototype.toString.call(raw)!=="[object Object]"){
      throw Error("UNSUPPORTED_OBJECT");
    }
    if(!out || typeof out!=="object"||Array.isArray(out)){
      throw Error("STRUCTURE_TYPE_CHANGED");
    }
    for(const key of Object.keys(raw)){
      if(raw[key]===undefined){
        if(!Object.prototype.hasOwnProperty.call(out,key)){
          totals.omittedUndefinedProperties++;
          continue;
        }
        throw Error("UNDEFINED_PROPERTY_CHANGED");
      }
      if(!Object.prototype.hasOwnProperty.call(out,key)){
        totals.lostDefinedFields++;
        throw Error("DEFINED_FIELD_TRUNCATED");
      }
      scan(raw[key],out[key],depth+1);
    }
    for(const key of Object.keys(out)){
      if(!Object.prototype.hasOwnProperty.call(raw,key)){
        throw Error("UNEXPECTED_OUTPUT_FIELD");
      }
    }
  }
  try{
    scan(original,encoded,0);
    return {ok:true,...totals,restorable:false};
  }catch(error){
    return reject(error instanceof Error?error.message:"AUDIT_FAILED",totals);
  }
}
