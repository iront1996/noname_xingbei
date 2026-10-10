/**
 * V3-only inert resource observation capsule, NOT a recovery checkpoint.
 * Retains exact observed public scalar totals and anonymous slot treatment
 * counts. No player identifiers, cards, event objects, skills, or secrets.
 */
export const V3_XINGBEI_RESOURCE_SCHEMA="xingbei-v3-resource-evidence-1";
const SCALAR_KEYS=[
 "redMorale","blueMorale","redGrails","blueGrails",
 "redGem","redCrystal","blueGem","blueCrystal","deck","discard"
];
const CAPSULE_KEYS=[
 "schema","capturedAt","scalars","treatments",
 "playerSeatsBound","cardOrderCaptured","playerSkillStateCaptured",
 "eventContinuationCaptured","stateCheckpointAtomic",
 "safeCheckpointCertified","restorable","readyToResume"
];
const BOUNDS={redMorale:[-1000,100000],blueMorale:[-1000,100000],
 redGrails:[0,100000],blueGrails:[0,100000],
 redGem:[0,64],redCrystal:[0,64],blueGem:[0,64],blueCrystal:[0,64],
 deck:[0,200000],discard:[0,200000]};
const FLAGS=["playerSeatsBound","cardOrderCaptured","playerSkillStateCaptured",
 "eventContinuationCaptured","stateCheckpointAtomic",
 "safeCheckpointCertified","restorable","readyToResume"];
function own(obj,key){
 const d=obj && Object.getOwnPropertyDescriptor(obj,key);
 if(!d||!("value" in d))throw Error("RESOURCE_ACCESSOR_REJECTED");
 return d.value;
}
function exact(obj,keys){
 return obj!==null&&typeof obj==="object"&&!Array.isArray(obj)&&
   Object.keys(obj).length===keys.length&&
   Object.keys(obj).every(k=>keys.includes(k));
}
function validNumber(v,min,max){
 return Number.isSafeInteger(v)&&v>=min&&v<=max;
}
function refuse(code){return {ok:false,code,capsule:null,restorable:false,readyToResume:false}}
function validScalars(obj){
 if(!exact(obj,SCALAR_KEYS))return false;
 for(const k of SCALAR_KEYS){
   const value=own(obj,k);
   if(!validNumber(value,...BOUNDS[k]))return false;
 }
 if(own(obj,"redGem")+own(obj,"redCrystal")>64 ||
    own(obj,"blueGem")+own(obj,"blueCrystal")>64)return false;
 return true;
}
function validTreatments(list){
 if(!Array.isArray(list)||list.length<2||list.length>8)return false;
 for(let i=0;i<list.length;i++){
   if(!validNumber(own(list,String(i)),0,100000))return false;
 }
 return true;
}
export function buildV3XingbeiResourceEvidence(sample,capturedAt) {
 try{
   if(!validNumber(capturedAt,1,9000000000000000) ||
      !sample || !Array.isArray(sample.seats) ||
      sample.seats.length<2 || sample.seats.length>8)return refuse("RESOURCE_SAMPLE_INVALID");
   const scalars={};
   for(const k of SCALAR_KEYS)scalars[k]=own(sample,k);
   if(!validScalars(scalars))return refuse("RESOURCE_SCALARS_INVALID");
   const treatments=sample.seats.map(s=>own(s,"treatment"));
   if(!validTreatments(treatments))return refuse("RESOURCE_TREATMENTS_INVALID");
   // Only the explicitly whitelisted numeric snapshot is serialized.
   const capsule=Object.freeze({
     schema:V3_XINGBEI_RESOURCE_SCHEMA,capturedAt,
     scalars:Object.freeze(scalars),
     treatments:Object.freeze(treatments),
     playerSeatsBound:false,cardOrderCaptured:false,
     playerSkillStateCaptured:false,eventContinuationCaptured:false,
     stateCheckpointAtomic:false,safeCheckpointCertified:false,
     restorable:false,readyToResume:false
   });
   return {ok:true,code:"RESOURCE_INERT_SAMPLE_BUILT",capsule,
     restorable:false,readyToResume:false};
 }catch{return refuse("RESOURCE_SAMPLE_UNTRUSTED")}
}
export function verifyV3XingbeiResourceEvidence(value) {
 try{
   if(!exact(value,CAPSULE_KEYS) ||
      own(value,"schema")!==V3_XINGBEI_RESOURCE_SCHEMA ||
      !validNumber(own(value,"capturedAt"),1,9000000000000000) ||
      !validScalars(own(value,"scalars")) ||
      !validTreatments(own(value,"treatments")) ||
      FLAGS.some(k=>own(value,k)!==false))
     return refuse("RESOURCE_EVIDENCE_INVALID");
   // Serialize only after strict white-list validation, verifying roundtrip.
   const rebuilt={
     schema:V3_XINGBEI_RESOURCE_SCHEMA,capturedAt:own(value,"capturedAt"),
     scalars:Object.fromEntries(SCALAR_KEYS.map(k=>[k,own(value.scalars,k)])),
     treatments:own(value,"treatments").slice(),
     ...Object.fromEntries(FLAGS.map(k=>[k,false]))
   };
   if(JSON.stringify(rebuilt)!==JSON.stringify(value))return refuse("RESOURCE_EVIDENCE_NONCANONICAL");
   return Object.freeze({
     ok:true,code:"RESOURCE_INERT_EVIDENCE_VERIFIED",
     seatCount:rebuilt.treatments.length,
     totalCardsInPublicPiles:rebuilt.scalars.deck+rebuilt.scalars.discard,
     capturedAt:rebuilt.capturedAt,
     restorable:false,readyToResume:false
   });
 }catch{return refuse("RESOURCE_EVIDENCE_INVALID")}
}
