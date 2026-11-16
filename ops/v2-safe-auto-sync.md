# V2 original-source and published-release safe auto-sync

Scope: `feature/image-preload-cache` only. Do not edit original author repository,
GitHub `master`, any other V1/V3/V4/V5/V6/M2 branch, Cloudflare configuration or VPS.

## Inputs and authority

- Original source: `RancherJie/noname_xingbei` `master`.
- Original published UI: `https://rancherjie.github.io/noname_xingbei/`.
- Published resource allowlist and 11 extensions: `ops/v2-official-publication.json`.
- V2-specific differences: `mode/connect.js` V2 Hall and image preload.
- V2 current original SHA: `ops/v2-sync-state.json`.
- Runtime inventory includes published original source overlays, current tracked
  WebP/image media and all previously tracked extension runtime files.
- New executable/extension paths not in the audited inventory **are never
  auto-imported**. New code or rules require review.

## Scheduled trigger without touching GitHub default branch

GitHub Actions `schedule` runs only on the repository default branch (`master`).
To protect other versions, **do not add a fake cron to the V2 branch** and do not
change the default branch. A separately configured scheduled automation may trigger
this V2-only `push` workflow:

1. Read latest official `master` SHA, current V2 HEAD commit and its tree SHA.
2. Create one no-tree-change Git commit with the current V2 HEAD as
   its **sole parent** and exactly the same tree SHA.
3. Create a unique branch
   `v2-sync-candidate-<official-first-12>-<UTC-YYYYMMDDHH>` pointing **directly
   to that new commit**. Do not create the branch at V2 HEAD first and then
   advance it: that would trigger a redundant, failing CI run. Never use force.
4. GitHub Actions workflow `v2-upstream-controlled-auto-sync.yml` validates
   that the tick has exactly that parent/tree and that V2 HEAD is unchanged.
5. The workflow checks original Git and the live released resources, prepares an
   isolated candidate, runs source/UI/extensions/cache parity and risk classification.
6. Low-risk validated static assets/docs may fast-forward V2 only after backing
   up the previous V2 ref. Source/UI/extension/code/rules drift is held for review.
7. Confirm Cloudflare Pages actually serves the candidate's exact script and
   image-manifest bytes; if not, attempt a lease-protected revert. Never force
   history changes or overwrite another simultaneous release.

The scheduler itself is a separate service and must be **enabled**; a GitHub
branch push workflow alone does not poll on its own.

## Strict gates

- Original source and `mode/connect.js` patch: `tools/v2-upstream-sync.mjs`.
- Published source, WebP and extension bytes: `tools/v2-published-release-sync.mjs`.
- Image-cache manifest: `tools/sync-image-manifest.mjs --check`.
- Original published text parity: `tests/v2-public-site-audit.mjs`.
- Native UI, 11 bundled extensions, Hall and cache: `tests/v2-original-ui-chromium.mjs`
  and `tests/v2-live-original-ui-regression.mjs`.
- Public website or CI unavailable: fail closed; do **not** claim completed deployment.
- Never alter game mechanics or use synthetic game results to pass parity checks.

## Evidence and operations

- V2 candidate GitHub Actions logs record source and publication drift.
- `/tmp/v2-auto-sync/publication.json` is a CI-only, machine-readable drift report.
- CI artifacts include `v2-runtime-parity` and `v2-live-ui`.
- Production branch name: `feature/image-preload-cache`.
- This pipeline neither starts nor modifies V2 Hall servers.
