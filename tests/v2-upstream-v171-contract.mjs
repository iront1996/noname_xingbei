#!/usr/bin/env node
// V2 v1.7.1 content integrity; read-only; no network or browser required.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
const sha = p => git('hash-object', '--', p);
const protectedBlobs = {
 'mode/connect.js':'0ae990c90934ac3ef96190d00d56efafe6605b3a',
 'noname/init/index.js':'bcecb1ca9c977571a151d15fd87f712a8ecd5594',
 'game/preload-images.mjs':'75b9c1b9b8957380bab12db2b59095be351572fb',
 'tools/sync-image-manifest.mjs':'a0fc8744559b2c65b483ea4284ff5847952bd51b',
 'xingbei-image-sw.js':'887cd79d83d3b570f91fd46d7f0cce959e5b335c',
 'game/server.js':'49a0ad87ffc2638e3651fe6a08b5a150cdf38de3'
};
const upstreamBlobs = {
 'character/sanBan.js':'00b1674f1580c176e84a3ac72cc556df7d36ed4d',
 'character/shenZiChuangLin.js':'90f59085b4864033fb9f6187f4dd6830e6b56881',
 'character/shiZhouNian.js':'d21f516830999fe9164142359590f04c933a5b0b',
 'character/teDian.js':'5a105a8e4eb0155c898656f91bcb89901354fb95',
 'character/yiDuanYeHuo.js':'4a2e28d4458c7d51883154b504b397d893fcc526',
 'character/zhongMoDaoZhu.js':'3fb604c0d3fc8c477ab69938b2f1f995c41c30de',
 'mode/xingBei.js':'e25fc2d8f3f1e5db6b1ead19c418b2d965e30a68',
 'noname/get/index.js':'7f178a467c11040ef231599f8ffecb5bea5a803d',
 'noname/library/element/content.js':'6dbe99acddf2df6bdd612ca2e75352bfb5112c37',
 'noname/library/element/player.js':'ae59c139bcc8a4aa11f7f6c591318489f1f9175d',
 'game/config.js':'06340e39901ed192d8ecb1010dd16de0c22f239c',
 'game/update.js':'4f8807df0fcfcaa4780315d3498a255be30baf53'
};
for(const [path,expected] of Object.entries({...protectedBlobs,...upstreamBlobs}))
 assert.equal(sha(path),expected,'source integrity: '+path);
assert.match(read('game/update.js'),/version:\s*["']1\.7\.1["']/);
assert.ok(read('mode/connect.js').includes('wss://v2-hall-direct.myxingbei.com:50000'));
assert.ok(read('game/preload-images.mjs').includes('preload-manifest.json'));
const mode=read('mode/xingBei.js');
for(const [m,n] of [['2v2',4],['3v3',6],['4v4',8]]) {
 const pattern = new RegExp("case\\s*['\"]"+m+"['\"]\\s*:\\s*lib\\.configOL\\.number\\s*=\\s*"+n+"\\s*;");
 assert.match(mode,pattern,'mode seats: '+m);
}
const role=read('character/teDian.js');
for(const c of ['daZuiSiJiao','guShenJiSi'])assert.ok(role.includes(c),'new role: '+c);
const manifest=JSON.parse(read('game/preload-manifest.json'));
assert.equal(manifest.schemaVersion,1);
assert.equal(manifest.count,641);
assert.equal(manifest.assets.length,641);
assert.equal(manifest.totalBytes,80138549);
assert.equal(manifest.version,git('rev-parse','HEAD:image')+'-'+git('rev-parse','HEAD:theme'));
assert.equal(new Set(manifest.assets.map(x=>x.path)).size,641);
assert.equal(manifest.assets.reduce((total,x)=>total+x.bytes,0),manifest.totalBytes);
const newImages=[
 ['image/card/zhuanShu/jiLeMengJing.png',696048,'414cb597b937e12f93a78ee9d22bdec254116f0d'],
 ['image/character/daZuiSiJiao.jpg',459064,'8932311e23e6cc550f183666c0a911b651d95b03'],
 ['image/character/guShenJiSi.jpg',738994,'14011060d697a62ee6fc6181271987e0a0b442ab']
];
for(const [p,size,hash] of newImages){
 const a=manifest.assets.find(x=>x.path===p);
 assert.ok(a,'missing manifest asset: '+p);
 assert.equal(a.bytes,size);
 assert.equal(a.gitBlobSha,hash);
 assert.equal(statSync(join(root,p)).size,size);
 assert.equal(sha(p),hash);
}
const asset=read('game/asset.js');
assert.ok(asset.includes("'image/card/zhuanShu/jiLeMengJing.png'"));
assert.ok(!asset.includes('image/card/zhuanShu/jiLeMengJing.jpg'));
console.log('V2 v1.7.1 content and V2-feature integrity PASS (scoped)');
