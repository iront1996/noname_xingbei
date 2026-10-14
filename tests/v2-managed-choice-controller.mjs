import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require=createRequire(import.meta.url); const {createManagedChoiceController}=require("../game/server-managed-choice-controller.js");
const roomId="choice_room",hostSessionId=`hs_${"a".repeat(32)}`,seatId="seat_1",nativeEventId="native_character_pick_0001";
function fixture(extra={}){let now=1000,byte=0;const timers=new Map(),resolved=[];const c=createManagedChoiceController({now:()=>now,randomBytes:n=>Buffer.alloc(n,++byte),isHostSessionActive:(r,s)=>r===roomId&&s===hostSessionId,authenticateSeat:(m,r)=>m.credential===r.seatId,authorizeManagedHost:r=>r.hostProof===r.hostSessionId,authorizeSeatBinding:r=>r.serverProof===r.connectionId,schedule:(fn,ms)=>{const id=++byte;timers.set(id,{fn,at:now+ms});return id},cancel:id=>timers.delete(id),onResolved:r=>resolved.push(r),...extra});const open=o=>c.openChoice({protocol:1,roomId,hostSessionId,seatId,nativeEventId,eventSequence:2,options:["a","b"],trusteeOption:"b",deadlineAt:2000,hostProof:hostSessionId,...o});const bind=(id="conn_1",o={})=>c.bindSeatConnection({roomId,seatId,connectionId:id,serverProof:id,...o});const submit=(id,o={})=>c.submitChoice({protocol:1,roomId,hostSessionId,seatId,nativeEventId,eventSequence:2,choiceId:id,connectionId:"conn_1",credential:seatId,option:"a",...o});return{c,open,bind,submit,resolved,advance:v=>{now=v;for(const [id,t]of[...timers])if(t.at<=now){timers.delete(id);t.fn()}}}}
test("only trusted host and server seat flow may create or bind a choice",()=>{const f=fixture();assert.equal(f.open({hostProof:"forged"}).code,"MANAGED_CHOICE_OPEN_REJECTED");const x=f.open();assert.equal(x.ok,true);assert.equal(f.open().code,"MANAGED_CHOICE_NATIVE_EVENT_EXISTS");assert.match(x.choice.choiceId,/^choice_[a-f0-9]{32}$/);assert.equal(f.bind("conn_1",{serverProof:"forged"}).code,"MANAGED_CHOICE_CONNECTION_REJECTED");assert.equal(f.bind().ok,true);for(const bad of [{seatId:"seat_2"},{option:"forged"},{credential:"forged"},{connectionId:"old_conn"},{eventSequence:3},{nativeEventId:"native_wrong_event_0001"}])assert.equal(f.submit(x.choice.choiceId,bad).code,"MANAGED_CHOICE_SUBMIT_REJECTED");assert.equal(f.submit(x.choice.choiceId).ok,true);assert.equal(f.submit(x.choice.choiceId).code,"MANAGED_CHOICE_SUBMIT_REJECTED")});
test("deadline resolves once and cleanup rejects replay",()=>{const f=fixture(),x=f.open();f.bind("conn_2");f.advance(2000);assert.deepEqual(f.resolved[0].resolution,{kind:"trustee",option:"b"});assert.equal(f.submit(x.choice.choiceId,{connectionId:"conn_2"}).code,"MANAGED_CHOICE_SUBMIT_REJECTED");const y=f.open({deadlineAt:3000,nativeEventId:"native_character_pick_0002"});assert.equal(f.c.cleanupHostSession(roomId,hostSessionId).ok,true);assert.equal(f.c.pendingCount(),0);assert.equal(f.submit(y.choice.choiceId).code,"MANAGED_CHOICE_SUBMIT_REJECTED")});
test("capacity bounds pending native choices",()=>{const f=fixture({maxPendingChoices:1});assert.equal(f.open().ok,true);assert.equal(f.open().code,"MANAGED_CHOICE_CAPACITY_REJECTED");assert.equal(f.c.cleanupRoom(roomId).ok,true);assert.equal(f.c.pendingCount(),0)});
test("failed delivery stays pending until authenticated current-host ACK",()=>{let attempts=0;const delivered=[];const f=fixture({onResolved:choice=>{attempts++;if(attempts===1)throw Error("ipc");delivered.push(choice.deliveryId)},maxResolvedChoices:1});const x=f.open();f.bind();const first=f.submit(x.choice.choiceId);assert.equal(first.delivery,"pending");const record=f.c.inspect(roomId,x.choice.choiceId);assert.equal(record.state,"delivery_pending");const retried=f.c.retryDelivery({roomId,choiceId:x.choice.choiceId});assert.equal(retried.delivery,"sent");assert.deepEqual(delivered,[record.deliveryId]);const ack={protocol:1,kind:"managed_host",roomId,choiceId:x.choice.choiceId,hostSessionId,deliveryId:record.deliveryId,hostProof:hostSessionId};for(const bad of [{...ack,kind:"player"},{...ack,kind:"room_administrator"},{...ack,hostProof:"forged"},{...ack,roomId:"other_room"},{...ack,hostSessionId:`hs_${"b".repeat(32)}`},{...ack,deliveryId:"wrong"}])assert.equal(f.c.acknowledgeDelivery(bad).code,"MANAGED_CHOICE_ACK_REJECTED");assert.equal(f.c.acknowledgeDelivery(ack).ok,true);assert.equal(f.c.acknowledgeDelivery(ack).code,"MANAGED_CHOICE_ACK_REJECTED")});
test("async IPC delivery failure schedules the same immutable retry",async()=>{let attempts=0;const f=fixture({deliveryRetryMs:100,onResolved:()=>{attempts++;return attempts===1?Promise.reject(Error("ipc")):true}}),x=f.open();f.bind();f.submit(x.choice.choiceId);await Promise.resolve();f.advance(1100);assert.equal(attempts,2);const record=f.c.inspect(roomId,x.choice.choiceId);assert.equal(record.state,"delivery_pending");assert.equal(record.deliveryId,`delivery_${x.choice.choiceId}`)});

