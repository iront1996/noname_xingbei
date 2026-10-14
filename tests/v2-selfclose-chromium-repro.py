#!/usr/bin/env python3
"""Chromium loopback proof for V2 selfclose -> code-less WebSocket close.

Local-only; no VPS, actual remote server, production changes or Cloudflare.
Requirements: python playwright + websockets, Chromium binary.
"""
import asyncio, json, os
from playwright.async_api import async_playwright
from websockets.asyncio.server import serve

async def main():
    result = {'network':'127.0.0.1 only','production_touched':False,
              'instruction':'V2 selfclose handler invokes ws.close() without a code'}
    done=asyncio.get_running_loop().create_future()
    async def handler(ws):
        await ws.send(json.dumps(['selfclose']))
        try:
            async for _ in ws: pass
        except Exception as err:
            result['server_exception_type']=type(err).__name__
        result['server_observed_close_code']=ws.close_code
        result['server_observed_close_reason']=ws.close_reason
        if not done.done():done.set_result(True)
    async with serve(handler,'127.0.0.1',0,ping_interval=None) as server:
        port=server.sockets[0].getsockname()[1]
        async with async_playwright() as pw:
            browser=await pw.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),
                headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            try:
                page=await browser.new_page()
                await page.goto('about:blank')
                await page.evaluate('''port=>{
                    window.wsResult={};
                    const ws=new WebSocket('ws://127.0.0.1:'+port);
                    ws.onmessage=e=>{
                        if(JSON.parse(e.data)[0]==='selfclose'){
                            window.wsResult.selfclose_received=true;
                            ws.close();
                        }
                    };
                    ws.onclose=e=>{
                        window.wsResult.browser_close_code=e.code;
                        window.wsResult.browser_clean=e.wasClean;
                    };
                }''',port)
                await asyncio.wait_for(done,10)
                await page.wait_for_function('!!window.wsResult.browser_close_code',timeout=5000)
                result.update(await page.evaluate('window.wsResult'))
            finally: await browser.close()
    result['outcome']='REPRODUCED' if (result.get('server_observed_close_code')==1005 and
                result.get('selfclose_received') and result.get('browser_close_code')==1005) else 'NOT_REPRODUCED'
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if result['outcome']!='REPRODUCED':raise SystemExit(1)

if __name__=='__main__':asyncio.run(main())
