"use strict";

const PRODUCTION_KIND = "webcrypto_getRandomValues_v1";
const TEST_KIND = "test_seeded_v1";

const PRODUCTION_SOURCE = `(()=>{try{if(!globalThis.crypto||typeof globalThis.crypto.getRandomValues!=='function')throw Error('MANAGED_RANDOM_SOURCE_UNAVAILABLE');const getRandomValues=globalThis.crypto.getRandomValues.bind(globalThis.crypto);let drawCount=0,failed=false;const words=new Uint32Array(2),maxDraws=10000000;const random=()=>{if(failed)throw Error('MANAGED_RANDOM_SOURCE_FAILED');if(drawCount>=maxDraws){failed=true;throw Error('MANAGED_RANDOM_DRAW_LIMIT_EXCEEDED')}try{getRandomValues(words)}catch{failed=true;throw Error('MANAGED_RANDOM_SOURCE_FAILED')}drawCount++;return (words[0]*2097152+(words[1]>>>11))/9007199254740992};Object.defineProperty(Math,'random',{value:random,writable:false,configurable:false});Object.defineProperty(window,'__v2ManagedRandomAudit',{configurable:false,value:Object.freeze({source:'webcrypto_getRandomValues_v1',get drawCount(){return drawCount},get failed(){return failed},get active(){return Math.random===random}})})}catch(error){Object.defineProperty(window,'__v2ManagedRandomFailure',{configurable:false,value:String(error?.message||'MANAGED_RANDOM_SOURCE_UNAVAILABLE').slice(0,64)})}})();`;

function createManagedRandomBootstrap(testSeed) {
	if (testSeed === undefined) return Object.freeze({ kind: PRODUCTION_KIND, source: PRODUCTION_SOURCE });
	if (!Number.isSafeInteger(testSeed) || testSeed < 0 || testSeed > 0xffffffff) {
		throw new TypeError("MANAGED_RANDOM_TEST_SEED_INVALID");
	}
	const source = `(()=>{let state=${testSeed}>>>0,drawCount=0;const random=()=>{drawCount++;state=(state+0x6D2B79F5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296};Object.defineProperty(Math,'random',{value:random,writable:false,configurable:false});Object.defineProperty(window,'__v2ManagedRandomAudit',{configurable:false,value:Object.freeze({source:'test_seeded_v1',get drawCount(){return drawCount},failed:false,get active(){return Math.random===random}})})})();`;
	return Object.freeze({ kind: TEST_KIND, source });
}

module.exports = Object.freeze({ createManagedRandomBootstrap, PRODUCTION_KIND, TEST_KIND });
