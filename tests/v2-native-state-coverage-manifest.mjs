import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../docs/xingbei-native-state-coverage-v1.json", import.meta.url), "utf8"));

test("native state coverage manifest cannot claim a seed or complete schema while unsupported families remain", () => {
	assert.equal(manifest.schema, "xingbei_native_state_coverage_v1");
	assert.equal(manifest.status, "incomplete");
	assert.equal(manifest.fullCanonicalStateEligible, false);
	assert.equal(manifest.seedAuthorized, false);
	assert.equal(manifest.authorityStateRevision, 4);
	assert.equal(manifest.event5Enabled, false);
	assert.equal(manifest.checkpointAvailable, false);
	assert.equal(manifest.unknownStatePolicy, "fail_closed");
	const resourceAudit = manifest.resourceTransitionAudit;
	assert.equal(resourceAudit.status, "source_reviewed_runtime_transition_unverified");
	assert.deepEqual(resourceAudit.transitions.map(transition => transition.id), [
		"team_morale", "xingbei_cup", "achievement_resources", "healing_resource", "nengliang_resources", "hp_damage_recovery",
	]);
	for (const transition of resourceAudit.transitions) {
		assert.equal(transition.status, "unsupported", `${transition.id} cannot be promoted from source inspection alone`);
		assert.equal(transition.supportedBoundary, null);
		assert.ok(transition.nativeSources.length > 0);
		assert.match(transition.nativeLifecycle, /native|event|change|mutate/);
		assert.ok(transition.reason.length > 40);
	}
	assert.deepEqual(resourceAudit.promotionRequires, [
		"legal native XingBei action or skill creates the event",
		"same-root parent/child completion evidence brackets the state change",
		"before/after values are captured at a supported native fence",
		"atomic private commitment changes only when the native state changes",
		"negative stale-event, wrong-seat, unfinished-child and replay tests pass",
	]);
	assert.equal(resourceAudit.authorityEvent5Created, false);
	assert.equal(resourceAudit.authorityRevision, 4);
	assert.deepEqual(resourceAudit.nativePathCandidates.map(candidate => [candidate.resource, candidate.skill, candidate.status]), [
		["achievement_resources", "jiRi_moBaoChongJie", "candidate_not_runtime_verified"],
		["achievement_resources", "_gongJiXingShi", "source_definition_only"],
		["healing_resource", "shengJi", "native_post_transition_path_verified_atomic_pair_pending"],
	]);
	assert.ok(resourceAudit.nativePathCandidates.every(candidate => candidate.nativeSource && candidate.requiredNativePath && candidate.blocker),
		"source candidates must retain an explicit unverified state and a blocker");
	const dynamicAudit = manifest.dynamicStateSourceAudit;
	assert.equal(dynamicAudit.status, "source_reviewed_not_canonicalized");
	assert.match(dynamicAudit.promotionRule, /creation, mutation, expiry\/removal, rule impact/);
	assert.deepEqual(dynamicAudit.families.map(family => family.id), ["temporary_skills", "additional_skills", "player_when_dynamic_effects",
		"marks_and_rule_storage", "extra_xingdong_payloads", "virtual_card_material_links"]);
	for (const family of dynamicAudit.families) {
		assert.equal(family.status, "unsupported", `${family.id} has no complete typed lifecycle extractor`);
		assert.ok(family.nativeSources.length && family.lifecycle && family.futureRuleImpact && family.safeFence && family.blocker);
		assert.equal(family.canonicalRepresentation, null, `${family.id} must not use a placeholder canonical value`);
	}
	const schemaAudit = manifest.schemaV2FieldAudit;
	assert.equal(schemaAudit.schema, "xingbei_authority_state_v2");
	assert.equal(schemaAudit.status, "projection_contract_only_incomplete_sources");
	assert.equal(schemaAudit.fullCanonicalStateEligible, false);
	const allMappedFields = schemaAudit.groups.flatMap(group => group.fields);
	assert.equal(new Set(allMappedFields).size, allMappedFields.length, "schema v2 fields must map exactly once");
	const expectedSchemaFields = [
		"schema", "schemaVersion", "roomId", "rootInstanceId", "authorityEventSequence", "authorityStateRevision", "firstActSeatId",
		"turn.currentSeatId", "turn.roundNumber", "turn.phaseNumber", "turn.phase", "turn.actionIndex", "turn.quotas.gongJiOrFaShu",
		"turn.quotas.faShu", "turn.quotas.gongJi", "turn.quotas.extraXingDongCount",
		"resources.hongShiQi", "resources.lanShiQi", "resources.hongXingBei", "resources.lanXingBei", "resources.hongZhanJiCount",
		"resources.hongZhanJiCommitment", "resources.lanZhanJiCount", "resources.lanZhanJiCommitment",
		"cardZones.drawCount", "cardZones.drawCommitment", "cardZones.discardCount", "cardZones.discardCommitment",
		"cardZones.orderingCount", "cardZones.orderingCommitment", "cardZones.specialCount", "cardZones.specialCommitment",
		"seats[].seatId", "seats[].position", "seats[].character", "seats[].side", "seats[].alive", "seats[].hp", "seats[].maxHp",
		"seats[].zhiLiao", "seats[].hujia", "seats[].handCount", "seats[].handCommitment", "seats[].equipmentCount",
		"seats[].equipmentCommitment", "seats[].judgmentCount", "seats[].judgmentCommitment", "seats[].expansionCount",
		"seats[].expansionCommitment", "seats[].specialCount", "seats[].specialCommitment", "seats[].nengLiangCommitment",
		"seats[].skillStateCommitment", "seats[].marksCommitment",
	].sort();
	assert.deepEqual([...allMappedFields].sort(), expectedSchemaFields, "schema-v2 mapping must cover every validator field with no omissions");
	for (const group of schemaAudit.groups) {
		assert.ok(["partial", "unsupported"].includes(group.status));
		for (const key of ["path", "nativeSource", "extractor", "fence", "canonicalEncoding", "invariants", "linuxEvidence", "blocker"])
			assert.ok(group[key], `${group.path} must state ${key}`);
	}
	assert.equal(schemaAudit.groups.find(group => group.path === "turn.roundNumber,turn.actionIndex").status, "unsupported");
	assert.equal(schemaAudit.groups.find(group => group.path === "resources.*").status, "unsupported");
	assert.equal(schemaAudit.groups.find(group => group.path === "seats.hujia").status, "unsupported");
	assert.ok(Array.isArray(manifest.families) && manifest.families.length >= 8);
	const ids = manifest.families.map(family => family.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const family of manifest.families) {
		assert.ok(["partial", "unsupported"].includes(family.status), `${family.id} must not silently become complete`);
		assert.ok(Array.isArray(family.nativeSources) && family.nativeSources.length > 0, `${family.id} must identify its source`);
		assert.ok(Array.isArray(family.unsupported) && family.unsupported.length > 0, `${family.id} must identify its gaps`);
		if (family.status === "unsupported") assert.equal(family.supportedBoundary, null);
	}
	const hujia = manifest.families.find(family => family.id === "hujia");
	assert.equal(hujia.requiresNativeRuleChangeAuthorization, true);
	assert.deepEqual(hujia.sourceAudit, {
		damagePath: "changeHp content computes absorbed amount from player.hujia then invokes player.changeHujia(-event.hujia)",
		buffPath: "Player.getBuff case 3 invokes this.changeHujia()",
		repositoryDefinitionSearch: "no changeHujia method definition or prototype assignment found in the tracked source tree; references are call sites and diagnostics only",
		historyBoundary: "the earliest tracked player.js revision is dba1d323a530453f09fcaaec776c706eba54e1fd; that baseline also has no changeHujia definition, while content.js contains the moved-to-changeHp comment and call sites",
		runtimeEvidence: {
		linuxCiRunId: "39066874592",
		probe: "managed Chromium four-seat native phaseOver fence",
		methodPresent: false,
		valuePresent: false,
		prototypeOwnerCount: 0,
		scope: "observed for the four tested Players in this managed runtime boundary; not evidence for every possible loading mode or armor behavior",
	},
	interpretation: "tracked source history and the tested managed Chromium runtime both lack the method/value at the reviewed boundary; do not infer armor mutation semantics or repair without explicit native-rule authorization",
	});
	const dynamic = manifest.families.find(family => family.id === "dynamic_skills_storage_and_effects");
	assert.equal(dynamic.status, "unsupported");
	assert.deepEqual(dynamic.sourceAudit, {
		tempSkills: "Player.addTempSkill stores a skill-keyed expiry that may be a trigger descriptor or function; GameEvent.trigger removes expired entries and removes the skill",
		additionalSkills: "Player.addAdditionalSkill/addAdditionalSkills mutate skill-keyed strings or arrays, affecting getSkills and later trigger/legality evaluation",
		when: "Player.when creates a random player_when skill with dynamic filter/content/vars and may retain closures or generated functions; trigger completion removes that skill and its lib.skill/translation entries",
		extraXingDong: "xingDong step 0 resets the queue; Player.addExtraXingDong and native skills can push payload objects; step 4 pops them LIFO and calls the named native action with the payload",
		extraXingDongPayload: "payload may contain xingDong, prompt, forced, filterCard, filterTarget and createDialog; callback fields and arbitrary object spread prevent a generic canonical representation",
		markStorage: "reviewed guiHuo is a bounded special case only; general marks are read from heterogeneous player.storage and player.marks includes UI state",
		canonicalizationDecision: "no general extractor accepted; preserve unsupported and fail closed until each rule-relevant family has a typed allowlist, lifetime boundary and native evidence",
	});
	const turn = manifest.families.find(family => family.id === "turn_and_action_quotas");
	assert.equal(turn.status, "partial");
	assert.match(turn.supportedBoundary, /two distinct completed native seat phases/);
	assert.deepEqual(turn.verifiedEvidence, {
		linuxCiRunId: "39061677334",
		workflowStep: 33,
		completedSeatCount: 2,
		acceptedCaptureCountIncludingStableRepeats: 4,
		nativeCompletionOrdinals: [112, 223],
		inputGateQuotaReset: {
			linuxCiRunId: "39063275363",
			workflowStep: "V2 M2 C3 authority Event 1-4 same-session and Chromium-chain audit",
			nativeEvent: "xingDong",
			nativeStep: 0,
			quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			actorBoundToPendingAction: true,
			observationIsAtomicCapture: false,
		},
		completedPhaseQuotaConsumption: {
			linuxCiRunId: "39063275363",
			workflowStep: "V2 M2 T3-B1 ledger plus restricted atomic capture across a real four-seat action",
			nativeCompletionOrdinal: 112,
			consumedQuotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 },
		},
		authorityStateRevision: 4,
		event5Enabled: false,
	});
	assert.deepEqual(turn.nativeQuotaBoundaryEvidence, {
		linuxCiRunId: "39063275363",
		pendingInputGate: {
			workflowStep: "V2 M2 C3 authority Event 1-4 same-session and Chromium-chain audit",
			eventName: "xingDong",
			eventStep: 0,
			quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			actorBoundToPendingNativeAction: true,
			atomicCapture: false,
		},
		completedPhaseFence: {
			workflowStep: "V2 M2 T3-B1 ledger plus restricted atomic capture across a real four-seat action",
			nativeCompletionOrdinal: 112,
			quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
		},
		scope: "observed native reset and consumed values only; not general quota semantics",
	});
	assert.deepEqual(turn.crossSeatPhaseAndQuotaBoundary, {
		linuxCiRunId: "39065347253",
		workflowStep: "V2 M2 T3 cross-seat repeated native atomic capture in real Chromium",
		sameRoomSessionHostChromiumRootBuildAndImmutableSeats: true,
		gameMeAbsent: true,
		connectedPlayerTransports: 0,
		seats: [
			{
				seatId: "native_seat_2",
				nativeCompletionOrdinal: 112,
				gamePhaseNumber: 1,
				completedPlayerPhaseNumber: 1,
				completedQuotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			},
			{
				seatId: "native_seat_3",
				nativeCompletionOrdinal: 223,
				gamePhaseNumber: 2,
				completedPlayerPhaseNumber: 1,
				completedQuotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			},
		],
		secondSeatResetObservation: {
			eventName: "xingDong",
			eventStep: 1,
			parentEventName: "phase",
			observedAfterNativeStepZeroCompleted: true,
			boundToSecondCompletedSeatPhase: true,
			sameRootInstance: true,
			quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			observationIsAtomicCapture: false,
		},
		acceptedAtomicCaptureOrdinals: [1, 2, 3, 4],
		captureBoundaryOrdinals: [1, 2],
		projectionCountPerEnvelope: 3,
		sameFenceRepeatsStable: true,
		authorityStateRevision: 4,
		event5Enabled: false,
		checkpointAvailable: false,
		scope: "two adjacent native seat phases only; global game.phaseNumber advanced once and each seat's player.phaseNumber initialized once; the second-seat xingDong step-1 quota reset is a separate non-atomic observation, not general quota semantics",
	});
	assert.match(turn.unsupported[0], /arbitrary multi-turn capture/);
	assert.match(turn.unsupported[2], /all quota reset\/decrement and round-boundary semantics/);
	assert.equal(turn.verifiedEvidence.inputGateQuotaReset.observationIsAtomicCapture, false,
		"live input-gate observation must not be misrepresented as an atomic canonical snapshot");
});