test("successful IPC without ACK retries same immutable delivery and stops after ACK", async () => {
	let attempts = 0;
	const sent = [];
	const f = fixture({ deliveryRetryMs: 100, onResolved: choice => { attempts++; sent.push(choice); return true; } });
	const opened = f.open(); f.bind(); f.submit(opened.choice.choiceId);
	await Promise.resolve(); await Promise.resolve();
	f.advance(1100);
	assert.equal(attempts, 2);
	assert.equal(sent[0].deliveryId, sent[1].deliveryId);
	assert.equal(sent[0].choiceId, sent[1].choiceId);
	assert.deepEqual(sent[0].resolution, sent[1].resolution);
	const latest = f.c.inspect(roomId, opened.choice.choiceId);
	assert.equal(f.c.acknowledgeDelivery({ protocol: 1, kind: "managed_host", roomId, choiceId: latest.choiceId,
		hostSessionId, deliveryId: latest.deliveryId, hostProof: hostSessionId }).ok, true);
	f.advance(5000);
	assert.equal(attempts, 2);
	assert.equal(f.c.inspect(roomId, opened.choice.choiceId).state, "resolved");
});

test("unacknowledged result delivery has bounded retries and an explicit terminal state", async () => {
	let attempts = 0;
	const f = fixture({ deliveryRetryMs: 100, maxDeliveryAttempts: 2, onResolved: () => { attempts++; return true; } });
	const opened = f.open(); f.bind(); f.submit(opened.choice.choiceId);
	await Promise.resolve(); await Promise.resolve();
	f.advance(1100);
	assert.equal(attempts, 2);
	const record = f.c.inspect(roomId, opened.choice.choiceId);
	assert.equal(record.state, "delivery_failed");
	assert.equal(record.deliveryFailureCode, "MANAGED_CHOICE_ACK_RETRY_EXHAUSTED");
	assert.equal(f.c.acknowledgeDelivery({ protocol: 1, kind: "managed_host", roomId, choiceId: record.choiceId,
		hostSessionId, deliveryId: record.deliveryId, hostProof: hostSessionId }).code, "MANAGED_CHOICE_ACK_REJECTED");
});

