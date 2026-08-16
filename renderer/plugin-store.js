/* ================================================================
 * 插件商店（#14 扩展）：内置插件集合 + 商店面板
 *
 * 纯本地商店：每个插件是一段 JS 源码字符串，"安装"= 写入用户数据目录
 * plugins/<id>.js 并重新加载（与手写插件完全一致），无网络依赖。
 * 插件通过 emerald 桥注册命令 / 调用受限 API（见 plugin-manager.js）。
 * ================================================================ */
;(function () {
    'use strict'

    // 注意：插件源码里不能出现反引号（``）和 </script>（会被 srcdoc 注入截断）
    const PLUGINS = [
        {
            id: 'emoji-helper',
            name: 'Emoji 表情助手',
            author: 'Emerald 内置',
            description: '一键插入常用 Emoji（笑脸 / 爱心 / 点赞 / 星星 / 对勾）。',
            code: `
emerald.registerCommand({
    id: 'emoji.smile',
    label: '插入 😊 笑脸',
    run() { emerald.insertAtCursor('😊') }
})
emerald.registerCommand({
    id: 'emoji.heart',
    label: '插入 ❤️ 爱心',
    run() { emerald.insertAtCursor('❤️') }
})
emerald.registerCommand({
    id: 'emoji.thumbsup',
    label: '插入 👍 点赞',
    run() { emerald.insertAtCursor('👍') }
})
emerald.registerCommand({
    id: 'emoji.star',
    label: '插入 ⭐ 星星',
    run() { emerald.insertAtCursor('⭐') }
})
emerald.registerCommand({
    id: 'emoji.check',
    label: '插入 ✅ 对勾',
    run() { emerald.insertAtCursor('✅') }
})`,
        },
        {
            id: 'insert-date',
            name: '日期时间插入器',
            author: 'Emerald 内置',
            description: '在光标处插入当前日期 / 日期+时间 / 中文日期，自动补零。',
            code: `
function pad(n) { return n < 10 ? '0' + n : String(n) }
emerald.registerCommand({
    id: 'date.today',
    label: '插入今天日期（2026-08-12）',
    run() {
        var d = new Date()
        emerald.insertAtCursor(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()))
    }
})
emerald.registerCommand({
    id: 'date.datetime',
    label: '插入日期 + 时间',
    run() {
        var d = new Date()
        emerald.insertAtCursor(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()))
    }
})
emerald.registerCommand({
    id: 'date.cn',
    label: '插入中文日期（2026年8月12日）',
    run() {
        var d = new Date()
        emerald.insertAtCursor(d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日')
    }
})`,
        },
        {
            id: 'word-count',
            name: '笔记统计器',
            author: 'Emerald 内置',
            description: '统计当前笔记的字符数 / 词数 / 行数，右上角轻提示。',
            code: `
emerald.registerCommand({
    id: 'stats.wordcount',
    label: '统计当前笔记 字数 / 词数 / 行数',
    run() {
        emerald.getCurrentFile().then(function (r) {
            if (!r.ok || !r.data) { emerald.showNotice('请先打开一个笔记'); return }
            var c = r.data.content
            var chars = c.length
            var lines = c.split('\\n').length
            var words = (c.match(/[\\u4e00-\\u9fa5]|[a-zA-Z0-9]+/g) || []).length
            emerald.showNotice(r.data.name + '：' + chars + ' 字符 · ' + words + ' 词 · ' + lines + ' 行')
        })
    }
})`,
        },
        {
            id: 'frontmatter-tags',
            name: 'Frontmatter 元数据',
            author: 'Emerald 内置',
            description: '给当前笔记自动添加 YAML frontmatter（tags + 创建日期），不覆盖已有内容。',
            code: `
emerald.registerCommand({
    id: 'meta.frontmatter',
    label: '给当前笔记添加 frontmatter（tags / 日期）',
    run() {
        emerald.getCurrentFile().then(function (r) {
            if (!r.ok || !r.data) { emerald.showNotice('请先打开一个笔记'); return }
            var c = r.data.content
            if (c.indexOf('---') === 0) { emerald.showNotice('该笔记已有 frontmatter'); return }
            var d = new Date()
            var date = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
            var front = '---\\ntags:\\n  - 笔记\\ndate: ' + date + '\\n---\\n\\n'
            emerald.writeFile(r.data.path, front + c).then(function (res) {
                emerald.showNotice(res.ok ? '已添加 frontmatter，请刷新查看' : '写入失败')
            })
        })
    }
})`,
        },
        {
            id: 'backup-note',
            name: '笔记备份',
            author: 'Emerald 内置',
            description: '把当前笔记复制一份到工作区 .emerald/backups/ 目录，防止误改丢失。',
            code: `
emerald.registerCommand({
    id: 'file.backup',
    label: '备份当前笔记到 .emerald/backups/',
    run() {
        emerald.getCurrentFile().then(function (r) {
            if (!r.ok || !r.data) { emerald.showNotice('请先打开一个笔记'); return }
            var src = r.data.path
            var parts = src.split(/[\\\\/]/)
            var name = parts[parts.length - 1]
            return emerald.getWorkspace().then(function (w) {
                if (!w.ok || !w.data || !w.data.path) { emerald.showNotice('没有工作区'); return }
                var dest = w.data.path + '/.emerald/backups/' + name
                return emerald.readFile(src).then(function (rd) {
                    return emerald.writeFile(dest, rd.data)
                })
            }).then(function (res) {
                emerald.showNotice(res && res.ok ? '已备份到 .emerald/backups/' : '备份失败，请重试')
            })
        })
    }
})`,
        },
    ]

    // —— 商店面板 ——

    function isInstalled(id) {
        return window.PluginManager._iframes.some((f) => f.scope === 'user' && f.name === id + '.js')
    }

    async function install(id) {
        const p = PLUGINS.find((x) => x.id === id)
        if (!p) return
        const res = await window.electronAPI.installPlugin(id + '.js', p.code)
        if (!res.ok) { alert('安装失败：' + (res.error || '')); return }
        if (window.reloadPlugins) window.reloadPlugins()
        renderStore()
    }

    async function uninstall(id) {
        const res = await window.electronAPI.uninstallPlugin(id + '.js')
        if (!res.ok) { alert('卸载失败：' + (res.error || '')); return }
        if (window.reloadPlugins) window.reloadPlugins()
        renderStore()
    }

    function renderStore() {
        const list = document.getElementById('pluginStoreList')
        if (!list) return
        list.innerHTML = ''
        for (const p of PLUGINS) {
            const installed = isInstalled(p.id)
            const card = document.createElement('div')
            card.className = 'store-card'
            const head = document.createElement('div')
            head.className = 'store-card-head'
            const title = document.createElement('span')
            title.className = 'store-card-title'
            title.textContent = p.name
            const author = document.createElement('span')
            author.className = 'store-card-author'
            author.textContent = p.author
            head.append(title, author)
            const desc = document.createElement('div')
            desc.className = 'store-card-desc'
            desc.textContent = p.description
            const foot = document.createElement('div')
            foot.className = 'store-card-foot'
            const badge = document.createElement('span')
            badge.className = 'store-card-badge'
            badge.textContent = installed ? '✓ 已安装' : '未安装'
            badge.classList.toggle('on', installed)
            const btn = document.createElement('button')
            btn.className = 'modal-btn ' + (installed ? '' : 'primary')
            btn.textContent = installed ? '卸载' : '安装'
            btn.addEventListener('click', () => (installed ? uninstall(p.id) : install(p.id)))
            foot.append(badge, btn)
            card.append(head, desc, foot)
            list.appendChild(card)
        }
    }

    window.PluginStore = {
        open() {
            const el = document.getElementById('pluginStore')
            if (!el) return
            el.classList.remove('hidden')
            renderStore()
        },
        close() {
            const el = document.getElementById('pluginStore')
            if (el) el.classList.add('hidden')
        },
        render: renderStore,
    }

    // 商店面板按钮绑定（元素在 index.html 中）
    document.addEventListener('DOMContentLoaded', () => {
        const closeBtn = document.getElementById('pluginStoreClose')
        if (closeBtn) closeBtn.addEventListener('click', () => window.PluginStore.close())
        const overlay = document.getElementById('pluginStore')
        if (overlay) overlay.addEventListener('click', (e) => {
            if (e.target === overlay) window.PluginStore.close()
        })
        // 插件列表变化时刷新安装状态
        const origNotify = window.PluginManager._onChange
        window.PluginManager._onChange = () => {
            if (origNotify) origNotify()
            if (document.getElementById('pluginStore') && !document.getElementById('pluginStore').classList.contains('hidden')) {
                renderStore()
            }
        }
    })
})()
