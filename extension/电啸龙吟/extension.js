/* AUDIO_PACK_RUNTIME_BEGIN */
/* Resource runtime v2, revision 11 (verify cached files exist before skipping restore). */
(function (root) {
    'use strict';
    if (root.NonameAudioPacks && root.NonameAudioPacks.revision >= 11) return;
    function sha256(bytes) {
        var k = [], h = [], n = 2;
        while (k.length < 64) {
            var prime = true;
            for (var d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
            if (prime) {
                if (h.length < 8) h.push((Math.sqrt(n) % 1 * 4294967296) | 0);
                k.push((Math.pow(n, 1 / 3) % 1 * 4294967296) | 0);
            }
            n++;
        }
        var length = Math.ceil((bytes.length + 9) / 64) * 64;
        var padded = new Uint8Array(length);
        padded.set(bytes); padded[bytes.length] = 128;
        var view = new DataView(padded.buffer);
        view.setUint32(length - 8, Math.floor(bytes.length / 536870912));
        view.setUint32(length - 4, (bytes.length * 8) >>> 0);
        function r(x, c) { return (x >>> c) | (x << (32 - c)); }
        for (var offset = 0; offset < length; offset += 64) {
            var w = new Int32Array(64);
            for (var i = 0; i < 64; i++) {
                if (i < 16) w[i] = view.getInt32(offset + i * 4);
                else {
                    var x = w[i - 15], y = w[i - 2];
                    w[i] = (w[i - 16] + (r(x, 7) ^ r(x, 18) ^ (x >>> 3)) + w[i - 7] + (r(y, 17) ^ r(y, 19) ^ (y >>> 10))) | 0;
                }
            }
            var a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (i = 0; i < 64; i++) {
                var t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
                var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            [a, b, c, dd, e, f, g, hh].forEach(function (v, j) { h[j] = (h[j] + v) | 0; });
        }
        return h.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
    }
    async function hash(bytes) {
        if (root.crypto && root.crypto.subtle) {
            var value = new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
            return Array.from(value).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        }
        return sha256(bytes);
    }
    function ascii(text) {
        var bytes = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) > 127) throw new Error('音频 JSON 不是原始 ASCII 数据');
            bytes[i] = text.charCodeAt(i);
        }
        return bytes;
    }
    function safe(path) {
        if (typeof path !== 'string' || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(function (p) { return !p || p === '.' || p === '..'; })) throw new Error('非法音频路径: ' + path);
        return path;
    }
    function buffer(value) {
        return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
    }
    async function readVerified(game, path, expected, options, binary) {
        if (options.onActivity) options.onActivity();
        async function verify(text) {
            var bytes = binary ? buffer(text) : typeof text === 'string' ? ascii(text) : null;
            if (!bytes || (expected.size !== undefined && bytes.length !== expected.size) || await hash(bytes) !== expected.sha256) {
                throw new Error('扩展资源 SHA-256 不匹配: ' + path.split('/').pop());
            }
            return text;
        }
        var localError;
        try { return await verify(await game.promises[binary ? 'readFile' : 'readFileAsText'](path)); }
        catch (error) { localError = error; }
        var sources = (options.sources || []).filter(function (source, index, all) {
            return typeof source === 'string' && /^https?:\/\//i.test(source) && all.indexOf(source) === index;
        }).slice(0, 3);
        if (!sources.length || typeof root.fetch !== 'function') throw localError;
        var text, downloadError;
        for (var source of sources) {
            if (options.onActivity) options.onActivity();
            if (options.onRepair) options.onRepair(path.split('/').pop(), source);
            var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
            var timer;
            try {
                // The hash-pinned filename/manifest is authoritative, never an HTTP error page.
                var url = source.replace(/\/?$/, '/') + path.slice('extension/'.length).split('/').map(encodeURIComponent).join('/');
                text = await Promise.race([
                    (async function () {
                        var response = await root.fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
                        if (!response.ok) throw new Error('HTTP ' + response.status);
                        return verify(await (binary ? response.arrayBuffer() : response.text()));
                    })(),
                    new Promise(function (_, reject) {
                        timer = root.setTimeout(function () {
                            if (controller) controller.abort();
                            reject(new Error('下载超时'));
                        }, 30000);
                    }),
                ]);
                break;
            } catch (error) { downloadError = error; }
            finally { root.clearTimeout(timer); }
        }
        if (text === undefined) throw new Error('扩展资源缺失或损坏，自动补下载失败: ' + path.split('/').pop() + '（' + (downloadError.message || downloadError) + '）');
        var split = path.lastIndexOf('/'), directory = path.slice(0, split);
        await game.promises.createDir(directory);
        var bytes = binary ? buffer(text) : ascii(text);
        await writeResourceFile(game, path, bytes);
        // Do not record success until the repaired local file also passes verification.
        var verified = await verify(await game.promises[binary ? 'readFile' : 'readFileAsText'](path));
        if (options.onRepaired) options.onRepaired(path);
        return verified;
    }
    // Reset Cordova's FileWriter before writing so an older longer file cannot leave
    // trailing bytes. Resolve only after both the truncate and write operations finish.
    async function writeResourceFile(game, path, bytes) {
        var base = '';
        try {
            base = root.localStorage && root.localStorage.getItem('noname_inited') || '';
        } catch (_) {}
        if (typeof root.resolveLocalFileSystemURL === 'function' && base && base !== 'nodejs') {
            var split = path.lastIndexOf('/');
            var directory = base + path.slice(0, split + 1);
            var name = path.slice(split + 1);
            await new Promise(function (resolve, reject) {
                var phase = 'truncate', settled = false;
                function fail(error) {
                    if (settled) return;
                    settled = true;
                    reject(error || new Error('扩展资源写入失败: ' + path));
                }
                root.resolveLocalFileSystemURL(directory, function (directoryEntry) {
                    directoryEntry.getFile(name, { create: true }, function (fileEntry) {
                        fileEntry.createWriter(function (writer) {
                            writer.onerror = function (event) {
                                fail(writer.error || (event && event.target && event.target.error));
                            };
                            writer.onwriteend = function () {
                                if (settled) return;
                                if (writer.error) return fail(writer.error);
                                if (phase === 'truncate') {
                                    phase = 'write';
                                    try {
                                        writer.seek(0);
                                        var payload = typeof root.Blob === 'function' ? new root.Blob([bytes]) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                                        writer.write(payload);
                                    } catch (error) {
                                        fail(error);
                                    }
                                    return;
                                }
                                settled = true;
                                resolve();
                            };
                            try {
                                writer.truncate(0);
                            } catch (error) {
                                fail(error);
                            }
                        }, fail);
                    }, fail);
                }, fail);
            });
            return;
        }
        var split = path.lastIndexOf('/');
        var data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await game.promises.writeFile(data, path.slice(0, split), path.slice(split + 1));
    }
    async function cachedFileExists(game, path) {
        try {
            return await game.promises.checkFile(path) === 1;
        } catch (_) {
            return false;
        }
    }
    function notice(name) {
        if (!root.document) return { update: function () {}, repair: function () {}, remove: function () {} };
        var node = root.document.createElement('div');
        node.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.9);color:white;display:flex;align-items:center;justify-content:center;font-size:20px;white-space:pre-wrap;text-align:center;';
        node.textContent = name + '：正在检查扩展资源…';
        (root.document.body || root.document.documentElement).appendChild(node);
        return {
            update: function (done, total) { node.textContent = name + '：正在还原音频 ' + done + '/' + total + '\n所有扩展完成后自动重启，请勿关闭游戏。'; },
            repair: function (file, source) { node.textContent = name + '：正在补下载扩展资源\n' + file + '\n来源：' + new URL(source).hostname + '\n校验通过后继续加载，请勿关闭游戏。'; },
            remove: function () { node.remove(); },
        };
    }
    var queue = Promise.resolve(), pending = new Map();
    var changed = false, failed = false, restartScheduled = false;
    var preparing = 0, lastActivity = 0;
    function activity() { lastActivity = Date.now(); }
    async function install(meta, game, options) {
        options = options || {};
        var base = 'extension/' + safe(meta.name);
        var storage = options.storage || root.localStorage;
        var text = await readVerified(game, base + '/audio-data/manifest.json', meta, options);
        var manifest = JSON.parse(text);
        if (manifest.format !== 2 || !Array.isArray(manifest.files) || !Array.isArray(manifest.bundles)) throw new Error('无效音频清单');
        var assetsChanged = false;
        var key = 'noname-audio-pack-v2:' + meta.name;
        var previous;
        try { previous = JSON.parse(storage.getItem(key) || 'null'); } catch (_) {}
        var cacheRuntimeMatches = previous && previous.runtime === 11;
        var assetHashes = Object.create(null);
        if (manifest.assets !== undefined && !Array.isArray(manifest.assets)) throw new Error('无效静态资源清单');
        var assetPaths = new Set();
        for (var asset of manifest.assets || []) {
            safe(asset.path);
            if (!/\.(?:png|jpe?g|webp|gif|svg|css)$/i.test(asset.path) || assetPaths.has(asset.path)) throw new Error('非法静态资源路径: ' + asset.path);
            assetPaths.add(asset.path);
        }
        var bundleNames = new Set(manifest.bundles.map(function (bundle) { return safe(bundle.name); }));
        var files = new Map(), needed = new Set(), selected = new Set();
        var hashes = Object.create(null), legacy = false;
        for (var entry of manifest.files) {
            safe(entry.path);
            if (files.has(entry.path)) throw new Error('重复音频路径');
            if (entry.bundles && (!Array.isArray(entry.bundles) || !entry.bundles.length || entry.bundles.some(function (name) { return !bundleNames.has(name); }))) throw new Error('无效音频分包索引');
            files.set(entry.path, entry);
        }
        // Cache entries are written only after full verification. Reuse them for unchanged manifests.
        var cacheComplete = !options.force && cacheRuntimeMatches && previous && previous.manifest === meta.sha256 && previous.files &&
            manifest.files.every(function (entry) { return previous.files[entry.path] === entry.sha256; }) &&
            (manifest.assets || []).every(function (asset) { return previous.assets && previous.assets[asset.path] === asset.sha256; });
        if (cacheComplete) {
            var resourcesPresent = true;
            for (var resource of manifest.files.concat(manifest.assets || [])) {
                if (!await cachedFileExists(game, base + '/' + resource.path)) {
                    resourcesPresent = false;
                    break;
                }
            }
            if (resourcesPresent) return false;
        }
        for (var asset of manifest.assets || []) {
            var cachedAsset = false;
            if (!options.force && cacheRuntimeMatches && previous && previous.assets && previous.assets[asset.path] === asset.sha256) {
                if (options.onActivity) options.onActivity();
                cachedAsset = await cachedFileExists(game, base + '/' + asset.path);
            }
            if (!cachedAsset) {
                await readVerified(game, base + '/' + asset.path, asset, Object.assign({}, options, {
                    onRepaired: function () { assetsChanged = true; },
                }), true);
            }
            assetHashes[asset.path] = asset.sha256;
        }
        for (var entry of manifest.files) {
            var cached = false;
            if (!options.force && previous && previous.files && previous.files[entry.path] === entry.sha256) {
                if (options.onActivity) options.onActivity();
                if (cacheRuntimeMatches) {
                    cached = await cachedFileExists(game, base + '/' + entry.path);
                } else {
                    try {
                        var existing = buffer(await game.promises.readFile(base + '/' + entry.path));
                        cached = existing.length === entry.size && await hash(existing) === entry.sha256;
                    } catch (_) {}
                }
            }
            if (cached) {
                hashes[entry.path] = entry.sha256;
            } else {
                needed.add(entry.path);
                if (entry.bundles) entry.bundles.forEach(function (name) { selected.add(name); });
                else legacy = true;
            }
        }
        var total = needed.size, index = 0, position = 0, bytes = null, current = null, directories = new Set();
        for (var bundle of manifest.bundles) {
            if (!needed.size || (!legacy && !selected.has(bundle.name))) continue;
            safe(bundle.name);
            text = await readVerified(game, base + '/audio-data/' + bundle.name, bundle, options);
            var body = JSON.parse(text);
            if (body.format !== 2 || !Array.isArray(body.records)) throw new Error('无效音频数据包');
            for (var record of body.records) {
                var file = files.get(safe(record.path));
                if (!file || !needed.has(file.path) || (file.bundles && !file.bundles.includes(bundle.name))) continue;
                if ((current && current !== file.path) || record.offset !== position) throw new Error('音频分片顺序错误');
                if (!bytes) {
                    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('无效音频长度');
                    bytes = new Uint8Array(file.size);
                    current = file.path;
                }
                var raw = root.atob(record.base64);
                if (position + raw.length > bytes.length) throw new Error('音频长度超限');
                for (var j = 0; j < raw.length; j++) bytes[position++] = raw.charCodeAt(j);
                if (position !== file.size) continue;
                if (await hash(bytes) !== file.sha256) throw new Error('音频 SHA-256 不匹配: ' + file.path);
                var target = base + '/' + safe(file.path), split = target.lastIndexOf('/');
                var parts = target.slice(0, split).split('/');
                for (j = 1; j <= parts.length; j++) {
                    var directory = parts.slice(0, j).join('/');
                    if (!directories.has(directory)) {
                        await game.promises.createDir(directory);
                        directories.add(directory);
                    }
                }
                await writeResourceFile(game, target, bytes);
                var written = buffer(await game.promises.readFile(target));
                if (written.length !== file.size || await hash(written) !== file.sha256) throw new Error('写入校验失败: ' + file.path);
                hashes[file.path] = file.sha256;
                needed.delete(file.path);
                index++; position = 0; bytes = null; current = null;
                if (options.onProgress) options.onProgress(index, total);
                // Let the browser paint progress during long voice-pack installations.
                await new Promise(function (resolve) { root.setTimeout(resolve, 0); });
            }
        }
        if (needed.size || bytes) throw new Error('音频数据包不完整');
        storage.setItem(key, JSON.stringify({ version: manifest.version, manifest: meta.sha256, runtime: 11, files: hashes, assets: assetHashes }));
        return index > 0 || assetsChanged;
    }
    function prepare(meta, lib, game) {
        if (pending.has(meta.name)) return pending.get(meta.name);
        if (!Array.isArray(lib.onprepare)) return Promise.reject(new Error('客户端缺少 onprepare 启动钩子'));
        if (!restartScheduled) {
            restartScheduled = true;
            lib.onprepare.push(async function () {
                await queue;
                if (changed && !failed) game.reload();
            });
        }
        var task = queue.then(async function () {
            var progress = notice(meta.name);
            preparing++; activity();
            try {
                var config = lib.config || {}, sources = config.extension_sources || {};
                var urls = [sources[config.extension_source]].concat(Object.values(sources));
                if (await install(meta, game, {
                    onActivity: activity,
                    onProgress: function (done, total) { activity(); progress.update(done, total); },
                    onRepair: progress.repair, sources: urls,
                })) changed = true;
            } catch (error) {
                failed = true;
                console.error('[扩展资源准备失败] ' + meta.name, error);
                if (root.alert) root.alert(meta.name + ' 资源准备失败，下次启动会重试：' + (error.message || error));
                throw error;
            } finally { preparing--; progress.remove(); }
        });
        queue = task.catch(function () {});
        pending.set(meta.name, task);
        task.catch(function () { pending.delete(meta.name); });
        return task;
    }
    root.NonameAudioPacks = {
        format: 2, revision: 11, sha256: sha256, install: install, prepare: prepare,
        isPreparing: function () { return preparing > 0 && Date.now() - lastActivity < 30000; },
        wrap: function (meta, factory) {
            return function (lib, game, ui, get, ai, _status) {
                var object = factory.apply(this, arguments);
                object.audioPackMetadata = meta;
                object.audioPackOriginalPrecontent = object.precontent;
                object.precontent = async function () {
                    await globalThis.NonameAudioPacks.prepare(this.audioPackMetadata, lib, game);
                    if (this.audioPackOriginalPrecontent) return this.audioPackOriginalPrecontent.apply(this, arguments);
                };
                return object;
            };
        },
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* AUDIO_PACK_RUNTIME_END */
(function (registerExtension) {
    if (typeof game !== "undefined" && game && typeof game.import === "function") {
        registerExtension(game);
    } else {
        import("../../noname.js").then(function (module) {
            registerExtension(module.game);
        }).catch(function (error) {
            console.error("扩展无法获取游戏实例", error);
        });
    }
})(function (game) {
    game.import("extension", globalThis.NonameAudioPacks.wrap({"name":"电啸龙吟","sha256":"1e751cf1ae5a65197f7789161e44ea6ba7e701b40b08501fabf5939ff2550213"}, function(lib, game, ui, get, ai, _status) {
    return {
        "name": "电啸龙吟",
        "arenaReady": function(){

},
        "content": function(config,pack){

},
        "prepare": function(){

},
        "precontent": function(){
            var actionAudioSkill = 'dianXiaoLongYin_actionAudio';
            if(!lib.skill[actionAudioSkill]) {
                lib.skill[actionAudioSkill] = {
                    trigger: { player: ['gouMai', 'heCheng', 'tiLian'] },
                    forced: true,
                    popup: false,
                    charlotte: true,
                    firstDo: true,
                    filter: function(event, player) {
                        return ['dianGunOtto', 'yongChuTaFei', 'naiLong']
                            .some(function(id) {
                                return player.name == id ||
                                    player.name1 == id ||
                                    player.name2 == id;
                            });
                    },
                    content: function(event, trigger, player) {
                        var action = event.triggername || trigger.name;
                        if(!['gouMai', 'heCheng', 'tiLian'].includes(action)) {
                            return;
                        }
                        var character = [
                            'dianGunOtto',
                            'yongChuTaFei',
                            'naiLong',
                        ].find(function(id) {
                            return player.name == id ||
                                player.name1 == id ||
                                player.name2 == id;
                        });
                        if(!character) return;
                        var path = 'ext:电啸龙吟/audio/action/' + character +
                            '/' + action + '.mp3';
                        game.broadcastAll(function(audioPath, speaker) {
                            if(!lib.config.background_speak) return;
                            game.playAudio({
                                path: audioPath,
                                spatialPlayer: speaker,
                                addVideo: false,
                                onError: function() {},
                            });
                        }, path, player);
                    },
                };
            }
            game.addGlobalSkill(actionAudioSkill);
},
        "help": {},
        "config": {},
        "package": {
            "character": {
                "connect": true,
                "character": {
                    "naiLong": [
                        null,
                        "shengGroup",
                        3,
                        [
                            "woShiNaiLong",
                            "buShiZhuangTangShiZhenTang",
                            "naiLongDaXiao",
                        ],
                        [
                            "des:总能以离谱笑声搅乱战局的显眼包，胡闹之中也会照顾同伴。他把技能弃牌转化为治疗，并用临场摸牌改写攻击的应战与伤害。",
                            "ext:电啸龙吟/naiLong.jpg",
                        ],
                    ],
                    "dianGunOtto": [
                        null,
                        "xueGroup",
                        3.5,
                        [
                            "baiYinWanQi",
                            "shuaiOttoShuai",
                            "zunNiHuoJia",
                            "dianGunShengJing",
                            "hongWen",
                            "fangGuan",
                        ],
                        [
                            "des:在压力与失控之间不断升温的红温主播，把每次受伤都记成新的怒火。红温爆表后，他进入白银晚期，将加剧的伤害倾泻给所有对手。",
                            "ext:电啸龙吟/otto.jpg",
                        ],
                    ],
                    "yongChuTaFei": [
                        null,
                        "shengGroup",
                        4.5,
                        [
                            "suanFaTuiJian",
                            "guoQiZhuBao",
                            "guanZhuTaFeiMiao",
                            "qianShiHeiTaoYing",
                            "qianShiYiBaoShuTiaoXiXi",
                            "yuanShengYao",
                            "yongChuTaFeiLiuLiang",
                            "yongChuTaFeiShuTiao",
                        ],
                        [
                            "des:追逐热榜与流量的王牌主包，把整片战场都变成直播素材。她记录全场行动、用薯条缓存手牌，并在热度顶峰连续开启额外回合。",
                            "ext:电啸龙吟/yongChuTaFei.jpg",
                        ],
                    ],
                },
                "translate": {
                    "牛牛diy": "牛牛diy",
                    "无名拓展": "无名拓展",
                    "电啸龙吟": "电啸龙吟",
                    "naiLong": "奶龙",
                    "dianGunOtto": "电棍Otto",
                    "yongChuTaFei": "永雏塔菲",
                },
            },
            "card": {
                "card": {},
                "translate": {},
                "list": [],
            },
            "skill": {
                "skill": {
                    "woShiNaiLong": {
                        "isNaiLongDiscard": function(event, player) {
                    var current = event;
                    var guard = 0;
                    while(current && guard < 8) {
                        if(current.naiLongSkillSource == player.playerid) {
                            return true;
                        }
                        current = current.getParent && current.getParent();
                        guard++;
                    }
                    return false;
                },
                        "group": [
                            "woShiNaiLong_kaiChang",
                            "woShiNaiLong_qiPaiZhiLiao",
                            "woShiNaiLong_gongJiMingZhong",
                        ],
                        "subSkill": {
                            "kaiChang": {
                                "trigger": {
                                    "global": "gameStart",
                                },
                                "forced": true,
                                "firstDo": true,
                                "popup": false,
                                "content": function(event, trigger, player) {
                            game.broadcastAll(function(speaker) {
                                if(!lib.config.background_speak) return;
                                game.playAudio({
                                    path: 'ext:电啸龙吟/audio/skill/naiLong/' +
                                        'woShiNaiLong.mp3',
                                    spatialPlayer: speaker,
                                    addVideo: false,
                                    onError: function() {},
                                });
                            }, player);
                        },
                            },
                            "qiPaiZhiLiao": {
                                "audio": "ext:电啸龙吟/audio/skill/naiLong/woShiNaiLong.mp3",
                                "trigger": {
                                    "global": "discard",
                                },
                                "forced": true,
                                "filter": function(event, player) {
                            return !!event &&
                                !!event.player &&
                                event.nun > 0 &&
                                lib.skill.woShiNaiLong
                                    .isNaiLongDiscard(event, player);
                        },
                                "content": async function(event, trigger, player) {
                            await trigger.player.changeZhiLiao(1, player);
                        },
                            },
                            "gongJiMingZhong": {
                                "trigger": {
                                    "source": "gongJiMingZhong",
                                },
                                "filter": function(event, player) {
                            return game.hasPlayer(function(current) {
                                return current != player &&
                                    current.side == player.side;
                            });
                        },
                                "cost": async function(event, trigger, player) {
                            event.result = await player.chooseTarget(
                                '【我是奶龙】：选择一名队友令其弃置1张手牌',
                                function(card, player, target) {
                                    return target != player &&
                                        target.side == player.side;
                                }
                            ).set('ai', function(target) {
                                var player = _status.event.player;
                                var canDiscard = target.countCards('h', function(card) {
                                    return lib.filter.cardDiscardable(card, target);
                                }) > 0;
                                return canDiscard && get.attitude(player, target) > 0 ? 1 : 0;
                            }).forResult();
                        },
                                "content": async function(event, trigger, player) {
                            var target = event.targets[0];
                            if(!target || !target.isIn()) return;
                            var discardable = target.countCards('h', function(card) {
                                return lib.filter.cardDiscardable(card, target);
                            }) > 0;
                            if(!discardable) return;
                            var next = target.chooseToDiscard(
                                'h',
                                1,
                                true,
                                '【我是奶龙】：弃置1张手牌'
                            ).set('filterCard', function(card, target) {
                                return lib.filter.cardDiscardable(card, target);
                            }).set('naiLongSkillSource', player.playerid);
                            await next;
                        },
                            },
                        },
                    },
                    "buShiZhuangTangShiZhenTang": {
                        "audio": "ext:电啸龙吟/audio/skill/naiLong/buShiZhuangTangShiZhenTang.mp3",
                        "trigger": {
                            "global": "shouDaoGongJiBefore",
                        },
                        "forced": true,
                        "filter": function(event, player) {
                    return !!event &&
                        event.target == player &&
                        !!event.player &&
                        event.player != player;
                },
                        "content": async function(event, trigger, player) {
                    var cards = await player.draw(1).forResult();
                    if(cards.length) {
                            await player.showCards(
                                cards,
                                '【不是装唐，是真唐】：展示摸到的牌'
                            );
                            var card = cards[0];
                            if(get.xiBie(card) == get.xiBie(trigger.card)) {
                                trigger.wuFaYingZhan();
                            } else {
                                await player.discard([card])
                                    .set(
                                        'naiLongSkillSource',
                                        player.playerid
                                    );
                                trigger.changeDamageNum(-1);
                            }
                    }
                },
                    },
                    "naiLongDaXiao": {
                        "audio": "ext:电啸龙吟/audio/skill/naiLong/naiLongDaXiao.mp3",
                        "type": "qiDong",
                        "trigger": {
                            "player": "qiDong",
                        },
                        "filter": function(event, player) {
                    return player.canBiShaShuiJing();
                },
                        "content": async function(event, trigger, player) {
                    await player.removeBiShaShuiJing();
                    var targets = [];
                    var current = player;
                    var guard = 0;
                    do {
                        targets.push(current);
                        current = current.getNext();
                        guard++;
                    } while(
                        current &&
                        current != player &&
                        guard < game.players.length
                    );

                    for(var target of targets) {
                        if(!target || !target.isIn()) continue;
                        if(target.countCards('h', function(card) {
                            return lib.filter.cardDiscardable(card, target);
                        }) <= 0) continue;
                        var next = target.chooseToDiscard(
                            'h',
                            1,
                            true,
                            '【奶龙大笑】：弃置1张手牌'
                        ).set('filterCard', function(card, target) {
                            return lib.filter.cardDiscardable(card, target);
                        }).set('ai', function(card) {
                            var target = _status.event.player;
                            var type = get.type(card, target);
                            var actionCards = target.countCards('h', function(current) {
                                var currentType = get.type(current, target);
                                return (currentType == 'gongJi' || currentType == 'faShu') && target.hasUseTarget(current);
                            });
                            if(target === _status.event.player && target.playerid === _status.event.naiLongSkillSource && target.hasUseTarget(card) && actionCards <= 1) {
                                return -20;
                            }
                            return 8 - get.value(card, target);
                        }).set('naiLongSkillSource', player.playerid);
                        await next;
                    }
                },
                        "check": function(event, player) {
                    var discardableHand = player.countCards('h', function(card) {
                        return lib.filter.cardDiscardable(card, player);
                    });
                    if(discardableHand <= 2) return false;
                    var hand = player.getCards('h');
                    var usable = hand.filter(function(card) { return player.hasUseTarget(card); });
                    if(!usable.length || !hand.some(function(card) {
                        return lib.filter.cardDiscardable(card, player) && usable.some(function(keep) { return keep !== card; });
                    })) return false;
                    if(lib.skill._heCheng &&
                        lib.skill._heCheng.filter(event, player) &&
                        (get.shiQi(!player.side) <= 1 ||
                            get.xingBei(player.side) + 1 >= game.xingBeiMax)) {
                        return false;
                    }
                    var score = 0;
                    game.countPlayer(function(target) {
                        if(target.countCards('h') <= 0) return;
                        var needsHealing = target.zhiLiao <
                            target.getZhiLiaoLimit();
                        if(target.side == player.side) {
                            score += needsHealing ? 1 : 0.2;
                        } else {
                            score += needsHealing ? 0 : 0.8;
                        }
                    });
                    return score >= 1.5;
                },
                        "ai": {
                            "shuiJing": true,
                        },
                    },
                    "baiYinWanQi": {
                        "enterState": async function(player, relatedEvent) {
                    if(!player || player.hasSkill('baiYinWanQiZhuangTai')) {
                        return;
                    }
                    var count = player.countZhiShiWu('hongWen');
                    if(count > 0) {
                        await player.removeZhiShiWu('hongWen', count);
                    }
                    var actionPhase = relatedEvent &&
                        typeof relatedEvent.getParent == 'function' &&
                        relatedEvent.getParent('xingDong');
                    player.storage.baiYinWanQiSkipCurrent =
                        !!actionPhase &&
                        actionPhase.name == 'xingDong' &&
                        actionPhase.player == player;
                    player.addSkill('baiYinWanQiZhuangTai');
                    game.broadcastAll(function(speaker) {
                        if(!lib.config.background_speak) return;
                        game.playAudio({
                            path: 'ext:电啸龙吟/audio/skill/dianGunOtto/' +
                                'baiYinWanQi.mp3',
                            spatialPlayer: speaker,
                            addVideo: false,
                            onError: function() {},
                        });
                    }, player);
                    await player.hengZhi();
                },
                        "trigger": {
                            "player": "chengShouShangHaiAfter",
                        },
                        "forced": true,
                        "filter": function(event, player) {
                    return !!event &&
                        event.num > 0 &&
                        !player.hasSkill('baiYinWanQiZhuangTai') &&
                        !player.isZhiShiWuMax('hongWen');
                },
                        "content": async function(event, trigger, player) {
                    await player.addZhiShiWu('hongWen', 1);
                    if(player.countZhiShiWu('hongWen') >= 3) {
                        await lib.skill.baiYinWanQi.enterState(
                            player,
                            trigger
                        );
                    }
                },
                        "group": "baiYinWanQi_zhuCeFangGuan",
                        "subSkill": {
                            "zhuCeFangGuan": {
                                "trigger": {
                                    "global": "gameStart",
                                },
                                "forced": true,
                                "firstDo": true,
                                "popup": false,
                                "content": function() {
                            [
                                'fangGuan',
                                'fangGuan_gongJiJieShu',
                                'fangGuan_xingDongJieShu',
                            ].forEach(function(skill) {
                                game.addGlobalSkill(skill);
                            });
                        },
                            },
                        },
                    },
                    "shuaiOttoShuai": {
                        "audio": "ext:电啸龙吟/audio/skill/dianGunOtto/shuaiOttoShuai.mp3",
                        "trigger": {
                            "player": "gongJiSheZhi",
                        },
                        "filter": function(event, player) {
                    return !!event && event.yingZhan != true;
                },
                        "cost": async function(event, trigger, player) {
                    event.result = await player.chooseBool(
                        '是否发动【帅otto帅】，对自己造成1点法术伤害并令本次攻击伤害额外+2？'
                    ).set('ai', function() {
                        var player = _status.event.player;
                        var trigger = _status.event.getTrigger();
                        var target = trigger && trigger.target;
                        if(!target || target.side == player.side) return false;
                        var selfDamage = player.hasSkill(
                            'baiYinWanQiZhuangTai'
                        ) ? 3 : 1;
                        var score = get.damageEffect2(
                            target, player, 2
                        ) + get.damageEffect2(
                            player, player, selfDamage
                        );
                        if(player.countZhiShiWu('hongWen') >= 2 &&
                            !player.hasSkill('baiYinWanQiZhuangTai')) {
                            score += 1.2;
                        }
                        return score > 0;
                    }).forResult();
                },
                        "content": async function(event, trigger, player) {
                    await player.faShuDamage(1, player);
                    trigger.changeDamageNum(2);
                },
                    },
                    "zunNiHuoJia": {
                        "audio": "ext:电啸龙吟/audio/skill/dianGunOtto/zunNiHuoJia.mp3",
                        "type": "faShu",
                        "enable": "faShu",
                        "position": "h",
                        "selectCard": 1,
                        "discard": true,
                        "showCards": true,
                        "filterCard": function(card, player) {
                    return get.type(card) == 'faShu' &&
                        lib.filter.cardDiscardable(card, player);
                },
                        "filter": function(event, player) {
                    if(!player.countCards('h', function(card) {
                        return lib.skill.zunNiHuoJia
                            .filterCard(card, player);
                    })) return false;
                    return game.hasPlayer(function(current) {
                        return current.side != player.side &&
                            current.countZhiShiWu('fangGuan') == 0;
                    });
                },
                        "filterTarget": function(card, player, target) {
                    return target.side != player.side &&
                        target.countZhiShiWu('fangGuan') == 0;
                },
                        "content": async function(event, trigger, player) {
                    var target = event.target;
                    target.storage.fangGuanSource = player.playerid;
                    target.syncStorage('fangGuanSource');
                    await target.addZhiShiWu('fangGuan', 1, true);
                    if(target.countZhiShiWu('fangGuan') == 0) {
                        delete target.storage.fangGuanSource;
                        target.syncStorage('fangGuanSource');
                    }
                },
                        "ai": {
                            "order": 3.5,
                            "result": {
                                "target": -1,
                            },
                        },
                    },
                    "dianGunShengJing": {
                        "audio": "ext:电啸龙吟/audio/skill/dianGunOtto/dianGunShengJing.mp3",
                        "trigger": {
                            "player": "changeShiQiEnd",
                        },
                        "filter": function(event, player) {
                    return !!event &&
                        event.player == player &&
                        event.num < 0 &&
                        event.cause == 'damage' &&
                        player.hasSkill('baiYinWanQiZhuangTai') &&
                        player.canBiShaBaoShi() &&
                        game.hasPlayer(function(current) {
                            return current.side != player.side;
                        });
                },
                        "cost": async function(event, trigger, player) {
                    var targets = (await player.chooseTarget(
                        '是否发动【电棍圣经】，指定一名对手？',
                        function(card, player, target) {
                            return target.side != player.side;
                        }
                    ).set('ai', function(target) {
                        return get.damageEffect2(
                            target,
                            _status.event.player,
                            Math.max(
                                1,
                                -_status.event.getTrigger().num
                            )
                        );
                    }).forResultTargets() || []);
                    event.result = {
                        bool: targets.length > 0,
                        targets: targets,
                        cost_data: Math.max(0, -trigger.num),
                    };
                },
                        "content": async function(event, trigger, player) {
                    await player.removeBiShaBaoShi();
                    var primary = event.targets[0];
                    var damage = Math.max(0, event.cost_data || 0);
                    if(primary && primary.isIn()) {
                        await primary.faShuDamage(damage, player);
                    }
                    var others = game.filterPlayer(function(current) {
                        return current.side != player.side &&
                            current != primary;
                    }).sortBySeat(player);
                    for(var target of others) {
                        if(target.isIn()) {
                            await target.faShuDamage(1, player);
                        }
                    }
                    await player.chongZhi();
                    player.removeSkill('baiYinWanQiZhuangTai');
                },
                        "ai": {
                            "baoShi": true,
                        },
                    },
                    "hongWen": {
                        "intro": {
                            "name": "红温",
                            "content": "mark",
                            "max": 3,
                        },
                        "onremove": "storage",
                        "markimage": "extension/电啸龙吟/mark_hongWen.webp",
                    },
                    "fangGuan": {
                        "charlotte": true,
                        "intro": {
                            "name": "专属卡【房管】",
                            "content": "下个行动阶段内首次主动攻击只能指定电棍Otto；攻击行动结束后移除。行动阶段结束时仍存在，则电棍Otto对拥有者造成2点法术伤害。",
                            "max": 1,
                        },
                        "markimage": "extension/电啸龙吟/mark_fangGuan.webp",
                        "mod": {
                            "playerEnabled": function(card, source, target) {
                        if(!source ||
                            source.countZhiShiWu('fangGuan') == 0 ||
                            get.type(card) != 'gongJi') return;
                        var current = _status.event;
                        var guard = 0;
                        while(current && guard < 20) {
                            if(current.name == '_yingZhan') return;
                            if(typeof current.getParent != 'function') break;
                            var parent = current.getParent();
                            if(!parent || parent == current) break;
                            current = parent;
                            guard++;
                        }
                        var id = source.storage.fangGuanSource;
                        var otto = game.players.find(function(current) {
                            return current.playerid == id;
                        });
                        if(!otto || !otto.isIn() || target != otto) {
                            return false;
                        }
                    },
                        },
                        "onremove": function(player) {
                    delete player.storage.fangGuan;
                    delete player.storage.fangGuanSource;
                    player.syncStorage('fangGuanSource');
                },
                        "subSkill": {
                            "gongJiJieShu": {
                                "trigger": {
                                    "global": "gongJiEnd",
                                },
                                "forced": true,
                                "popup": false,
                                "filter": function(event, player) {
                            if(!event || !event.player ||
                                event.player.countZhiShiWu('fangGuan') == 0 ||
                                event.yingZhan == true) return false;
                            var phase = event.getParent &&
                                event.getParent('xingDong');
                            return !!phase &&
                                phase.name == 'xingDong' &&
                                phase.player == event.player;
                        },
                                "content": async function(event, trigger, player) {
                            var holder = trigger.player;
                            var count = holder.countZhiShiWu('fangGuan');
                            if(count > 0) {
                                await holder.removeZhiShiWu(
                                    'fangGuan',
                                    count
                                );
                            }
                            delete holder.storage.fangGuanSource;
                            holder.syncStorage('fangGuanSource');
                        },
                            },
                            "xingDongJieShu": {
                                "trigger": {
                                    "global": "xingDongEnd",
                                },
                                "forced": true,
                                "lastDo": true,
                                "popup": false,
                                "filter": function(event, player) {
                            return !!event &&
                                !!event.player &&
                                event.player.countZhiShiWu('fangGuan') > 0;
                        },
                                "content": async function(event, trigger, player) {
                            var holder = trigger.player;
                            var id = holder.storage.fangGuanSource;
                            var source = game.players.find(function(current) {
                                return current.playerid == id;
                            });
                            if(holder.isIn()) {
                                if(source && source.isIn()) {
                                    await holder.faShuDamage(2, source);
                                } else {
                                    await holder.faShuDamage(2, 'nosource');
                                }
                            }
                            var count = holder.countZhiShiWu('fangGuan');
                            if(count > 0) {
                                await holder.removeZhiShiWu(
                                    'fangGuan',
                                    count
                                );
                            }
                            delete holder.storage.fangGuanSource;
                            holder.syncStorage('fangGuanSource');
                        },
                            },
                        },
                    },
                    "baiYinWanQiZhuangTai": {
                        "charlotte": true,
                        "mark": true,
                        "marktext": "温",
                        "intro": {
                            "name": "白银晚期",
                            "content": "造成和承受的伤害额外+1，不能获得【红温】；持续到下个行动阶段结束。",
                        },
                        "group": [
                            "baiYinWanQiZhuangTai_zaoCheng",
                            "baiYinWanQiZhuangTai_chengShou",
                            "baiYinWanQiZhuangTai_jinZhiHongWen",
                            "baiYinWanQiZhuangTai_qingChu",
                        ],
                        "onremove": function(player) {
                    delete player.storage.baiYinWanQiSkipCurrent;
                },
                        "subSkill": {
                            "zaoCheng": {
                                "trigger": {
                                    "source": "zaoChengShangHai",
                                },
                                "forced": true,
                                "firstDo": true,
                                "content": function(event, trigger, player) {
                            trigger.changeDamageNum(1);
                        },
                            },
                            "chengShou": {
                                "trigger": {
                                    "player": "chengShouShangHaiBefore",
                                },
                                "forced": true,
                                "firstDo": true,
                                "content": function(event, trigger, player) {
                            trigger.changeDamageNum(1);
                        },
                            },
                            "jinZhiHongWen": {
                                "trigger": {
                                    "player": "changeZhiShiWuBefore",
                                },
                                "forced": true,
                                "firstDo": true,
                                "priority": 100,
                                "popup": false,
                                "filter": function(event, player) {
                            return !!event &&
                                event.zhiShiWu == 'hongWen' &&
                                event.num > 0;
                        },
                                "content": function(event, trigger, player) {
                            trigger.num = 0;
                        },
                            },
                            "qingChu": {
                                "trigger": {
                                    "player": "xingDongEnd",
                                },
                                "forced": true,
                                "lastDo": true,
                                "popup": false,
                                "content": async function(event, trigger, player) {
                            if(player.storage.baiYinWanQiSkipCurrent) {
                                player.storage.baiYinWanQiSkipCurrent = false;
                                return;
                            }
                            await player.chongZhi();
                            player.removeSkill('baiYinWanQiZhuangTai');
                        },
                            },
                        },
                    },
                    "suanFaTuiJian": {
                        "playAudio": function(file, player) {
                    game.broadcastAll(function(path, speaker) {
                        if(!lib.config.background_speak) return;
                        game.playAudio({
                            path: path,
                            spatialPlayer: speaker,
                            addVideo: false,
                            onError: function() {},
                        });
                    }, 'ext:电啸龙吟/audio/skill/yongChuTaFei/' +
                        file + '.mp3', player);
                },
                        "hotSkill": function(type) {
                    return {
                        gongJi: 'gongJiReBang',
                        faShu: 'faShuReBang',
                        teShu: 'teShuReBang',
                    }[type];
                },
                        "eventActionType": function(event, triggername) {
                    if(!event) return null;
                    var name=triggername || event.triggername;
                    if(name=='gongJiEnd') return 'gongJi';
                    if(name=='faShuEnd') return 'faShu';
                    if(name=='teShuEnd') return 'teShu';
                    name=event.name;
                    if(name=='gongJi'||name=='gongJiEnd') return 'gongJi';
                    if(name=='faShu'||name=='faShuEnd') return 'faShu';
                    if(name=='teShu'||name=='teShuEnd') return 'teShu';
                    return null;
                },
                        "isCompletedAction": function(event, triggername) {
                    if(!event || !event.player) return false;
                    var type=lib.skill.suanFaTuiJian
                        .eventActionType(event, triggername);
                    if(type=='gongJi' &&
                        event.yingZhan == true) {
                        return false;
                    }
                    if(type=='teShu') return true;
                    return !!type&&_status.currentPhase==event.player;
                },
                        "actionType": function(event, triggername) {
                    return lib.skill.suanFaTuiJian
                        .eventActionType(event, triggername);
                },
                        "setHot": async function(player, type) {
                    var old = player.storage.yongChuTaFeiReBang;
                    var oldSkill = lib.skill.suanFaTuiJian.hotSkill(old);
                    if(oldSkill && player.countZhiShiWu(oldSkill) > 0) {
                        await player.removeZhiShiWu(
                            oldSkill,
                            player.countZhiShiWu(oldSkill)
                        );
                    }
                    player.storage.yongChuTaFeiReBang = type;
                    player.syncStorage('yongChuTaFeiReBang');
                    var skill = lib.skill.suanFaTuiJian.hotSkill(type);
                    if(skill) await player.addZhiShiWu(skill, 1, true);
                },
                        "clearHot": async function(player) {
                    var old = player.storage.yongChuTaFeiReBang;
                    var skill = lib.skill.suanFaTuiJian.hotSkill(old);
                    if(skill && player.countZhiShiWu(skill) > 0) {
                        await player.removeZhiShiWu(
                            skill,
                            player.countZhiShiWu(skill)
                        );
                    }
                    delete player.storage.yongChuTaFeiReBang;
                    player.syncStorage('yongChuTaFeiReBang');
                },
                        "trigger": {
                            "global": "phaseEnd",
                        },
                        "forced": true,
                        "priority": 10,
                        "filter": function(event, player) {
                    return !!event.player &&
                        !!event.player.storage.yongChuTaFeiLastAction;
                },
                        "content": async function(event, trigger, player) {
                    var actor = trigger.player;
                    var type = actor.storage.yongChuTaFeiLastAction;
                    var hot = player.storage.yongChuTaFeiReBang;
                    if(!hot) {
                        await lib.skill.suanFaTuiJian.setHot(player, type);
                        return;
                    }
                    if(hot != type) {
                        if(actor != player &&
                            player.countZhiShiWu(
                                'yongChuTaFeiLiuLiang'
                            ) >= 3) {
                            player.logSkill('guanZhuTaFeiMiao', actor);
                            lib.skill.suanFaTuiJian.playAudio(
                                'guanZhuTaFeiMiao', player
                            );
                            await actor.faShuDamage(2, player);
                        } else {
                            await lib.skill.suanFaTuiJian.setHot(
                                player,
                                type
                            );
                        }
                        return;
                    }
                    if(actor != player) {
                        await player.addZhiShiWu(
                            'yongChuTaFeiLiuLiang',
                            1
                        );
                        await actor.changeZhiLiao(1, player);
                    }
                },
                        "group": [
                            "suanFaTuiJian_jiLuGongJi",
                            "suanFaTuiJian_jiLuFaShu",
                            "suanFaTuiJian_jiLuTeShu",
                            "suanFaTuiJian_chongZhi",
                            "suanFaTuiJian_kaiJu",
                            "suanFaTuiJian_liuLiangYinXiao",
                        ],
                        "subSkill": {
                            "jiLuGongJi": {
                                "trigger": {
                                    "global": "gongJiEnd",
                                },
                                "forced": true,
                                "lastDo": true,
                                "priority": -100,
                                "popup": false,
                                "filter": function(event, player) {
                            return !!event.player&&
                                event.player==_status.currentPhase&&
                                event.yingZhan!=true;
                        },
                                "content": function(event, trigger, player) {
                            trigger.player.storage
                                .yongChuTaFeiLastAction='gongJi';
                            trigger.player.syncStorage(
                                'yongChuTaFeiLastAction'
                            );
                        },
                            },
                            "jiLuFaShu": {
                                "trigger": {
                                    "global": "faShuEnd",
                                },
                                "forced": true,
                                "lastDo": true,
                                "priority": -100,
                                "popup": false,
                                "filter": function(event,player){
                            return !!event.player&&
                                event.player==_status.currentPhase;
                        },
                                "content": function(event,trigger,player){
                            trigger.player.storage
                                .yongChuTaFeiLastAction='faShu';
                            trigger.player.syncStorage(
                                'yongChuTaFeiLastAction'
                            );
                        },
                            },
                            "jiLuTeShu": {
                                "trigger": {
                                    "global": "teShuEnd",
                                },
                                "forced": true,
                                "lastDo": true,
                                "priority": -100,
                                "popup": false,
                                "filter": function(event,player){
                            return !!event.player;
                        },
                                "content": function(event,trigger,player){
                            trigger.player.storage
                                .yongChuTaFeiLastAction='teShu';
                            trigger.player.syncStorage(
                                'yongChuTaFeiLastAction'
                            );
                        },
                            },
                            "chongZhi": {
                                "trigger": {
                                    "global": "phaseBegin",
                                },
                                "forced": true,
                                "firstDo": true,
                                "priority": 100,
                                "popup": false,
                                "content": function(event, trigger, player) {
                            delete trigger.player.storage
                                .yongChuTaFeiLastAction;
                            trigger.player.syncStorage(
                                'yongChuTaFeiLastAction'
                            );
                        },
                            },
                            "kaiJu": {
                                "trigger": {
                                    "global": "gameStart",
                                },
                                "forced": true,
                                "firstDo": true,
                                "priority": 100,
                                "popup": false,
                                "content": async function(event, trigger, player) {
                            await lib.skill.suanFaTuiJian
                                .clearHot(player);
                        },
                            },
                            "liuLiangYinXiao": {
                                "trigger": {
                                    "player": "changeZhiShiWuAfter",
                                },
                                "forced": true,
                                "popup": false,
                                "filter": function(event, player) {
                            return !!event &&
                                event.zhiShiWu ==
                                    'yongChuTaFeiLiuLiang' &&
                                event.num > 0 &&
                                player.countZhiShiWu(
                                    'yongChuTaFeiLiuLiang'
                                ) == 3;
                        },
                                "content": function(event, trigger, player) {
                            lib.skill.suanFaTuiJian.playAudio(
                                'suanFaTuiJian', player
                            );
                        },
                            },
                        },
                    },
                    "guoQiZhuBao": {
                        "trigger": {
                            "player": "phaseEnd",
                        },
                        "forced": true,
                        "priority": -10,
                        "filter": function(event, player) {
                    return player.countZhiShiWu(
                        'yongChuTaFeiLiuLiang'
                    ) > 0;
                },
                        "content": async function(event, trigger, player) {
                    lib.skill.suanFaTuiJian.playAudio('guoQiZhuBao', player);
                    await player.removeZhiShiWu(
                        'yongChuTaFeiLiuLiang',
                        1
                    );
                    await player.changeZhiLiao(1, player);
                },
                    },
                    "guanZhuTaFeiMiao": {
                        "charlotte": true,
                    },
                    "qianShiHeiTaoYing": {
                        "findYingZhan": function(event) {
                    var current = event;
                    var guard = 0;
                    while(current && guard < 12) {
                        if(current.name == 'yingZhan') return current;
                        if(typeof current.getParent != 'function') break;
                        var parent = current.getParent();
                        if(!parent || parent == current) break;
                        current = parent;
                        guard++;
                    }
                    return null;
                },
                        "isDirectResponseToActiveAttack": function(yingZhan, player) {
                    if(!yingZhan || yingZhan.source != player) return false;
                    var parent = typeof yingZhan.getParent == 'function' ?
                        yingZhan.getParent() : null;
                    return !!parent && parent.yingZhan != true;
                },
                        "findBoundAttack": function(event, player) {
                    var current = event;
                    var guard = 0;
                    while(current && guard < 16) {
                        if(current.qianShiHeiTaoYingOwner ==
                            player.playerid) return current;
                        if(current.type=='gongJi'||
                            (current.name=='useCard'&&current.card&&
                                get.type(current.card)=='gongJi')){
                            return null;
                        }
                        if(typeof current.getParent != 'function') break;
                        var parent = current.getParent();
                        if(!parent || parent == current) break;
                        current = parent;
                        guard++;
                    }
                    return null;
                },
                        "group": [
                            "qianShiHeiTaoYing_bangDing",
                            "qianShiHeiTaoYing_mingZhong",
                            "qianShiHeiTaoYing_weiMingZhong",
                            "qianShiHeiTaoYing_zhuanYi",
                        ],
                        "subSkill": {
                            "bangDing": {
                                "trigger": {
                                    "global": "gongJiBefore",
                                },
                                "forced": true,
                                "firstDo": true,
                                "priority": 100,
                                "popup": false,
                                "filter": function(event, player) {
                            if(!event || event.yingZhan != true) return false;
                            var yingZhan = lib.skill.qianShiHeiTaoYing
                                .findYingZhan(event);
                            return lib.skill.qianShiHeiTaoYing
                                .isDirectResponseToActiveAttack(
                                    yingZhan,
                                    player
                                );
                        },
                                "content": async function(event, trigger, player) {
                            trigger.qianShiHeiTaoYingOwner =
                                player.playerid;
                            if(trigger.target && trigger.target.isIn()) {
                                await trigger.target.changeZhiLiao(
                                    1,
                                    player
                                );
                            }
                        },
                            },
                            "mingZhong": {
                                "trigger": {
                                    "global": "gongJiMingZhong",
                                },
                                "forced": true,
                                "filter": function(event, player) {
                            return !!lib.skill.qianShiHeiTaoYing
                                .findBoundAttack(event, player);
                        },
                                "content": async function(event, trigger, player) {
                            lib.skill.suanFaTuiJian.playAudio(
                                'qianShiHeiTaoYing', player
                            );
                            await player.addZhiShiWu(
                                'yongChuTaFeiLiuLiang',
                                1
                            );
                        },
                            },
                            "weiMingZhong": {
                                "trigger": {
                                    "global": "gongJiEnd",
                                },
                                "forced": true,
                                "filter": function(event, player) {
                            return !event.gongJiMingZhong &&
                                !!lib.skill.qianShiHeiTaoYing
                                    .findBoundAttack(event, player);
                        },
                                "content": async function(event, trigger, player) {
                            await player.changeZhiLiao(1, player);
                        },
                            },
                            "zhuanYi": {
                                "trigger": {
                                    "global": "chengShouShangHai",
                                },
                                "forced": true,
                                "lastDo": true,
                                "priority": -100,
                                "filter": function(event, player) {
                            if(!event || event.faShu == true ||
                                event.player == player ||
                                event.qianShiHeiTaoYingTransfer ||
                                !(event.num > 0)) {
                                return false;
                            }
                            var attack=lib.skill.qianShiHeiTaoYing
                                .findBoundAttack(event,player);
                            return !!attack&&event.player==attack.target&&
                                (!event.source||event.source==attack.player);
                        },
                                "content": async function(event, trigger, player) {
                            var num = Math.max(0, trigger.num || 0);
                            var source = trigger.source;
                            trigger.num = 0;
                            if(num > 0 && player.isIn()) {
                                await player.damage(num, source)
                                    .set('step', 6)
                                    .set(
                                        'qianShiHeiTaoYingTransfer',
                                        true
                                    );
                            }
                        },
                            },
                        },
                    },
                    "qianShiYiBaoShuTiaoXiXi": {
                        "trigger": {
                            "player": "phaseBegin",
                        },
                        "filter": function(event, player) {
                    return player.countZhiShiWu(
                        'yongChuTaFeiLiuLiang'
                    ) > 0 &&
                        player.countCards('h') > 0;
                },
                        "cost": async function(event, trigger, player) {
                    event.result = await player.chooseCard(
                        'h',
                        1,
                        '【前世·一包薯条嘻嘻】：移除1【流量】，将1张手牌面朝下置于角色旁作为【薯条】'
                    ).set('ai', function(card) {
                        return 6 - get.value(card);
                    }).forResult();
                },
                        "content": async function(event, trigger, player) {
                    lib.skill.suanFaTuiJian.playAudio(
                        'qianShiYiBaoShuTiaoXiXi', player
                    );
                    await player.removeZhiShiWu(
                        'yongChuTaFeiLiuLiang',
                        1
                    );
                    await player.loseToSpecial(
                        event.cards,
                        'yongChuTaFeiShuTiao',
                        player
                    );
                    player.markSkill('yongChuTaFeiShuTiao');
                },
                    },
                    "yongChuTaFeiShuTiao": {
                        "markimage": "extension/电啸龙吟/mark_taFeiShuTiao.webp",
                        "intro": {
                            "name": "薯条",
                            "mark": function(dialog, storage, player) {
                        var cards = player.getCards('s', function(card) {
                            return card.hasGaintag && card.hasGaintag(
                                'yongChuTaFeiShuTiao'
                            );
                        });
                        if(!cards.length) return;
                        if(player.isUnderControl(true)) {
                            dialog.addAuto(cards);
                        } else {
                            return '共有' + cards.length + '张牌';
                        }
                    },
                            "markcount": function(storage, player) {
                        return player.getCards('s', function(card) {
                            return card.hasGaintag && card.hasGaintag(
                                'yongChuTaFeiShuTiao'
                            );
                        }).length;
                    },
                        },
                        "onremove": function(player, skill) {
                    var cards = player.getCards('s', function(card) {
                        return card.hasGaintag && card.hasGaintag(skill);
                    });
                    if(cards.length) player.loseToDiscardpile(cards);
                },
                    },
                    "yuanShengYao": {
                        "trigger": {
                            "global": [
                                "gongJiEnd",
                                "faShuEnd",
                                "teShuEnd",
                            ],
                        },
                        "filter": function(event, player, triggername) {
                    return !!event && event.player == player &&
                        lib.skill.suanFaTuiJian
                        .isCompletedAction(event, triggername) &&
                        player.storage.yongChuTaFeiReBang ==
                            lib.skill.suanFaTuiJian.actionType(
                                event,
                                triggername
                            ) &&
                        player.countZhiShiWu(
                            'yongChuTaFeiLiuLiang'
                        ) >= 3 &&
                        player.canBiShaShuiJing();
                },
                        "cost": async function(event, trigger, player) {
                    event.result = await player.chooseBool(
                        '是否发动【原生摇】？'
                    ).set('ai', function() {
                        var player = _status.event.player;
                        if(lib.skill._heCheng &&
                            lib.skill._heCheng.filter(
                                _status.event,
                                player
                            ) && (get.shiQi(!player.side) <= 1 ||
                                get.xingBei(player.side) + 1 >=
                                    game.xingBeiMax)) {
                            return false;
                        }
                        var overflow = Math.max(0,
                            player.countCards('h') + 1 -
                            player.getHandcardLimit());
                        if(overflow >= get.shiQi(player.side)) return false;
                        return overflow <= 1;
                    }).forResult();
                },
                        "content": async function(event, trigger, player) {
                    var phase = trigger.getParent &&
                        trigger.getParent('phase');
                    lib.skill.suanFaTuiJian.playAudio('yuanShengYao', player);
                    await player.removeBiShaShuiJing();
                    await player.removeZhiShiWu(
                        'yongChuTaFeiLiuLiang',
                        3
                    );
                    await player.draw(1);
                    await lib.skill.suanFaTuiJian.clearHot(player);
                    player.storage.yongChuTaFeiExtraTurn = true;
                    player.insertPhase('yuanShengYao', true);
                    if(phase && phase.player == player) phase.finish();
                },
                        "ai": {
                            "shuiJing": true,
                        },
                    },
                    "yongChuTaFeiLiuLiang": {
                        "intro": {
                            "name": "流量",
                            "content": "mark",
                            "max": 3,
                        },
                        "onremove": "storage",
                        "markimage": "extension/电啸龙吟/mark_taFeiLiuLiang.webp",
                    },
                    "gongJiReBang": {
                        "charlotte": true,
                        "intro": {
                            "name": "攻击热榜",
                            "content": "当前【热榜】为【攻击行动】。",
                            "max": 1,
                        },
                        "markimage": "extension/电啸龙吟/mark_gongJiReBang.webp",
                    },
                    "faShuReBang": {
                        "charlotte": true,
                        "intro": {
                            "name": "法术热榜",
                            "content": "当前【热榜】为【法术行动】。",
                            "max": 1,
                        },
                        "markimage": "extension/电啸龙吟/mark_faShuReBang.webp",
                    },
                    "teShuReBang": {
                        "charlotte": true,
                        "intro": {
                            "name": "特殊热榜",
                            "content": "当前【热榜】为【特殊行动】。",
                            "max": 1,
                        },
                        "markimage": "extension/电啸龙吟/mark_teShuReBang.webp",
                    },
                },
                "translate": {
                    "hongWen": "红温",
                    "hongWen_info": "电棍Otto的专属指示物，上限为3。",
                    "baiYinWanQi": "被动【白银晚期】",
                    "baiYinWanQi_info": "<span class='tiaoJian'>（承受实际伤害后⑤）</span>+1<span class='hong'>【红温】</span>。<br><span class='tiaoJian'>（</span><span class='hong'>【红温】</span><span class='tiaoJian'>达到上限时）</span>移除全部<span class='hong'>【红温】</span>并【横置】，进入【白银晚期】状态：你造成和承受的伤害额外+1，且不能获得<span class='hong'>【红温】</span>。<span class='tiaoJian'>（下个行动阶段结束）</span>【重置】。",
                    "baiYinWanQiZhuangTai": "白银晚期",
                    "baiYinWanQiZhuangTai_info": "你造成和承受的伤害额外+1；你不能获得<span class='hong'>【红温】</span>。持续到你的下个行动阶段结束。",
                    "shuaiOttoShuai": "响应【帅otto帅】",
                    "shuaiOttoShuai_info": "<span class='tiaoJian'>（主动攻击前①）</span>对自己造成1点法术伤害③，本次攻击伤害额外+2。",
                    "zunNiHuoJia": "法术【尊尼获加】",
                    "zunNiHuoJia_info": "<span class='tiaoJian'>（弃置1张法术牌【展示】）</span>对1名目标对手施加【房管】。",
                    "fangGuan": "专属【房管】",
                    "fangGuan_info": "持有者下个行动阶段内主动攻击只能以电棍Otto为目标，该【攻击行动】结束后移除。<span class='tiaoJian'>（其行动阶段结束时）</span>若【房管】仍存在，电棍Otto对其造成2点法术伤害③，移除此卡。",
                    "dianGunShengJing": "响应【电棍圣经】",
                    "dianGunShengJing_info": "<span style=\"color:#E02B17\">【宝石】</span><span class='tiaoJian'>（【白银晚期】下，因承受伤害导致士气下降时）</span>对目标对手造成X点法术伤害③，对其他所有对手各造成1点法术伤害③，然后【重置】，X为本次士气下降数。",
                    "woShiNaiLong": "被动【我是奶龙】",
                    "woShiNaiLong_info": "<span class='tiaoJian'>（目标角色因你的技能弃牌后）</span>该角色+1【治疗】；<br><span class='tiaoJian'>（你的攻击命中后②）</span>令1名队友弃置1张手牌。",
                    "buShiZhuangTangShiZhenTang": "响应【不是装唐，是真唐】",
                    "buShiZhuangTangShiZhenTang_info": "<span class='tiaoJian'>（成为其他角色攻击的目标时①）</span>摸1张牌【强制】并展示：<span class='tiaoJian'>（若与本次攻击同系）</span>保留该牌且本次攻击无法应战；否则弃置该牌，本次攻击伤害-1。",
                    "naiLongDaXiao": "启动【奶龙大笑】",
                    "naiLongDaXiao_info": "<span class='lan'>【水晶】</span>从你开始，每名角色按座次依次弃置1张手牌。",
                    "suanFaTuiJian": "被动【算法推荐】",
                    "suanFaTuiJian_info": "游戏开始时没有【热榜】。<span class='tiaoJian'>（角色回合结束时）</span>记录其本回合最后完成的行动类型：<span class='tiaoJian'>（没有【热榜】或类型不同时）</span>放置或替换为对应【热榜】；<span class='tiaoJian'>（类型相同且该角色不是你时）</span>你+1<span style=\"color:#B33D75\">【流量】</span>，其+1【治疗】。",
                    "guoQiZhuBao": "被动【过气主包】",
                    "guoQiZhuBao_info": "<span class='tiaoJian'>（回合结束时，若</span><span style=\"color:#B33D75\">【流量】</span><span class='tiaoJian'>＞0）</span>移除1点，你+1【治疗】。",
                    "guanZhuTaFeiMiao": "被动【关注塔菲喵】",
                    "guanZhuTaFeiMiao_info": "<span class='tiaoJian'>（拥有3</span><span style=\"color:#B33D75\">【流量】</span><span class='tiaoJian'>时，其他角色回合结束后）</span>若其最后完成的行动类型与【热榜】不同，不替换【热榜】，改为对其造成2点法术伤害③。",
                    "qianShiHeiTaoYing": "被动【前世·黑桃影】",
                    "qianShiHeiTaoYing_info": "<span class='tiaoJian'>（你的主动攻击被成功应战时）</span>应战攻击的目标+1【治疗】。<span class='tiaoJian'>（本次应战攻击命中时）</span>其实际伤害由你承受，你+1<span style=\"color:#B33D75\">【流量】</span>；<span class='tiaoJian'>（未命中时）</span>你+1【治疗】。",
                    "qianShiYiBaoShuTiaoXiXi": "响应【前世·一包薯条嘻嘻】",
                    "qianShiYiBaoShuTiaoXiXi_info": "<span class='tiaoJian'>（你的回合开始时）</span>移除1<span style=\"color:#B33D75\">【流量】</span>，将1张手牌面朝下置于角色旁，作为【薯条】。你可以将【薯条】如手牌般打出或使用。",
                    "yuanShengYao": "响应【原生摇】",
                    "yuanShengYao_info": "<span class='lan'>【水晶】</span><span class='tiaoJian'>（拥有3</span><span style=\"color:#B33D75\">【流量】</span><span class='tiaoJian'>时，完整结算1个与【热榜】同类型的合法行动后，移除3</span><span style=\"color:#B33D75\">【流量】</span><span class='tiaoJian'>）</span>摸1张牌【强制】，移除【热榜】，结束当前回合并立即开始1个新的完整回合。",
                    "yongChuTaFeiLiuLiang": "流量",
                    "yongChuTaFeiLiuLiang_info": "永雏塔菲的专属指示物，上限为3。",
                    "gongJiReBang": "专属【攻击热榜】",
                    "gongJiReBang_info": "记录【攻击行动】；3种【热榜】合计上限为1。",
                    "faShuReBang": "专属【法术热榜】",
                    "faShuReBang_info": "记录【法术行动】；3种【热榜】合计上限为1。",
                    "teShuReBang": "专属【特殊热榜】",
                    "teShuReBang_info": "记录【特殊行动】；3种【热榜】合计上限为1。",
                    "yongChuTaFeiShuTiao": "专属【薯条】",
                    "yongChuTaFeiShuTiao_info": "永雏塔菲的专属牌，面朝下置于角色旁且仅自己可见。",
                },
            },
            "intro": "添加角色奶龙、电棍Otto、永雏塔菲。",
            "author": "蒙牛",
            "diskURL": "",
            "forumURL": "",
            "version": "1.19",
        },
        "files": {
            "character": [
                "naiLong.jpg",
                "otto.jpg",
                "yongChuTaFei.jpg",
            ],
            "card": [],
            "skill": [
                "mark_hongWen.webp",
                "mark_fangGuan.webp",
                "mark_taFeiLiuLiang.webp",
                "mark_taFeiShuTiao.webp",
                "mark_gongJiReBang.webp",
                "mark_faShuReBang.webp",
                "mark_teShuReBang.webp",
            ],
            "audio": [
                "audio/skill/dianGunOtto/baiYinWanQi.mp3",
                "audio/skill/dianGunOtto/shuaiOttoShuai.mp3",
                "audio/skill/dianGunOtto/zunNiHuoJia.mp3",
                "audio/skill/dianGunOtto/dianGunShengJing.mp3",
                "audio/action/dianGunOtto/gouMai.mp3",
                "audio/action/dianGunOtto/heCheng.mp3",
                "audio/action/dianGunOtto/tiLian.mp3",
                "audio/skill/naiLong/woShiNaiLong.mp3",
                "audio/skill/naiLong/buShiZhuangTangShiZhenTang.mp3",
                "audio/skill/naiLong/naiLongDaXiao.mp3",
                "audio/action/naiLong/gouMai.mp3",
                "audio/action/naiLong/heCheng.mp3",
                "audio/action/naiLong/tiLian.mp3",
                "audio/skill/yongChuTaFei/suanFaTuiJian.mp3",
                "audio/skill/yongChuTaFei/guoQiZhuBao.mp3",
                "audio/skill/yongChuTaFei/guanZhuTaFeiMiao.mp3",
                "audio/skill/yongChuTaFei/qianShiHeiTaoYing.mp3",
                "audio/skill/yongChuTaFei/qianShiYiBaoShuTiaoXiXi.mp3",
                "audio/skill/yongChuTaFei/yuanShengYao.mp3",
                "audio/action/yongChuTaFei/gouMai.mp3",
                "audio/action/yongChuTaFei/heCheng.mp3",
                "audio/action/yongChuTaFei/tiLian.mp3",
                "audio/skill/naiLong/woShiNaiLong.mp3",
                "audio/skill/naiLong/buShiZhuangTangShiZhenTang.mp3",
                "audio/skill/naiLong/naiLongDaXiao.mp3",
                "audio/action/naiLong/gouMai.mp3",
                "audio/action/naiLong/heCheng.mp3",
                "audio/action/naiLong/tiLian.mp3",
            ],
        },
        "connect": true,
    };
}));
});
