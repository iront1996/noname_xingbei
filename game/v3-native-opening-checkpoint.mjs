/**
 * V3-only encrypted, atomic STAGING checkpoint, NOT GameEvent recovery.
 *
 * Stores a verified original-card opening setup (players + hands + remaining
 * physical deck). Never restores native events, skills, RNG, or running turns.
 * Requires a key from an independent protected source; key is never on disk.
 */
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,stat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
const SCHEMA='xingbei-v3-native-opening-only-v1';
const err=code=>Object.assign(new Error(code),{code});
const okRoom=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
const okPlayer=s=>typeof s==='string'&&/^player_[a-f0-9]{32}$/.test(s);
const okCard=s=>typeof s==='string'&&/^v3card_[a-f0-9]{6}$/.test(s);
const okName=s=>typeof s==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(s);
const countOf=m=>({'2v2':4,'3v3':6,'4v4':8})[m]??null;

export function verifyV3NativeOpeningCheckpoint(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(k=>!['schema','roomId','seatMode','revision','totalCards','players','remainingCardIds'].includes(k))||
    input.schema!==SCHEMA||!okRoom(input.roomId)||
    !countOf(input.seatMode)||!Number.isSafeInteger(input.revision)||input.revision<1||
    !Number.isSafeInteger(input.totalCards)||input.totalCards<32||input.totalCards>1000||
    !Array.isArray(input.players)||input.players.length!==countOf(input.seatMode)||
    !Array.isArray(input.remainingCardIds))
  return Object.freeze({ok:false,code:'CHECKPOINT_SHAPE_INVALID',restorable:false});
 const names=new Set(),players=new Set(),cards=new Set();
 for(let i=0;i<input.players.length;i++){
  const p=input.players[i];
  if(!p||typeof p!=='object'||Array.isArray(p)||
     Object.keys(p).some(k=>!['seat','playerId','character','hand'].includes(k))||
     p.seat!==i||!okPlayer(p.playerId)||players.has(p.playerId)||
     !okName(p.character)||names.has(p.character)||
     !Array.isArray(p.hand)||p.hand.length!==4)
   return Object.freeze({ok:false,code:'CHECKPOINT_PLAYER_INVALID',restorable:false});
  names.add(p.character);players.add(p.playerId);
  for(const c of p.hand){
   if(!c||typeof c!=='object'||Array.isArray(c)||
      Object.keys(c).some(k=>!['cardId','name'].includes(k))||
      !okCard(c.cardId)||!okName(c.name)||cards.has(c.cardId))
    return Object.freeze({ok:false,code:'CHECKPOINT_CARD_INVALID',restorable:false});
   cards.add(c.cardId);
  }
 }
 for(const c of input.remainingCardIds){
  if(!okCard(c)||cards.has(c))
   return Object.freeze({ok:false,code:'CHECKPOINT_REMAINING_CARD_INVALID',restorable:false});
  cards.add(c);
 }
 if(cards.size!==input.totalCards||
    Array.from(cards).some(c=>parseInt(c.slice(7),16)>=input.totalCards)||
    input.remainingCardIds.length!==input.totalCards-4*input.players.length)
  return Object.freeze({ok:false,code:'CHECKPOINT_CARD_SET_INCOMPLETE',restorable:false});
 return Object.freeze({ok:true,code:'OPENING_CHECKPOINT_VALID',restorable:false,
  nativeGameEventRestorable:false,seatCount:players.size,totalCards:cards.size});
}
const clone=v=>JSON.parse(JSON.stringify(v));
export function createV3NativeOpeningCheckpointStore({directory,key}={}){
 if(!isAbsolute(directory??'')||!Buffer.isBuffer(key)||key.length!==32)
  throw err('CHECKPOINT_STORE_CONFIG_INVALID');
 const dir=resolve(directory);
 const secret=Buffer.from(key);
 const revisions=new Map();
 const file=roomId=>join(dir,roomId+'.v3opening');
 const aad=roomId=>Buffer.from(SCHEMA+':'+roomId,'utf8');
 const secure=async()=>{
  await mkdir(dir,{recursive:true,mode:0o700});
  const info=await stat(dir);
  if(!info.isDirectory())throw err('CHECKPOINT_STORE_NOT_DIRECTORY');
 };
 return Object.freeze({
  async save(input){
   const status=verifyV3NativeOpeningCheckpoint(input);
   if(!status.ok)throw err(status.code);
   if(revisions.has(input.roomId)&&input.revision<=revisions.get(input.roomId))
    throw err('CHECKPOINT_STALE_REVISION');
   await secure();
   const nonce=randomBytes(12);
   const cipher=createCipheriv('aes-256-gcm',secret,nonce);
   cipher.setAAD(aad(input.roomId));
   const plaintext=Buffer.from(JSON.stringify(input),'utf8');
   if(plaintext.length>65536)throw err('CHECKPOINT_TOO_LARGE');
   const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
   const blob=JSON.stringify({
    schema:SCHEMA,roomId:input.roomId,nonce:nonce.toString('base64'),
    ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')
   });
   const temp=join(dir,'.'+input.roomId+'.'+randomBytes(8).toString('hex')+'.tmp');
   let handle;
   try{
    handle=await open(temp,'wx',0o600);
    await handle.writeFile(blob,'utf8');
    await handle.sync();
    await handle.close();handle=null;
    await rename(temp,file(input.roomId));
    // Best-effort synchronize containing directory for crash consistency.
    const dh=await open(dir,'r');
    try{await dh.sync()}finally{await dh.close()}
   }catch(e){
    if(handle)await handle.close().catch(()=>{});
    await unlink(temp).catch(()=>{});
    throw err('CHECKPOINT_WRITE_FAILED');
   }
   revisions.set(input.roomId,input.revision);
   return Object.freeze({ok:true,code:'OPENING_CHECKPOINT_ENCRYPTED',
    roomId:input.roomId,revision:input.revision,restorable:false});
  },
  async load(roomId){
   if(!okRoom(roomId))throw err('CHECKPOINT_ROOM_INVALID');
   let raw;
   try{raw=await readFile(file(roomId),'utf8')}
   catch(e){if(e?.code==='ENOENT')return null;throw err('CHECKPOINT_READ_FAILED')}
   if(raw.length>150000)throw err('CHECKPOINT_RECORD_TOO_LARGE');
   let record;
   try{record=JSON.parse(raw)}catch{throw err('CHECKPOINT_RECORD_INVALID')}
   if(record?.schema!==SCHEMA||record?.roomId!==roomId||
      !['nonce','ciphertext','tag'].every(k=>typeof record[k]==='string'))
    throw err('CHECKPOINT_RECORD_INVALID');
   let decoded;
   try{
    const nonce=Buffer.from(record.nonce,'base64');
    const tag=Buffer.from(record.tag,'base64');
    if(nonce.length!==12||tag.length!==16)throw err('CHECKPOINT_CRYPTO_FIELDS_INVALID');
    const decipher=createDecipheriv('aes-256-gcm',secret,nonce);
    decipher.setAAD(aad(roomId));
    decipher.setAuthTag(tag);
    decoded=JSON.parse(Buffer.concat([
     decipher.update(Buffer.from(record.ciphertext,'base64')),decipher.final()
    ]).toString('utf8'));
   }catch{throw err('CHECKPOINT_AUTHENTICATION_FAILED')}
   const status=verifyV3NativeOpeningCheckpoint(decoded);
   if(!status.ok||decoded.roomId!==roomId)throw err('CHECKPOINT_PAYLOAD_INVALID');
   revisions.set(roomId,Math.max(revisions.get(roomId)??0,decoded.revision));
   return Object.freeze({code:'OPENING_CHECKPOINT_READ_ONLY',value:clone(decoded),
    status,restorable:false});
  },
  async remove(roomId){
   if(!okRoom(roomId))throw err('CHECKPOINT_ROOM_INVALID');
   try{await unlink(file(roomId));revisions.delete(roomId);return true}
   catch(e){if(e?.code==='ENOENT')return false;throw err('CHECKPOINT_DELETE_FAILED')}
  },
  schema:SCHEMA
 });
}