test("early deadline timer re-arms trustee and never strands native choice", () => {
	let clock = 1000, nextTimer = 0;
	const timers = new Map(), delivered = [];
	const controller = createManagedChoiceController({
		now: () => clock,
		isHostSessionActive: (room, session) => room === roomId && session === hostSessionId,
		authorizeManagedHost: message => message.hostProof === hostSessionId,
		schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
		cancel: id => timers.delete(id),
		onResolved: choice => delivered.push(choice),
	});
	const opened = controller.openChoice({
		protocol: 1, roomId, hostSessionId, seatId, nativeEventId, eventSequence: 2,
		options: ["a", "b"], trusteeOption: "b", deadlineAt: 2000, hostProof: hostSessionId,
	});
	assert.equal(opened.ok, true);
	const first = [...timers.entries()][0];
	assert.equal(first[1].delay, 1000);
	clock = 1999;
	timers.delete(first[0]);
	first[1].fn(); // Simulate an early timer callback, regardless of its requested delay.
	assert.equal(controller.inspect(roomId, opened.choice.choiceId).state, "pending");
	assert.equal(timers.size, 1);
	const second = [...timers.entries()][0];
	assert.equal(second[1].delay, 1);
	clock = 2000;
	timers.delete(second[0]);
	second[1].fn();
	const choice = controller.inspect(roomId, opened.choice.choiceId);
	assert.equal(choice.state, "delivery_pending");
	assert.deepEqual(choice.resolution, { kind: "trustee", option: "b" });
	assert.equal(choice.deliveryId, `delivery_${opened.choice.choiceId}`);
	assert.equal(delivered.length, 1);
	assert.equal(controller.acknowledgeDelivery({ protocol: 1, kind: "managed_host", roomId, choiceId: choice.choiceId,
		hostSessionId, deliveryId: choice.deliveryId, hostProof: hostSessionId }).ok, true);
	assert.equal(controller.expireChoice({ roomId, choiceId: opened.choice.choiceId, hostSessionId }).ok, false);
	assert.equal(timers.size, 0);
});

test("choice/deadline boundary is single-winner and never redelivers an uncertain native result", () => {
	let clock = 1999, nextTimer = 0, onResolved = 0;
	const timers = new Map();
	const controller = createManagedChoiceController({
		now: () => clock, randomBytes: n => Buffer.alloc(n, ++nextTimer),
		isHostSessionActive: (room, session) => room === roomId && session === hostSessionId,
		authorizeManagedHost: message => message.hostProof === hostSessionId,
		authenticateSeat: message => message.credential === seatId,
		authorizeSeatBinding: message => message.serverProof === message.connectionId,
		schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
		cancel: id => timers.delete(id), onResolved: () => { onResolved++; throw Error("ambiguous native delivery"); },
	});
	const opened = controller.openChoice({ protocol: 1, roomId, hostSessionId, seatId, nativeEventId,
		eventSequence: 2, options: ["a", "b"], trusteeOption: "b", deadlineAt: 2000, hostProof: hostSessionId });
	assert.equal(opened.ok, true);
	const connectionId = "conn_race";
	assert.equal(controller.bindSeatConnection({ roomId, seatId, connectionId, serverProof: connectionId }).ok, true);
	clock = 2000;
	const request = { protocol: 1, roomId, hostSessionId, nativeEventId, seatId, eventSequence: 2,
		choiceId: opened.choice.choiceId, connectionId, credential: seatId, option: "a" };
	assert.equal(controller.submitChoice(request).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	const deadlineResult = controller.expireChoice({ roomId, choiceId: opened.choice.choiceId, hostSessionId });
	assert.equal(deadlineResult.ok, true);
	assert.equal(controller.inspect(roomId, opened.choice.choiceId).state, "delivery_pending");
	assert.equal(controller.inspect(roomId, opened.choice.choiceId).resolution.kind, "trustee");
	assert.equal(onResolved, 1);
	assert.equal(controller.retryDelivery({ roomId, choiceId: opened.choice.choiceId }).ok, true);
	assert.equal(onResolved, 2, "same immutable delivery may retry, but native host must dedupe by deliveryId");
	assert.equal(controller.inspect(roomId, opened.choice.choiceId).deliveryId, `delivery_${opened.choice.choiceId}`);
	controller.cleanupHostSession(roomId, hostSessionId);
	assert.equal(controller.inspect(roomId, opened.choice.choiceId), null);
	assert.equal(timers.size, 0);
});

test("delivery retry exhaustion invokes fail-closed host hook exactly once", async () => {
	let attempts = 0, failures = 0;
	const f = fixture({ maxDeliveryAttempts: 1, onResolved: () => { attempts++; return true; }, onDeliveryFailed: failure => {
		failures++; assert.equal(failure.deliveryFailureCode, "MANAGED_CHOICE_ACK_RETRY_EXHAUSTED");
	} });
	const opened = f.open(); f.bind(); f.submit(opened.choice.choiceId);
	await Promise.resolve(); await Promise.resolve();
	assert.equal(attempts, 1);
	assert.equal(f.c.inspect(roomId, opened.choice.choiceId).state, "delivery_failed");
	assert.equal(failures, 1);
});
