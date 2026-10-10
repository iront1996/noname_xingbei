/**
 * V3 SERVER-AUTHORITY PROTOTYPE (NOT wired to production/playtest socket).
 *
 * The creator has only setup privileges. Connection lifetime does not own
 * the room. Every session, including its creator, has the same reconnect
 * mechanics. No game rules are simulated here; all gameplay intents fail
 * closed until a tested, server-side XingBei rules reducer is integrated.
 *
 * This is an isolated in-memory proof. Durable writes, private card state,
 * abilities, fair RNG, timers and server restart recovery are NOT implemented.
 */
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";

export const V3_AUTH_ROOM_SCHEMA="xingbei-v3-authoritative-lobby-prototype-1";
const MODES=Object.freeze({"2v2":4,"3v3":6,"4v4":8});
const ROOMS_MAX=256;
const idOk=v=>typeof v==="string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const reply=(ok,code,extra={})=>Object.freeze({ok,code,...extra});
const hash=v=>createHash("sha256").update(v,"utf8").digest();
const secureEquals=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&
  a.length===b.length&&timingSafeEqual(a,b);
const freshToken=()=>randomBytes(32).toString("hex");

function configValue(input){
  if(!input||typeof input!=="object"||Array.isArray(input))return null;
  // Intentionally a strict whitelisted shape for the first protocol stage.
  if(Object.keys(input).some(k=>!["mode","seatMode"].includes(k)))return null;
  const mode=Object.getOwnPropertyDescriptor(input,"mode");
  const seatMode=Object.getOwnPropertyDescriptor(input,"seatMode");
  if(!mode||!seatMode||!("value" in mode)||!("value" in seatMode))return null;
  if(mode.value!=="xingBei" || !Object.hasOwn(MODES,seatMode.value))return null;
  return Object.freeze({mode:"xingBei",seatMode:seatMode.value,
    seatCount:MODES[seatMode.value]});
}

export function createV3AuthoritativeRoomModel(){
  const rooms=new Map();
  function find(roomId){return idOk(roomId)?rooms.get(roomId):null}
  function member(room,seat){return Number.isInteger(seat)&&seat>=0?
    room.sessions.get(seat):null}
  function isConnected(m,connectionId){
    return m && idOk(connectionId) && m.connectionId===connectionId;
  }
  function roster(room){
    return Array.from(room.sessions.values(),s=>Object.freeze({
      seat:s.seat,connected:s.connectionId!==null,ready:s.ready
    }));
  }
  function publicView(room){
    return Object.freeze({
      schema:V3_AUTH_ROOM_SCHEMA,roomId:room.roomId,
      config:room.config,status:room.status,
      revision:room.revision,roster:roster(room),
      // Deliberately no owner socket, personal token, RNG, or card state.
      gameRulesLoaded:false,statePersisted:false
    });
  }
  function addSession(room,connectionId){
    if(!idOk(connectionId) ||
       Array.from(room.sessions.values()).some(s=>s.connectionId===connectionId))
      return reply(false,"CONNECTION_INVALID_OR_DUPLICATE");
    if(room.sessions.size>=room.config.seatCount ||
       room.status!=="waiting")
      return reply(false,"SEAT_UNAVAILABLE");
    const seat=room.sessions.size,token=freshToken();
    room.sessions.set(seat,{seat,connectionId,tokenHash:hash(token),ready:false});
    room.revision++;
    return reply(true,"SESSION_JOINED",{seat,reconnectToken:token,
      view:publicView(room)});
  }
  return Object.freeze({
    create({roomId,config,connectionId}={}){
      if(!idOk(roomId)||!idOk(connectionId))
        return reply(false,"ROOM_OR_CONNECTION_INVALID");
      const setting=configValue(config);
      if(!setting)return reply(false,"CONFIG_INVALID");
      if(rooms.has(roomId))return reply(false,"ROOM_EXISTS");
      if(rooms.size>=ROOMS_MAX)return reply(false,"ROOM_LIMIT");
      const room={roomId,config:setting,status:"waiting",
        revision:0,sessions:new Map()};
      rooms.set(roomId,room);
      const created=addSession(room,connectionId);
      if(!created.ok){rooms.delete(roomId);return created}
      return reply(true,"ROOM_CREATED",{seat:created.seat,
        reconnectToken:created.reconnectToken,view:publicView(room)});
    },
    join({roomId,connectionId}={}){
      const room=find(roomId);
      if(!room)return reply(false,"ROOM_NOT_FOUND");
      return addSession(room,connectionId);
    },
    disconnect({roomId,seat,connectionId}={}){
      const room=find(roomId),session=room&&member(room,seat);
      if(!session||!isConnected(session,connectionId))
        return reply(false,"SESSION_NOT_CONNECTED");
      session.connectionId=null;room.revision++;
      return reply(true,"SESSION_DISCONNECTED",{view:publicView(room)});
    },
    reconnect({roomId,seat,reconnectToken,connectionId}={}){
      const room=find(roomId),session=room&&member(room,seat);
      if(!session||!idOk(connectionId) ||
         typeof reconnectToken!=="string"||
         !/^[a-f0-9]{64}$/.test(reconnectToken) ||
         !secureEquals(hash(reconnectToken),session.tokenHash))
        return reply(false,"RECONNECT_DENIED");
      if(Array.from(room.sessions.values()).some(s=>
        s!==session&&s.connectionId===connectionId))
        return reply(false,"CONNECTION_INVALID_OR_DUPLICATE");
      // Rotating a token invalidates every prior credential and takes over
      // an old socket, without transferring game/state ownership.
      const rotated=freshToken();
      session.tokenHash=hash(rotated);
      session.connectionId=connectionId;
      room.revision++;
      return reply(true,"SESSION_RECONNECTED",{seat,
        reconnectToken:rotated,view:publicView(room)});
    },
    configure({roomId,seat,connectionId,config}={}){
      const room=find(roomId),session=room&&member(room,seat);
      if(!isConnected(session,connectionId))return reply(false,"SESSION_NOT_CONNECTED");
      if(seat!==0)return reply(false,"SETUP_PRIVILEGE_REQUIRED");
      if(room.status!=="waiting"||room.sessions.size!==1)
        return reply(false,"CONFIG_LOCKED");
      const setting=configValue(config);
      if(!setting)return reply(false,"CONFIG_INVALID");
      room.config=setting;room.revision++;
      return reply(true,"ROOM_CONFIGURED",{view:publicView(room)});
    },
    // Must not pretend that a lobby-only prototype can perform rules.
    command({roomId,seat,connectionId,action}={}){
      const room=find(roomId),session=room&&member(room,seat);
      if(!isConnected(session,connectionId))return reply(false,"SESSION_NOT_CONNECTED");
      if(typeof action!=="string"||action.length>80)
        return reply(false,"COMMAND_INVALID");
      return reply(false,"RULES_ENGINE_NOT_IMPLEMENTED");
    },
    snapshot(roomId){
      const room=find(roomId);
      return room?publicView(room):null;
    }
  });
}
