/* ================================================================
 * 插件 / 用户脚本系统（#14）
 *
 * 设计：纯 JS 无打包器下的沙箱隔离 = iframe sandbox + postMessage。
 * - 每个插件 .js 文件注入一个 <iframe sandbox="allow-scripts">（无 allow-same-origin，
 *   插件代码运行在独立 origin，拿不到主应用的 DOM / localStorage / 全局变量）。
 * - 插件通过注入的全局 `emerald` 桥与主应用通信：
 *     emerald.registerCommand({ id, label, run })  注册命令（挂进命令面板）
 *     emerald.showNotice(msg) / getCurrentFile() / openFile(p) /
 *     readFile(p) / writeFile(p, c) / getWorkspace() / log(...)
 * - 两个通信方向：
 *     插件 → 主应用：postMessage({ t:'api', reqId, method, args })，
 *        主应用执行 PluginManager.api[method] 后回 postMessage({ t:'resp', reqId, data })
 *     主应用 → 插件：runCommand 时 postMessage({ t:'runCommand', id })，
 *        插件内桥调用注册的 run()
 * - 所有来自 iframe 的消息都校验 e.source 必须是已知插件的 contentWindow。
 * ================================================================ */
;(function () {
    'use strict'

    // 桥代码：这段字符串被注入到每个插件的 iframe 里执行
    const BRIDGE = `(function () {
    var reqSeq = 0
    var pending = {}
    var commands = {}
    function call(method, args) {
        return new Promise(function (resolve) {
            var reqId = ++reqSeq
            pending[reqId] = resolve
            parent.postMessage({ t: 'api', reqId: reqId, method: method, args: args || [] }, '*')
        })
    }
    window.addEventListener('message', function (e) {
        var d = e.data || {}
        if (d.t === 'resp') {
            var p = pending[d.reqId]
            if (p) { delete pending[d.reqId]; p(d.data) }
        } else if (d.t === 'runCommand') {
            var fn = commands[d.id]
            if (fn) {
                try { fn() }
                catch (err) { parent.postMessage({ t: 'error', id: d.id, error: String(err && err.message || err) }, '*') }
            }
        }
    })
    window.emerald = {
        registerCommand: function (cmd) {
            if (cmd && cmd.id && typeof cmd.run === 'function') {
                commands[cmd.id] = cmd.run
                parent.postMessage({ t: 'registerCommand', cmd: { id: String(cmd.id), label: String(cmd.label || cmd.id) } }, '*')
            }
        },
        showNotice: function (msg) { return call('showNotice', [msg]) },
        getCurrentFile: function () { return call('getCurrentFile', []) },
        getWorkspace: function () { return call('getWorkspace', []) },
        openFile: function (p) { return call('openFile', [p]) },
        readFile: function (p) { return call('readFile', [p]) },
        writeFile: function (p, c) { return call('writeFile', [p, c]) },
        readDir: function (p) { return call('readDir', [p]) },
        insertAtCursor: function (t) { return call('insertAtCursor', [t]) },
        log: function () { return call('log', [Array.prototype.slice.call(arguments).map(String).join(' ')]) },
    }
})();`

    const PluginManager = {
        api: {},                    // 主应用注入的 API 实现（app.js 设置）
        _iframes: [],               // [{ name, scope, path, iframe, win, commands: [{id,label}] }]
        _pending: new Map(),        // reqId → resolve（插件 API 请求）
        _reqSeq: 0,
        _onChange: null,            // 命令列表变化回调（app.js 设置：重渲染命令面板 + 插件列表）
        _loadToken: 0,              // load 并发令牌：旧请求 resolve 后校验令牌失效则丢弃，避免重复加载
        _lastRoot: null,            // 最近一次 load 的 rootPath（reload() 复用）

        async load(rootPath) {
            const token = ++this._loadToken
            this.unload()
            this._lastRoot = rootPath || null
            let res
            try {
                res = await window.electronAPI.loadPlugins(rootPath)
            } catch (err) {
                if (token !== this._loadToken) return   // 已被更新的 load 取代
                this._notify()
                return
            }
            if (token !== this._loadToken) return       // 期间又触发了新的 load：丢弃本次结果
            if (!res.ok) { this._notify(); return }
            for (const p of (res.plugins || [])) {
                this._spawn(p)
            }
            this._notify()
        },

        unload() {
            for (const f of this._iframes) {
                if (f.iframe && f.iframe.parentNode) f.iframe.parentNode.removeChild(f.iframe)
            }
            this._iframes = []
            this._pending.clear()
        },

        // 插件命令列表（app.js 合并进命令面板）
        commands() {
            const list = []
            for (const f of this._iframes) {
                for (const c of f.commands) {
                    list.push({ id: c.id, label: c.label, plugin: f })
                }
            }
            return list
        },

        // 执行插件命令（主应用 → 插件 iframe）
        runCommand(cmd) {
            if (cmd && cmd.plugin && cmd.plugin.win) {
                cmd.plugin.win.postMessage({ t: 'runCommand', id: cmd.id }, '*')
            }
        },

        // 重新加载（沿用最近一次 load 的 rootPath）
        reload() {
            this.load(this._lastRoot)
        },

        _spawn(p) {
            const iframe = document.createElement('iframe')
            iframe.style.display = 'none'
            // 关键：只给 allow-scripts，不给 allow-same-origin → 插件无法触碰主应用
            iframe.setAttribute('sandbox', 'allow-scripts')
            iframe.setAttribute('aria-hidden', 'true')
            document.body.appendChild(iframe)
            const doc = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
                + '<script>' + BRIDGE + '<\/script>'
                + '<script>' + String(p.content).replace(/<\/script>/gi, '<\\/script>') + '<\/script>'
                + '</body></html>'
            iframe.srcdoc = doc
            const entry = {
                name: p.name,
                scope: p.scope,
                path: p.path,
                iframe,
                win: iframe.contentWindow,
                commands: [],
            }
            this._iframes.push(entry)
        },

        _notify() {
            if (typeof this._onChange === 'function') this._onChange()
        },
    }

    // —— 主应用侧：接收插件消息（注册命令 / API 请求 / 错误）——
    window.addEventListener('message', (e) => {
        // 双重校验：来源必须是已知插件的 contentWindow，且 origin 为沙箱 iframe 的 opaque origin（'null'）。
        // 防止插件 iframe 被导航到外部页面后复用插件 API 权限。
        if (e.origin !== 'null') return
        const entry = PluginManager._iframes.find((f) => f.win === e.source)
        if (!entry) return   // 来源不是已知插件 → 忽略
        const d = e.data || {}
        if (d.t === 'registerCommand') {
            if (d.cmd && d.cmd.id) {
                // 同名命令覆盖（插件内重复注册）
                const prev = entry.commands.findIndex((c) => c.id === d.cmd.id)
                if (prev >= 0) entry.commands.splice(prev, 1)
                entry.commands.push({ id: d.cmd.id, label: d.cmd.label || d.cmd.id })
                PluginManager._notify()
            }
        } else if (d.t === 'api') {
            const method = d.method
            const impl = PluginManager.api[method]
            const respond = (data) => {
                try { e.source.postMessage({ t: 'resp', reqId: d.reqId, data }, '*') } catch { /* 忽略 */ }
            }
            if (typeof impl !== 'function') {
                respond({ ok: false, error: '插件 API 不存在：' + method })
                return
            }
            let out
            try {
                out = impl.apply(null, d.args || [])
            } catch (err) {
                respond({ ok: false, error: String(err && err.message || err) })
                return
            }
            Promise.resolve(out)
                .then((v) => respond({ ok: true, data: v === undefined ? null : v }))
                .catch((err) => respond({ ok: false, error: String(err && err.message || err) }))
        } else if (d.t === 'error') {
            console.warn('[plugin:' + entry.name + '] 命令执行出错：', d.error)
        }
    })

    window.PluginManager = PluginManager
})()
