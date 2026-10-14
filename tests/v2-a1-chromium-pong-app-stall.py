#!/usr/bin/env python3
"""Real Chromium reproduction of app-heartbeat starvation while WebSocket Pong survives.

LOCAL ONLY. Requires python playwright, websockets, and a Chromium executable.
No VPS, production A1 source, Cloudflare, or external network accessed.
Uses 2.6s deliberate main-thread stall and 1.2s demonstration timeout
to keep the experiment brief. Does NOT assert historical causality.
"""
import asyncio
import json
import os
import time

from playwright.async_api import async_playwright
from websockets.asyncio.server import serve


async def main():
    connection = asyncio.get_running_loop().create_future()
    report = {
        "test": "real Chromium: Pong versus JavaScript application heartbeat",
        "network": "127.0.0.1 only",
        "vps_touched": False,
        "main_thread_block_ms": 2600,
        "reproduction_timeout_ms": 1200,
        "pongs_during_js_block": 0,
        "app_ack_before_timeout": False,
    }

    async def handler(ws):
        if not connection.done():
            connection.set_result(ws)
        try:
            async for message in ws:
                if message == "heartbeat":
                    report["app_ack_before_timeout"] = True
        except Exception:
            pass

    async with serve(handler, "127.0.0.1", 0, ping_interval=None) as server:
        port = server.sockets[0].getsockname()[1]
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                page = await browser.new_page()
                await page.goto("about:blank")
                await page.evaluate("""(port) => {
                    window.trace = [];
                    window.ws = new WebSocket('ws://127.0.0.1:' + port);
                    window.ws.onmessage = e => {
                        if (e.data === 'start') {
                            window.trace.push('js_block_start');
                            const t = performance.now();
                            while (performance.now() - t < 2600) {}
                            window.trace.push('js_block_end');
                        } else if (e.data === 'heartbeat') {
                            window.trace.push('application_heartbeat_dispatched');
                            window.ws.send('heartbeat');
                        }
                    };
                    window.ws.onclose = e => window.trace.push('close_' + e.code);
                }""", port)
                ws = await asyncio.wait_for(connection, 10)
                await asyncio.sleep(0.1)
                await ws.send("start")
                await asyncio.sleep(0.4)
                await ws.send("heartbeat")
                first_probe = time.monotonic()
                for _ in range(5):
                    await asyncio.sleep(0.20)
                    pong = await ws.ping()
                    await asyncio.wait_for(pong, 0.15)
                    report["pongs_during_js_block"] += 1
                report["elapsed_since_text_probe_ms"] = round((time.monotonic() - first_probe) * 1000)
                report["app_ack_missing_at_timeout"] = not report["app_ack_before_timeout"]
                if report["app_ack_missing_at_timeout"]:
                    # Equivalent to an abrupt terminate, NOT a graceful WebSocket Close.
                    ws.transport.abort()
                    report["aborted_without_close_handshake"] = True
                await asyncio.sleep(2)
                report["browser_trace"] = await page.evaluate("window.trace")
            finally:
                await browser.close()
    report["outcome"] = (
        "REPRODUCED" if report["pongs_during_js_block"] >= 1 and
        report["app_ack_missing_at_timeout"] and
        "application_heartbeat_dispatched" in report["browser_trace"] else "NOT_REPRODUCED"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["outcome"] != "REPRODUCED":
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
