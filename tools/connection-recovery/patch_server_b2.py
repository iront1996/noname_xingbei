#!/usr/bin/env python3
"""Fail-closed B2 server patch. Requires A1 heartbeat and v2.3 monitor."""
from pathlib import Path

MARK='// XINGBEI-RECOVERY B2'
def replace_once(source,before,after):
    n=source.count(before)
    if n!=1:raise ValueError(f'expected exactly one source anchor; got {n}: {before[:100]!r}')
    return source.replace(before,after,1)

def patch(source):
    if MARK in source:raise ValueError('B2 already installed')
    if 'XINGBEI-CONNECTION-HEALTH A1' not in source:raise ValueError('A1 heartbeat upgrade required')
    if 'XINGBEI-MONITOR DISCONNECT V2.3' not in source:raise ValueError('monitor v2.3 hook marker missing')
    source=replace_once(source,'\tvar WebSocketServer = require("ws").Server;',
        '\tvar WebSocketServer = require("ws").Server;\n\t'+MARK+
        '\n\tvar xbSeats = require("./xingbei-seat-registry.js").createSeatRegistry();'+
        '\n\t// XINGBEI-V2 HALL WATCH: separate Node.js observation timer.'+
        '\n\tvar xbHallWatch = require("./xingbei-hall-progress-watch.js").createHallProgressWatch({'+
        '\n\t  onAdvisory: function (info) { console.warn("[Xingbei][V2 HALL]",'+
        '\n\t    info.kind, "room:", info.roomId, "socketOpen:", info.transportOpen); }'+
        '\n\t});'+
        '\n\tvar xbHallTimer = setInterval(function () { xbHallWatch.check(); }, 15000);'+
        '\n\tif (xbHallTimer && typeof xbHallTimer.unref === "function") xbHallTimer.unref();')
    handler='''
        // V2-5: game progress metadata is accepted from this actual owner only.
        xbHostProgressV2: function (protocol, sequence, phase, pending, paused, active) {
            if (clients[this.wsid] !== this || !this.room || this.room.owner !== this) return;
            xbHallWatch.report(this.room, this, protocol, sequence, phase, pending, paused, active);
        },
        // XINGBEI-RECOVERY B2: NEVER authorize using public seat id/onlineKey.
        xbResumeSeat: function (key, seatId, token) {
            if (clients[this.wsid] !== this || this.room || this.owner ||
                typeof key !== "string" || typeof seatId !== "string" ||
                typeof token !== "string") {
                this.sendl("xbSeatResumeRejected"); return;
            }
            var room = rooms.find(function (r) { return r.key === key; });
            var claim = room && xbSeats.adopt(room, this, seatId, token);
            if (!claim) { this.sendl("xbSeatResumeRejected"); return; }
            var temporaryId = this.wsid;
            delete clients[temporaryId];
            this.wsid = claim.stableSeatId;
            this.owner = room.owner;
            this.room = room;
            this.nickname = claim.nickname;
            this.avatar = claim.avatar;
            delete this.status;
            clients[this.wsid] = this;
            // Identity guards reject delayed traffic from superseded sockets.
            var previous = claim.oldSocket;
            if (previous && previous !== this) {
                try { previous.terminate(); } catch (_) {
                    try { previous.close(); } catch (_) {}
                }
            }
            this.sendl("xbSeatReclaimed", key, this.wsid);
            this.owner.sendl("onconnection", this.wsid);
            util.updaterooms();
        },'''
    source=replace_once(source,'\tvar messages = {','\tvar messages = {'+handler)
    anchor='\t\t\t\t\tthis.owner.sendl("onconnection", this.wsid);'
    source=replace_once(source,anchor,anchor+'''
                    // XINGBEI-RECOVERY B2: issue only to accepted guest.
                    var issued = xbSeats.issue(room, this);
                    if (issued) this.sendl("xbSeatCredentials", issued.roomId, issued.seatId, issued.token);''')
    source=replace_once(source,'\t\t\tif (!clients[this.wsid]) return;',
        '\t\t\tif (clients[this.wsid] !== this) return; // B2 stale socket fence')
    source=replace_once(source,
        '\t\t\t\tif (rooms[i].owner == this) {',
        '\t\t\t\tif (rooms[i].owner == this) {\n                xbHallWatch.ownerClosed(rooms[i], this);')
    source=replace_once(source,'\t\t\tif (clients[this.wsid]) {',
        '\t\t\tif (clients[this.wsid] === this) {\n                xbSeats.drop(this.room, this);')
    source=replace_once(source,'''\t\t\tif (clients[id] && clients[id].owner == this) {
\t\t\t\tclients[id].close();
\t\t\t}''','''\t\t\tif (clients[id] && clients[id].owner == this) {
                xbSeats.revoke(clients[id].room, clients[id].wsid);
\t\t\t\tclients[id].close();
\t\t\t}''')
    return source

if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser()
    ap.add_argument('--source',required=True)
    ap.add_argument('--output',required=True)
    args=ap.parse_args()
    Path(args.output).write_text(patch(Path(args.source).read_text()))
