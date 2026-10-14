#!/usr/bin/env python3
"""Loopback owner/guest Chromium comparison. Simulated A1 clock and HALL close.
Never touches VPS or production source. Requires playwright+websockets+Chromium.
"""
import asyncio, json, os
from playwright.async_api import async_playwright
from websockets.asyncio.server import serve

async def scenario(browser,mode):
    joined={}
    guest_closed=asyncio.Event()
    ack=asyncio.Event()
    observed={'case':mode,'network':'127.0.0.1 only','vps_touched':False,'simulated_policy':True}
    async def handler(ws):
        role=None
        try:
            async for msg in ws:
                if msg.startswith('role:'):
                    role=msg.split(':',1)[1]
                    joined[role]=ws
                elif msg=='heartbeat' and role=='owner':
                    ack.set()
        except Exception:pass
        finally:
            if role=='guest':
                observed['guest_close_code_on_server']=ws.close_code
                guest_closed.set()
            elif role=='owner':
                observed['owner_close_code_on_server']=ws.close_code
    async with serve(handler,'127.0.0.1',0,ping_interval=None) as server:
        port=server.sockets[0].getsockname()[1]
        owner_page=await browser.new_page()
        guest_page=await browser.new_page()
        try:
            await owner_page.goto('about:blank')
            await guest_page.goto('about:blank')
            await owner_page.evaluate('''port=>{
                window.events=[];
                const ws=new WebSocket('ws://127.0.0.1:'+port); window.socket=ws;
                ws.onopen=()=>ws.send('role:owner');
                ws.onmessage=e=>{
                    if(e.data==='stall'){
                        window.events.push('stall_started');
                        const t=performance.now();
                        while(performance.now()-t<2400){}
                        window.events.push('stall_ended');
                    }else if(e.data==='heartbeat'){
                        window.events.push('heartbeat_callback_dispatched');
                        ws.send('heartbeat');
                    }
                };
                ws.onclose=e=>window.events.push('owner_close_'+e.code);
            }''',port)
            await guest_page.evaluate('''port=>{
                window.events=[];
                const ws=new WebSocket('ws://127.0.0.1:'+port); window.socket=ws;
                ws.onopen=()=>ws.send('role:guest');
                ws.onmessage=e=>{
                    if(e.data==='selfclose'){
                        window.events.push('selfclose_received'); ws.close();
                    }
                };
                ws.onclose=e=>window.events.push('guest_close_'+e.code);
            }''',port)
            for _ in range(60):
                if 'owner' in joined and 'guest' in joined:break
                await asyncio.sleep(.05)
            if set(joined)!={'owner','guest'}:raise RuntimeError('owner and guest not connected')
            owner,guest=joined['owner'],joined['guest']
            await owner.send('stall')
            await asyncio.sleep(.2)
            await owner.send('heartbeat')
            pongs=0
            for _ in range(4):
                await asyncio.sleep(.2)
                p=await owner.ping()
                await asyncio.wait_for(p,.18)
                pongs+=1
            observed['transport_pongs_during_js_stall']=pongs
            observed['text_ack_before_policy_deadline']=ack.is_set()
            if mode=='original_abort':
                if not ack.is_set():
                    owner.transport.abort()  # simulated A1 terminate()
                    await guest.send('selfclose') # simulated HALL room-close notification
                    await asyncio.wait_for(guest_closed.wait(),3)
                observed['selfclose_emitted']=not ack.is_set()
                await asyncio.sleep(1.7)
            elif mode=='bounded_grace':
                observed['grace_used']=(pongs>0 and not ack.is_set())
                await asyncio.wait_for(ack.wait(),4)
                observed['app_recovered_during_grace']=True
                observed['selfclose_emitted']=False
            else:raise ValueError(mode)
            observed['owner_browser_events']=await owner_page.evaluate('window.events')
            observed['guest_browser_events']=await guest_page.evaluate('window.events')
            observed['owner_browser_socket_state']=await owner_page.evaluate('window.socket.readyState')
            observed['guest_browser_socket_state']=await guest_page.evaluate('window.socket.readyState')
            assert pongs>=1 and not observed['text_ack_before_policy_deadline']
            if mode=='original_abort':
                assert observed.get('guest_close_code_on_server')==1005
            else:
                assert observed['app_recovered_during_grace']
                assert observed['owner_browser_socket_state']==1
                assert observed['guest_browser_socket_state']==1
            observed['status']='PASS'
        finally:
            await owner_page.close()
            await guest_page.close()
    return observed

async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),
            headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            a=await scenario(browser,'original_abort')
            b=await scenario(browser,'bounded_grace')
            print(json.dumps({'test':'owner/guest Chromium A1 policy comparison',
                              'scenarios':[a,b]},indent=2))
        finally:await browser.close()
if __name__=='__main__':asyncio.run(main())
