# V2 server-authority engineering guardrails

- Base all work on `feature/v2-connection-stability`; use an isolated `codex/*` branch. Never rebuild from or commit directly to `master` or the V2 base branch.
- Do not modify, deploy, restart, or stop VPS services, live V1/V2/V3 rooms, or monitoring center v2.3.0 without explicit user authorization.
- Keep V3 and unrelated branches read-only. Do not merge PRs or switch production traffic.
- Work in small, independently testable commits. Preserve V2-1 through V2-9 recovery and security tests; V2-10 remains paused.
- A simulated or local pass is not VPS compatibility, browser acceptance, real-player validation, or deployment approval. Record unverified boundaries explicitly.
- PRs target `feature/v2-connection-stability` and remain for user review.
- Final V2 authority invariant: no human player, including the room creator or administrator, may be the game host or authoritative engine. Creation/administration permissions are control-plane capabilities only; they cannot execute rules, mutate authoritative game state, declare results, or control the managed host process.
- Keep player transport loss separate from managed-host failure. Player disconnects use the uniform seat-recovery/timeout policy; managed-host crashes use the M4 checkpoint and recovery policy.
- Treat M1 `ownerResumeToken`, `resumeowner`, `room.owner`, `awaiting_host`, and `waiting_host_process` behavior as human-host compatibility only. Preserve it where useful, but do not make M2 or M3 depend on it and do not present it as the target architecture.
