import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { createManagedRandomBootstrap, PRODUCTION_KIND, TEST_KIND } = require("../game/server-managed-random-source.js");

function run(source, crypto, onFailure = () => {}) {
	const context = { window: { __v2ManagedRandomFailureNotify: onFailure }, crypto, Math: Object.create(Math), Uint32Array, Object };
	context.globalThis = context;
	vm.runInNewContext(source, context);
	return context;
}

test("production managed random adapter uses WebCrypto and returns uniform-range Math.random values", () => {
	const samples = [[0, 0], [0xffffffff, 0xffffffff], [0x80000000, 0x80000000], [0x80000000, 0]];
	const crypto = {
		getRandomValues(words) { const pair = samples.shift(); words[0] = pair[0]; words[1] = pair[1]; return words; },
	};
	const context = run(createManagedRandomBootstrap().source, crypto);
	const audit = context.window.__v2ManagedRandomAudit;
	assert.equal(audit.source, PRODUCTION_KIND);
	assert.equal(audit.active, true);
	assert.equal(audit.failed, false);
	const values = [context.Math.random(), context.Math.random(), context.Math.random()];
	assert.equal(values[0], 0);
	assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value < 1));
	assert.ok(values[1] > 0.999999999999999);
	assert.equal(audit.drawCount, 3);
	assert.deepEqual(Object.keys(audit).sort(), ["active", "drawCount", "failed", "source"]);
	const descriptor = Object.getOwnPropertyDescriptor(context.Math, "random");
	assert.equal(descriptor.configurable, false);
	assert.equal(descriptor.writable, false);
	crypto.getRandomValues = () => { throw new Error("late replacement"); };
	assert.equal(context.Math.random(), 0.5);
});

test("production managed random adapter fails closed when WebCrypto is unavailable or fails", () => {
	const missingFailures = [];
	const missing = run(createManagedRandomBootstrap().source, undefined, code => missingFailures.push(code));
	assert.equal(missing.window.__v2ManagedRandomFailure, "MANAGED_RANDOM_SOURCE_UNAVAILABLE");
	assert.equal(missing.window.__v2ManagedRandomAudit, undefined);
	assert.deepEqual(missingFailures, ["MANAGED_RANDOM_SOURCE_UNAVAILABLE"]);

	const failures = [];
	const context = run(createManagedRandomBootstrap().source, { getRandomValues() { throw new Error("injected"); } }, code => failures.push(code));
	assert.throws(() => context.Math.random(), /MANAGED_RANDOM_SOURCE_FAILED/);
	assert.equal(context.window.__v2ManagedRandomAudit.failed, true);
	assert.throws(() => context.Math.random(), /MANAGED_RANDOM_SOURCE_FAILED/);
	assert.deepEqual(failures, ["MANAGED_RANDOM_SOURCE_FAILED"], "runtime failure notifies the managed process exactly once");
});

test("production random draw bound permanently fails closed", () => {
	const source = createManagedRandomBootstrap().source.replace("maxDraws=10000000", "maxDraws=1");
	const failures = [];
	const context = run(source, { getRandomValues(words) { words[0] = 0; words[1] = 0; return words; } }, code => failures.push(code));
	assert.equal(context.Math.random(), 0);
	assert.throws(() => context.Math.random(), /MANAGED_RANDOM_DRAW_LIMIT_EXCEEDED/);
	assert.equal(context.window.__v2ManagedRandomAudit.failed, true);
	assert.throws(() => context.Math.random(), /MANAGED_RANDOM_SOURCE_FAILED/);
	assert.deepEqual(failures, ["MANAGED_RANDOM_DRAW_LIMIT_EXCEEDED"]);
});

test("deterministic random source is explicitly labeled and isolated to valid test seeds", () => {
	const first = createManagedRandomBootstrap(17);
	const second = createManagedRandomBootstrap(17);
	assert.equal(first.kind, TEST_KIND);
	assert.equal(first.source, second.source);
	const context = run(first.source, undefined);
	assert.equal(context.window.__v2ManagedRandomAudit.source, TEST_KIND);
	assert.equal(context.window.__v2ManagedRandomAudit.failed, false);
	assert.equal(context.Math.random(), run(second.source, undefined).Math.random());
	assert.throws(() => createManagedRandomBootstrap(-1), /MANAGED_RANDOM_TEST_SEED_INVALID/);
	assert.throws(() => createManagedRandomBootstrap(0x100000000), /MANAGED_RANDOM_TEST_SEED_INVALID/);
});
