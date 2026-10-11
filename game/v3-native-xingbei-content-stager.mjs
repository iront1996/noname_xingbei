/**
 * V3 offboard-only native XingBei content stage.
 *
 * Imports the ORIGINAL XingBei card definition and the original character
 * ESM packs, without changing their sources or any V1/V2 entrypoint.
 * Intended for an isolated, fresh managed Chromium profile.
 *
 * Staging content != starting game.phaseLoop()/skills.
 */
const error=code=>Object.assign(new Error(code),{code});
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(v);
const PACKS=Object.freeze(['poXiao','yiDuanYeHuo']);

export async function stageV3NativeXingBeiContent({core}={}){
 if(globalThis.isNonameServer!==true||!core?.game||!core?.lib||!core?._status)
  throw error('V3_OFFBOARD_CONTENT_REQUIRED');
 const {game,lib,_status}=core;
 if(game.__v3NativeContentStage)throw error('V3_CONTENT_ALREADY_STAGED');
 if(typeof game.import!=='function'||typeof lib.element?.Character!=='function')
  throw error('V3_CONTENT_NATIVE_API_MISSING');
 // Native boot() installs this file before loading any card/character packs.
 // The imported source depends on its Array.prototype.add/addArray helpers.
 // Do not invent mock polyfills: load the project's unmodified implementation.
 try{await import('/noname/init/polyfill.js')}
 catch(e){throw Object.assign(error('V3_NATIVE_POLYFILL_IMPORT_FAILED'),{cause:e})}
 if(typeof [].add!=='function'||typeof [].addArray!=='function')
  throw error('V3_NATIVE_POLYFILL_NOT_READY');

 // The original card/xingBei.js is a classic module with an unqualified
 // "game" global. Set only for the import and restore its previous descriptor.
 const prior=Object.getOwnPropertyDescriptor(globalThis,'game');
 if(prior&&!prior.configurable)throw error('V3_CONTENT_GLOBAL_CONFLICT');
 try{
  Object.defineProperty(globalThis,'game',{configurable:true,writable:false,value:game});
  await import('/card/xingBei.js');
 }catch(e){
  throw Object.assign(error('V3_NATIVE_CARD_PACK_IMPORT_FAILED'),{cause:e});
 }finally{
  if(prior)Object.defineProperty(globalThis,'game',prior);
  else delete globalThis.game;
 }
 for(const name of PACKS){
  try{
   // Real local ESM, no import from third-party or player-supplied address.
   if(name==='poXiao')await import('/character/poXiao.js');
   else if(name==='yiDuanYeHuo')await import('/character/yiDuanYeHuo.js');
  }catch(e){
   throw Object.assign(error('V3_NATIVE_CHARACTER_PACK_IMPORT_FAILED'),{cause:e});
  }
 }
 const pending=[
  ...(_status.importing?.card??[]),
  ...(_status.importing?.character??[])
 ];
 await Promise.all(pending);
 const card=lib.imported?.card?.xingBei;
 const characters=PACKS.map(name=>lib.imported?.character?.[name]);
 if(!card||!Array.isArray(card.list)||!card.card||
    characters.some(p=>!p||!p.character||!p.skill))
  throw error('V3_NATIVE_PACK_INCOMPLETE');

 const ids=new Set(),definitions=new Set();
 for(const c of card.list){
  if(!Array.isArray(c)||(c.length!==3&&c.length!==4)||
     !c.every(v=>typeof v==='string')||!validId(c[2])||!card.card[c[2]])
   throw error('V3_NATIVE_CARD_DEFINITION_INVALID');
  definitions.add(c[2]);
 }
 const selected=new Map();
 for(const pack of characters){
  for(const [character,definition] of Object.entries(pack.character)){
   if(!validId(character)||ids.has(character)||!Array.isArray(definition)||
      !Array.isArray(definition[3])||!definition[3].every(validId))
    throw error('V3_NATIVE_CHARACTER_DEFINITION_INVALID');
   ids.add(character);
   selected.set(character,{pack:pack.name,definition});
  }
 }
 if(ids.size<8||card.list.length<40)
  throw error('V3_NATIVE_CONTENT_INSUFFICIENT');

 // Commit only after complete import/validation. Proxy setters convert actual
 // historical arrays to original noname.element.Character instances.
 for(const pack of characters){
  for(const [id,definition] of Object.entries(pack.character))
   lib.character[id]=definition;
  Object.assign(lib.skill,pack.skill);
  Object.assign(lib.translate,pack.translate??{});
 }
 Object.assign(lib.card,card.card);
 Object.assign(lib.translate,card.translate??{});
 lib.card.list=card.list.map(entry=>entry.slice());
 const characterIds=Array.from(ids).filter(x=>!x.startsWith('gai_')).sort();
 if(characterIds.length<8)throw error('V3_NATIVE_PLAYABLE_CHARACTERS_INSUFFICIENT');
 const frozen=Object.freeze({
  realSource:true,
  cardPack:'xingBei',
  characterPacks:PACKS.slice(),
  characterCount:ids.size,
  playableCharacterCount:characterIds.length,
  cardCount:card.list.length,
  uniqueCardNames:definitions.size
 });
 Object.defineProperty(game,'__v3NativeContentStage',{configurable:false,enumerable:false,
  value:Object.freeze({
   summary:frozen,
   rosterChoices:()=>characterIds.slice(),
   cardEntries:()=>card.list.map(x=>x.slice())
  })});
 return frozen;
}

/** Fully trusted offboard cards, never a client-supplied pile. */
export function createV3NativeDrawPile({core}={}){
 if(globalThis.isNonameServer!==true||!core?.game?.__v3NativeContentStage)
  throw error('V3_NATIVE_CONTENT_NOT_READY');
 const game=core.game;
 if(game.__v3NativeDrawPile)throw error('V3_NATIVE_DRAW_PILE_ALREADY_CREATED');
 const entries=game.__v3NativeContentStage.cardEntries();
 // The original card list contains deliberate repeated card definitions.
 // Physical copies receive independently numbered internal card IDs.
 const deck=entries.map((info,i)=>Object.freeze({
  instanceId:'v3card_'+i.toString(16).padStart(6,'0'),
  name:info[2],face:info.slice()
 }));
 for(let i=deck.length-1;i>0;i--){
  // Avoid biased modulo with rejection sampling of 32-bit WebCrypto values.
  const range=i+1,limit=Math.floor(0x100000000/range)*range;
  let n=0;
  do{
   const r=new Uint32Array(1);
   crypto.getRandomValues(r);
   n=r[0];
  }while(n>=limit);
  const index=n%range;
  [deck[i],deck[index]]=[deck[index],deck[i]];
 }
 const draw=()=>deck.pop()??null;
 const pile=Object.freeze({draw,remaining:()=>deck.length,
  inspectIds:()=>deck.map(c=>c.instanceId)});
 Object.defineProperty(game,'__v3NativeDrawPile',{configurable:false,
  enumerable:false,value:pile});
 return pile;
}
