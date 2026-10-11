/**
 * Offline V3-only static ESM test host; never publish a game server.
 * Real checkout files stay unchanged. Browser and HTTP bound to loopback.
 */
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
const MIME={'.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
'.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8',
'.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.png':'image/png',
'.jpg':'image/jpeg','.webp':'image/webp'};
const page='<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>V3 isolated native modules test</title><body></body></html>';
export async function createV3NativeModuleTestServer({root}={}){
 if(typeof root!=='string'||!root.startsWith('/'))throw Error('ABSOLUTE_TEST_ROOT_REQUIRED');
 const base=resolve(root);
 const server=createServer(async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
  let parsed,pathname;
  try{
   parsed=new URL(req.url,'http://127.0.0.1');
   if(parsed.search||parsed.hash)throw Error('QUERY_NOT_ALLOWED');
   pathname=decodeURIComponent(parsed.pathname);
   if(pathname==='/'||pathname==='/v3-native-isolated.html'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    if(req.method!=='HEAD')res.end(page);else res.end();return;
   }
   if(!/^\/[a-zA-Z0-9_./-]+$/.test(pathname)||pathname.includes('..'))throw Error('PATH_DENIED');
  }catch{res.writeHead(400);res.end();return}
  const file=resolve(base,'.'+pathname);
  if(!file.startsWith(base+sep)){res.writeHead(403);res.end();return}
  try{
   const details=await stat(file);
   if(!details.isFile()){res.writeHead(404);res.end();return}
   const bytes=await readFile(file);
   res.writeHead(200,{'Content-Type':MIME[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});
   if(req.method==='HEAD')res.end();else res.end(bytes);
  }catch{res.writeHead(404);res.end()}
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
 const addr=server.address();
 return Object.freeze({origin:'http://127.0.0.1:'+addr.port,
  close:()=>new Promise(done=>server.close(done))});
}
