# B2 / Authenticated guest-seat reclaim (development only)

**Do not deploy B2 alone.** The A1 heartbeat deployment remains live on HALL and V3. The v2.3 monitor is unchanged.

The legacy HALL and experimental V3 room servers expose seat IDs and `onlineKey` in lobby data. Neither can be treated as a session secret. The B2 `seat-registry.js` therefore issues one private random 256-bit bearer per accepted guest seat. It stores only a SHA-256 token digest and compares it in constant time. The credential is scoped to its room instance, original guest seat, and online identity. Dropped seats have a 10-minute recovery window. V3 paused/resuming host rooms refuse guest reclaim.

The `patch_server_b2.py` patcher is fail-closed: its source must contain the A1 heartbeat and v2.3 monitor integration markers and exactly one of each expected source anchor. It adds:
- `xbSeatCredentials` after accepted `enter`;
- `xbResumeSeat` to validate the guest secret, rebind the new socket to its old stable `wsid`, and announce a replacement `onconnection` to the host;
- identity-checked message and close handlers, so late events from a superseded socket cannot submit actions or mark a player offline;
- token revocation when the owner explicitly closes a guest socket.

`node tools/connection-recovery/test-seat-registry.js` exercises invalid tokens, cross-room reuse, late close fencing, expiry, and paused V3 rooms.

Full mock-HALL/V3 integration tests and redacted reference-server fixtures are included in the separate B2 test bundle, not in the production backend. No source code is deployed by this commit.

## Next critical steps

1. Implement matching browser-side credential storage and authenticated reclaim after the initial `roomlist`, without resetting the existing game UI.
2. Wait for host `reinit` / `reinited` before reporting *gameplay* recovery.
3. Fence AI selection timeouts and stale game events; separately handle owner recovery and the newest independent V3 runtime.
4. Only then run paired deployment preflight and concentrated automated/real-player acceptance tests.
