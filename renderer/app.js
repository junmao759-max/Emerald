/* ================================================================
 * Emerald — 渲染进程主逻辑
 *
 * 渲染进程没有 Node 能力，一切文件操作都通过 preload 暴露的
 *   window.electronAPI → IPC → 主进程 fs 完成。
 *
 * 依赖（index.html 中按顺序先加载）：
 *   renderer/md-parser.js     提供 window.MarkdownParser
 *   renderer/highlighter.js   提供 window.SyntaxHighlighter
 *
 * 覆盖功能：目录树(懒加载) / 多标签 / 编辑·保存 / Markdown 预览 /
 *           语法高亮 / 文件管理(右键菜单) / 搜索(Ctrl+P) / 主题 / 状态栏
 * ================================================================ */

// ---------- 全局状态 ----------
const state = {
    rootPath: null,          // 当前工作区根目录
    expanded: new Set(),     // 已展开的文件夹路径集合
    tabs: [],                // 打开的标签页 [{ id, path, name, content, originalContent }]
    activeTabId: null,       // 当前激活的标签 id（用文件路径当唯一 id）
    viewMode: 'edit',        // 当前视图：edit 编辑 / preview 预览
    searchResults: [],       // 快速切换器的结果列表
    searchIndex: 0,          // 快速切换器当前高亮的项
    cursorLine: 1,           // 光标行（状态栏）
    cursorCol: 1,            // 光标列（状态栏）
    theme: localStorage.getItem('emerald-theme') || 'light',
    contextMenu: null,       // 当前打开的右键菜单 DOM
    sortMode: 'name',        // 排序方式：name / name-desc / type
    history: [],             // 打开过的文件路径序列（后退/前进导航）
    historyIndex: -1,        // 当前在 history 中的位置
    sidebarCollapsed: false, // 目录栏是否收起
    tags: {},                // 标签索引：{ 绝对路径: { tags: string[], dir: bool } }，随工作区从 .emerald/index.json 加载
    activeTag: null,         // 侧栏正在过滤的标签（null = 未过滤）
}

// ================================================================
// 自定义模态框（替换系统 prompt/confirm/alert）
// 无边框窗口（frame:false）下系统对话框可能不显示，导致"点了没反应"。
// 自研模态框 100% 可控，所有现有调用自动走这里。
// 返回 Promise：确定→输入值/true，取消→null。
// ================================================================
const modal = {
    overlay: document.getElementById('modalOverlay'),
    title: document.getElementById('modalTitle'),
    body: document.getElementById('modalBody'),
    input: document.getElementById('modalInput'),
    ok: document.getElementById('modalOk'),
    cancel: document.getElementById('modalCancel'),
    resolve: null,
}

// 打开模态框；opts = { title, message, showInput?, defaultValue?, placeholder?, okText?, showCancel? }
function openModal(opts) {
    modal.title.textContent = opts.title || ''
    modal.body.textContent = opts.message || ''
    const hasInput = !!opts.showInput
    modal.input.classList.toggle('hidden', !hasInput)
    modal.input.value = opts.defaultValue || ''
    if (opts.placeholder) modal.input.placeholder = opts.placeholder
    modal.ok.textContent = opts.okText || '确定'
    modal.cancel.classList.toggle('hidden', opts.showCancel === false)
    modal.overlay.classList.remove('hidden')
    // 重触发进入动画（遮罩是持久元素，需 reflow 才会重放）
    modal.overlay.style.animation = 'none'
    void modal.overlay.offsetHeight
    modal.overlay.style.animation = ''
    if (hasInput) { modal.input.focus(); modal.input.select() }
    return new Promise((resolve) => { modal.resolve = resolve })
}

// 关闭并回传结果：确定→true/输入值，取消→null
function closeModal(value) {
    modal.overlay.classList.add('hidden')
    if (modal.resolve) {
        const r = modal.resolve
        modal.resolve = null
        r(value)
    }
}

// 模态框上的交互
modal.ok.addEventListener('click', () => {
    const hasInput = !modal.input.classList.contains('hidden')
    closeModal(hasInput ? modal.input.value : true)
})
modal.cancel.addEventListener('click', () => closeModal(null))
modal.overlay.addEventListener('click', (e) => { if (e.target === modal.overlay) closeModal(null) })
document.addEventListener('keydown', (e) => {
    if (modal.overlay.classList.contains('hidden')) return
    if (e.key === 'Enter') {
        e.preventDefault()
        const hasInput = !modal.input.classList.contains('hidden')
        closeModal(hasInput ? modal.input.value : true)
    } else if (e.key === 'Escape') {
        closeModal(null)
    }
})

// 覆盖系统对话框：所有 window.prompt/confirm/alert 与裸调用全部走自研模态框
window.prompt = (message, defaultValue) =>
    openModal({ title: message, showInput: true, defaultValue })
window.confirm = (message) =>
    openModal({ title: '确认', message, showCancel: true })
window.alert = (message) =>
    openModal({ title: '提示', message, showCancel: false, okText: '知道了' })

// currentFile 由 tabs + activeTabId 推导，不单独存一份（单一数据源）
Object.defineProperty(state, 'currentFile', {
    get() {
        return state.tabs.find((t) => t.id === state.activeTabId) || null
    },
    enumerable: true,
    configurable: true,
})

// ---------- DOM 引用（集中管理） ----------
const $ = (id) => document.getElementById(id)
const els = {
    launchScreen: $('launchScreen'),
    openFolderBtn: $('openFolderBtn'),
    launchErr: $('launchErr'),
    recentFolders: $('recentFolders'),
    sessionRestore: $('sessionRestore'),
    sessionInfo: $('sessionInfo'),
    sessionRestoreBtn: $('sessionRestoreBtn'),
    currentPath: $('currentPath'),
    switchWsBtn: $('switchWsBtn'),
    guideBar: $('guideBar'),
    guideClose: $('guideClose'),
    emptyOpenFolderBtn: $('emptyOpenFolderBtn'),
    emptyNewNoteBtn: $('emptyNewNoteBtn'),
    emptyNewFileBtn: $('emptyNewFileBtn'),
    blankHint: $('blankHint'),
    searchBtn: $('searchBtn'),
    titleRefreshBtn: $('titleRefreshBtn'),
    themeSunBtn: $('themeSunBtn'),
    themeMoonBtn: $('themeMoonBtn'),
    newFileBtn: $('newFileBtn'),
    newFolderBtn: $('newFolderBtn'),
    fileCatalogue: $('fileCatalogue'),
    favoritesSection: $('favoritesSection'),
    recentFilesSection: $('recentFilesSection'),
    tabBar: $('tabBar'),
    emptyState: $('emptyState'),
    imageView: $('imageView'),
    imagePreview: $('imagePreview'),
    imageName: $('imageName'),
    editorPane: $('editorPane'),
    editor: $('editor'),
    editorTitle: $('editorTitle'),
    fileTypeBadge: $('fileTypeBadge'),
    fileMeta: $('fileMeta'),
    saveStatus: $('saveStatus'),
    saveBtn: $('saveBtn'),
    viewModeBtn: $('viewModeBtn'),
    previewPane: $('previewPane'),
    previewContent: $('previewContent'),
    liveEditor: $('liveEditor'),
    statusLeft: $('statusLeft'),
    statusCenter: $('statusCenter'),
    statusRight: $('statusRight'),
    quickSwitcher: $('quickSwitcher'),
    qsInput: $('qsInput'),
    qsResults: $('qsResults'),
    commandPalette: $('commandPalette'),
    cpInput: $('cpInput'),
    cpResults: $('cpResults'),
    tooltip: $('tooltip'),
    hoverPreview: $('hoverPreview'),
    treeFilterInput: $('treeFilterInput'),
    treeFilterClear: $('treeFilterClear'),
    backBtn: $('backBtn'),
    forwardBtn: $('forwardBtn'),
    toggleSidebarBtn: $('toggleSidebarBtn'),
    expandSidebarBtn: $('expandSidebarBtn'),
    backlinksBtn: $('backlinksBtn'),
    backlinksPanel: $('backlinksPanel'),
    backlinksList: $('backlinksList'),
    backlinksClose: $('backlinksClose'),
    tagsSection: $('tagsSection'),
    tabAddBtn: $('tabAddBtn'),
    pdfView: $('pdfView'),
    pdfFrame: $('pdfFrame'),
    pdfName: $('pdfName'),
    pdfOpenBtn: $('pdfOpenBtn'),
}

// ================================================================
// 工具函数
// ================================================================

// 可编辑文本的扩展名白名单
const TEXT_EXTS = new Set([
    'txt','md','markdown','js','mjs','cjs','ts','jsx','tsx','json',
    'html','htm','css','scss','less','vue','py','java','c','cpp',
    'h','hpp','go','rs','sh','bat','ps1','xml','yml','yaml','ini',
    'cfg','conf','log','csv','tsv','sql','toml','svg',
])
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','ico'])
const CODE_EXTS = new Set([
    'js','mjs','cjs','ts','jsx','tsx','vue','py','java','c','cpp',
    'h','hpp','go','rs','sh','bat','ps1','html','htm','css','scss','less','sql',
])

// 取扩展名（小写）
function getExt(name) {
    const i = name.lastIndexOf('.')
    return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}
function isTextFile(name) {
    const ext = getExt(name)
    if (ext === '') return true          // 无扩展名当作文本，可读可改
    return TEXT_EXTS.has(ext)
}
function isImageFile(name) {
    return IMAGE_EXTS.has(getExt(name))
}
function isPdfFile(name) {
    return getExt(name) === 'pdf'
}
function isMarkdown(name) {
    const ext = getExt(name)
    return ext === 'md' || ext === 'markdown'
}

// Windows 绝对路径 → file:// 协议 URL（B5：逐段编码，避免 #、%、空格 等字符破坏 URL）
// 盘符冒号保留原样，其余路径段 encodeURIComponent（中文、空格、#、% 都被安全编码）
function pathToFileUrl(filePath) {
    const parts = filePath.split('\\').join('/').split('/')
    const head = parts[0]                                        // 盘符 C: 或 UNC 路径的空头
    const rest = parts.slice(1).map(encodeURIComponent).join('/')
    return 'file:///' + head + (rest ? '/' + rest : '')
}

// 路径工具（渲染进程没有 path 模块，手写最小实现；路径分隔符是反斜杠）
function parentDir(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    return i === -1 ? p : p.slice(0, i)
}
function basename(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    return i === -1 ? p : p.slice(i + 1)
}
function joinPath(...parts) {
    return parts.join('\\')
}

// 转义 HTML：任何要拼进 innerHTML 的文本都必须先过这里（防 XSS）
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

// 字节数 → 人类可读大小
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// 毫秒时间戳 → "YYYY-MM-DD HH:mm"
function formatTime(ms) {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// 当前激活标签是否有未保存修改
function isDirty() {
    const f = state.currentFile
    return !!(f && f.content !== f.originalContent)
}
// 任意标签有未保存修改（关窗口 / 退出时用）
function anyDirty() {
    return state.tabs.some((t) => t.content !== t.originalContent)
}

// 扩展名 → 高亮语言别名
const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'css', less: 'css',
    json: 'json',
    py: 'python',
    sh: 'shell', bash: 'shell',
    md: 'markdown',
}
function langFromExt(ext) {
    return EXT_LANG[ext] || ''
}

// 按扩展名返回文件图标 SVG（颜色区分类型，Obsidian 风格）
function fileIconFor(name) {
    const ext = getExt(name)
    let cls = 'icon-file-default'
    if (IMAGE_EXTS.has(ext)) cls = 'icon-file-image'
    else if (isMarkdown(name)) cls = 'icon-file-md'
    else if (CODE_EXTS.has(ext)) cls = 'icon-file-code'
    else if (['json','yml','yaml','ini','cfg','conf','toml'].includes(ext)) cls = 'icon-file-config'
    else if (['zip','rar','7z','gz','tar','bz2'].includes(ext)) cls = 'icon-file-archive'
    else if (['mp3','wav','flac','m4a','ogg'].includes(ext)) cls = 'icon-file-audio'
    else if (['mp4','mkv','avi','mov','webm'].includes(ext)) cls = 'icon-file-video'
    return '<svg class="' + cls + '" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">'
        + '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>'
}

// ================================================================
// 目录树
// ================================================================

// 对条目数组排序，返回新数组（不修改原数组——不可变原则）。
// 文件夹永远排在文件前面（文件管理器铁律），同类再按当前模式比。
function sortItems(items) {
    const arr = items.slice()
    const cmp = (a, b) => {
        if (state.sortMode === 'name-desc') return b.name.localeCompare(a.name, 'zh')
        if (state.sortMode === 'type') {
            return getExt(a.name).localeCompare(getExt(b.name)) || a.name.localeCompare(b.name, 'zh')
        }
        return a.name.localeCompare(b.name, 'zh')   // 默认 name
    }
    const dirs = arr.filter((i) => i.isDir).sort(cmp)
    const files = arr.filter((i) => !i.isDir).sort(cmp)
    return dirs.concat(files)
}

// 在 container 里渲染一组条目，depth 决定缩进层级
function renderItems(items, container, depth) {
    items = sortItems(items)          // 渲染前统一按当前排序模式排
    if (items.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'tree-empty'
        empty.textContent = '（空文件夹）'
        container.appendChild(empty)
        return
    }
    for (const item of items) {
        const node = document.createElement('div')
        node.className = 'tree-node'
        node.dataset.path = item.path       // 记录路径，方便展开/收起/定位
        node.dataset.type = item.isDir ? 'dir' : 'file'
        node.dataset.depth = String(depth)

        const row = document.createElement('div')
        row.className = 'tree-row'
        row.dataset.path = item.path
        row.style.paddingLeft = depth * 16 + 8 + 'px'  // 越深缩进越多

        if (item.isDir) {
            // —— 文件夹行：展开箭头 + 文件夹图标 + 名字 ——
            const caret = document.createElement('span')
            caret.className = 'tree-caret'
            caret.textContent = '❯'
            const icon = document.createElement('span')
            icon.className = 'tree-icon folder-icon'
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
            const name = document.createElement('span')
            name.className = 'tree-name'
            name.textContent = item.name     // textContent：文件名当纯文本，防 XSS
            row.append(caret, icon, name)

            // 子节点容器，懒加载：展开时才往里面填
            const children = document.createElement('div')
            children.className = 'tree-children'
            row.addEventListener('click', () => toggleFolder(node, item, children, caret))
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault(); e.stopPropagation()
                showItemContextMenu(e.clientX, e.clientY, item)
            })
            node.append(row, children)
        } else {
            // —— 文件行：类型图标 + 名字 ——
            const icon = document.createElement('span')
            icon.className = 'tree-icon'
            icon.innerHTML = fileIconFor(item.name)
            const name = document.createElement('span')
            name.className = 'tree-name'
            name.textContent = item.name
            row.append(icon, name)
            row.addEventListener('click', () => selectFile(item, row))
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault(); e.stopPropagation()
                showItemContextMenu(e.clientX, e.clientY, item)
            })
            node.append(row)
        }
        // 标签徽章：挂到树行尾部（多个标签用 / 连接，太长省略）
        const tags = getTagsFor(item.path)
        if (tags.length) {
            const badge = document.createElement('span')
            badge.className = 'tag-badge'
            badge.textContent = tags.join(' / ')
            badge.title = '标签：' + tags.join('、')
            row.appendChild(badge)
        }
        container.appendChild(node)
    }
}

// 展开 / 收起文件夹（懒加载：只有展开时才真正去读磁盘）
async function toggleFolder(node, item, children, caret) {
    const p = item.path
    if (state.expanded.has(p)) {
        // 收起：清空子节点，移出展开集合
        state.expanded.delete(p)
        children.innerHTML = ''
        caret.classList.remove('open')
        return
    }
    // 展开：向主进程请求这个目录的内容
    const res = await window.electronAPI.readDir(p)
    children.innerHTML = ''
    if (!res.ok) {
        const err = document.createElement('div')
        err.className = 'tree-error'
        err.textContent = '读取失败：' + res.error
        children.appendChild(err)
        return
    }
    renderItems(res.items, children, Number(node.dataset.depth) + 1)
    state.expanded.add(p)
    caret.classList.add('open')
    // 强制重触发展开动画（tree-children 是持久元素，需 reflow 才会重新播放 animation）
    children.style.animation = 'none'
    void children.offsetHeight
    children.style.animation = ''
}

// 从 node 反推 item（供 reRender / expandAll 复用）
function dirInfoFromNode(node) {
    const nameEl = node.querySelector('.tree-name')
    return { path: node.dataset.path, name: nameEl ? nameEl.textContent : '' }
}

// 重建某一层的子节点，并恢复之前已展开的子目录（新建/重命名/删除后刷新用）
async function reRenderChildren(node, depth) {
    const children = node.querySelector(':scope > .tree-children')
    if (!children) return
    children.innerHTML = ''
    const res = await window.electronAPI.readDir(node.dataset.path)
    if (!res.ok) {
        const err = document.createElement('div')
        err.className = 'tree-error'
        err.textContent = '读取失败：' + res.error
        children.appendChild(err)
        return
    }
    renderItems(res.items, children, depth)
    children.style.animation = 'none'
    void children.offsetHeight
    children.style.animation = ''
    // 恢复之前展开过的子目录
    for (const child of children.querySelectorAll(':scope > .tree-node[data-type="dir"]')) {
        if (state.expanded.has(child.dataset.path)) {
            await toggleFolder(
                child,
                dirInfoFromNode(child),
                child.querySelector(':scope > .tree-children'),
                child.querySelector(':scope > .tree-row .tree-caret')
            )
        }
    }
}

// 刷新指定目录的树视图（如果它在展开状态）
async function refreshDir(dir) {
    if (!state.rootPath) return
    if (dir === state.rootPath) {
        await loadRoot()
        return
    }
    const node = document.querySelector('.tree-node[data-path="' + CSS.escape(dir) + '"]')
    if (!node) return
    const depth = Number(node.dataset.depth)
    if (state.expanded.has(dir)) {
        await reRenderChildren(node, depth + 1)
    }
}

// 全部展开（递归读盘，最多 300 个目录防止卡死）
async function expandAll() {
    const stack = [...els.fileCatalogue.querySelectorAll(':scope > .tree-node[data-type="dir"]')]
    const seen = new Set()
    let count = 0
    while (stack.length && count < 300) {
        const node = stack.pop()
        if (seen.has(node)) continue
        seen.add(node)
        count++
        if (!state.expanded.has(node.dataset.path)) {
            await toggleFolder(
                node,
                dirInfoFromNode(node),
                node.querySelector(':scope > .tree-children'),
                node.querySelector(':scope > .tree-row .tree-caret')
            )
        }
        const kids = node.querySelectorAll(':scope > .tree-children > .tree-node[data-type="dir"]')
        for (const k of kids) stack.push(k)
    }
}

// 全部收起：清空所有子节点，只保留第一层
function collapseAll() {
    state.expanded.clear()
    els.fileCatalogue.querySelectorAll('.tree-node').forEach((node) => {
        if (node.dataset.type !== 'dir') return
        const children = node.querySelector(':scope > .tree-children')
        const caret = node.querySelector(':scope > .tree-row .tree-caret')
        if (children) children.innerHTML = ''
        if (caret) caret.classList.remove('open')
    })
}

// 从根目录逐级展开到指定目录（搜索定位用）
async function revealAndExpand(dirPath) {
    let cur = dirPath
    const segs = []
    while (cur !== state.rootPath && cur.length > state.rootPath.length) {
        segs.unshift(cur)
        cur = parentDir(cur)
    }
    let container = els.fileCatalogue
    for (const seg of segs) {
        const node = container.querySelector(':scope > .tree-node[data-path="' + CSS.escape(seg) + '"]')
        if (!node) break
        if (node.dataset.type === 'dir' && !state.expanded.has(seg)) {
            await toggleFolder(
                node,
                dirInfoFromNode(node),
                node.querySelector(':scope > .tree-children'),
                node.querySelector(':scope > .tree-row .tree-caret')
            )
        }
        container = node.querySelector(':scope > .tree-children')
    }
}

// ================================================================
// 目录树内联过滤（替代原顶部图标栏）：输入关键词即时过滤树
// 首次输入时先全部展开（上限 300 目录），保证折叠层里的匹配项也能被找到
// ================================================================

let treeFilterExpanded = false   // 本次过滤会话是否已展开过

els.treeFilterInput.addEventListener('input', applyTreeFilter)
els.treeFilterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); clearTreeFilter() }
})
els.treeFilterClear.addEventListener('click', clearTreeFilter)

function clearTreeFilter() {
    if (!els.treeFilterInput.value) return
    els.treeFilterInput.value = ''
    treeFilterExpanded = false
    applyTreeFilter()
}

async function applyTreeFilter() {
    const q = els.treeFilterInput.value.trim().toLowerCase()
    els.treeFilterClear.classList.toggle('hidden', !q)
    // 先恢复所有行 / 节点显示，再按新关键词重算
    document.querySelectorAll('.tree-row, .tree-node').forEach((el) => (el.style.display = ''))
    if (!q) return
    // 首次过滤先展开全部，折叠目录里的匹配项也能显示
    if (!treeFilterExpanded) {
        treeFilterExpanded = true
        await expandAll()
    }
    // 名字包含关键词的行 → 保留；祖先目录行一并保留（否则父文件夹会被藏起来）
    const rows = [...document.querySelectorAll('.tree-row')]
    const matched = new Set()
    rows.forEach((row) => {
        const nameEl = row.querySelector('.tree-name')
        if (nameEl && nameEl.textContent.toLowerCase().includes(q)) matched.add(row)
    })
    matched.forEach((row) => {
        // 向上走到根：遇到 .tree-node 就保留它的行（.tree-children 只是中间容器，跳过）
        let node = row.parentElement
        while (node && node !== els.fileCatalogue) {
            if (node.classList.contains('tree-node')) {
                const parentRow = node.querySelector(':scope > .tree-row')
                if (parentRow) matched.add(parentRow)
            }
            node = node.parentElement
        }
    })
    rows.forEach((row) => { row.style.display = matched.has(row) ? '' : 'none' })
    document.querySelectorAll('.tree-node').forEach((node) => {
        const row = node.querySelector(':scope > .tree-row')
        node.style.display = row && matched.has(row) ? '' : 'none'
    })
}

// 切换工作区 / 刷新时重置过滤框
function resetTreeFilter() {
    els.treeFilterInput.value = ''
    treeFilterExpanded = false
    els.treeFilterClear.classList.add('hidden')
    document.querySelectorAll('.tree-row, .tree-node').forEach((el) => (el.style.display = ''))
}

// ================================================================
// 多标签页
// ================================================================

// 渲染标签栏：一个标签 = 一个"打开文件的槽位"。
// 点文件是在激活标签里替换（数量不增加）；"＋"按钮新增空白标签
function renderTabs() {
    els.tabBar.innerHTML = ''
    if (state.tabs.length === 0) {
        const ph = document.createElement('span')
        ph.className = 'tab-placeholder'
        ph.textContent = '点击文件在此打开 · 右侧 ＋ 新建标签'
        els.tabBar.appendChild(ph)
        return
    }
    for (const tab of state.tabs) {
        const el = document.createElement('div')
        el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '')
        el.dataset.id = tab.id
        el.title = tab.path || '空白标签：点击左侧文件在此打开'
        const dirty = tab.path != null && tab.content !== tab.originalContent

        const name = document.createElement('span')
        name.className = 'tab-name' + (tab.path ? '' : ' tab-name-blank')
        name.textContent = tab.path ? ((dirty ? '● ' : '') + tab.name) : '空白'
        name.classList.toggle('dirty', dirty)

        const close = document.createElement('span')
        close.className = 'tab-close'
        close.textContent = '✕'
        close.title = '关闭标签（中键亦可）'
        close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab) })

        // F3：标签页文件类型小图标（空白标签不带图标）
        if (tab.path) {
            const icon = document.createElement('span')
            icon.className = 'tab-file-icon'
            icon.innerHTML = fileIconFor(tab.name)
            el.prepend(icon)
        }
        el.append(name, close)
        el.addEventListener('click', () => activateTab(tab.id))
        el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab) } })
        els.tabBar.appendChild(el)
    }
}

// 切换到指定标签
function activateTab(id) {
    if (!state.tabs.some((t) => t.id === id)) return
    state.activeTabId = id
    renderTabs()
    renderActiveFile()
    const t = state.tabs.find((x) => x.id === id)
    if (t && t.path) recordHistory(t.path)   // 空白标签不进历史
}

// 渲染当前激活标签对应的内容区（空白标签 → 快捷键速查卡）
function renderActiveFile() {
    const f = state.currentFile
    if (!f || !f.path) {
        if (f && !f.path) showBlankTabHint()   // 空白标签：显示速查卡
        else showEmpty('从左侧目录树选择一个文件', '文本文件可编辑，保存后写回磁盘')
        return
    }
    renderEditor()
    loadFileMeta(f.path)
    syncTreeSelection(f.path)
}

// 关闭标签；若是激活标签，自动激活相邻的
async function closeTab(tab) {
    if (tab.content !== tab.originalContent) {
        const ok = await window.confirm('标签「' + tab.name + '」有未保存的修改，关闭后会丢失，确定吗？')
        if (!ok) return
    }
    const idx = state.tabs.indexOf(tab)
    if (idx === -1) return
    state.tabs.splice(idx, 1)
    if (state.activeTabId === tab.id) {
        const next = state.tabs[idx] || state.tabs[idx - 1] || null
        state.activeTabId = next ? next.id : null
    }
    renderTabs()
    if (state.tabs.length === 0) {
        showEmpty('从左侧目录树选择一个文件', '文本文件可编辑，保存后写回磁盘')
    } else {
        renderActiveFile()
    }
}

// ================================================================
// 打开 / 编辑 / 保存文件
// ================================================================

// 点击文件：图片走预览，PDF 走内置查看器，文本走标签页编辑器
async function selectFile(item, rowEl) {
    highlightTreeRow(rowEl)
    if (isImageFile(item.name)) {
        showImage(item)
        return
    }
    if (isPdfFile(item.name)) {
        showPdf(item)
        return
    }
    if (!isTextFile(item.name)) {
        showUntextable(item)
        return
    }
    await openFileByPath(item.path, rowEl)
}

// 按路径打开文本文件（新版标签语义）：
//   文件已在某标签 → 切过去（避免同一文件占多个标签）
//   否则 → 在当前激活标签里打开，替换旧内容（标签数量不增加）
//   "＋"新建的空白标签正好被填充；没有任何标签时直接新建
async function openFileByPath(path, rowEl) {
    const existing = state.tabs.find((t) => t.path === path)
    if (existing) {
        activateTab(existing.id)
        return
    }
    // 替换激活标签前，若它有不保存的修改先确认，防止丢数据
    const cur = state.currentFile
    if (cur && cur.path && cur.content !== cur.originalContent) {
        const ok = await window.confirm('当前标签「' + cur.name + '」有未保存修改，打开其他文件将替换它并丢失修改，确定吗？')
        if (!ok) return
    }
    const res = await window.electronAPI.readFile(path)
    if (!res.ok) {
        showEmpty('读取失败：' + res.error, '')
        return
    }
    if (state.tabs.length === 0) {
        // 一个标签都没有：直接建一个装这个文件
        state.tabs.push({ id: path, path, name: basename(path), content: res.content, originalContent: res.content })
        state.activeTabId = path
    } else {
        // 替换激活标签的内容（空白标签 = 填充；有文件 = 替换）
        const target = state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0]
        Object.assign(target, {
            id: path,
            path,
            name: basename(path),
            content: res.content,
            originalContent: res.content,
        })
        state.activeTabId = target.id
    }
    renderTabs()
    renderActiveFile()
    recordHistory(path)
    recordRecentFile(path)
}

// 会话恢复专用：总是新建标签（与"替换式"打开语义不同，避免恢复时互相覆盖）
async function openFileInNewTab(path) {
    const existing = state.tabs.find((t) => t.path === path)
    if (existing) { activateTab(existing.id); return }
    const res = await window.electronAPI.readFile(path)
    if (!res.ok) return
    state.tabs.push({ id: path, path, name: basename(path), content: res.content, originalContent: res.content })
    state.activeTabId = path
    renderTabs()
    renderActiveFile()
}

// 新建一个空白标签（导航栏最右侧"＋"按钮）
let blankSeq = 0
function addBlankTab() {
    state.tabs.push({ id: 'blank-' + (++blankSeq), path: null, name: '空白', content: '', originalContent: '' })
    state.activeTabId = state.tabs[state.tabs.length - 1].id
    renderTabs()
    renderActiveFile()
}

// 高亮某一行，去掉其它行的高亮
function highlightTreeRow(rowEl) {
    if (!rowEl) return
    document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'))
    rowEl.classList.add('selected')
}

// 让目录树同步高亮到指定路径对应的行（如果它在 DOM 里）
function syncTreeSelection(path) {
    const row = document.querySelector('.tree-row[data-path="' + CSS.escape(path) + '"]')
    if (row) highlightTreeRow(row)
}

// 显示文本编辑器（编辑态或预览态）
function renderEditor() {
    closeBacklinks() // 切换文件时收起反链浮层，避免指向旧文件
    const f = state.currentFile
    if (!f) return
    hideAllStates()
    els.editorPane.classList.remove('hidden')
    els.editorTitle.textContent = f.name
    els.editor.value = f.content
    updateFileTypeBadge()   // F2：文件类型徽章
    updateSaveStatus()
    updateViewModeBtn()
    if (state.viewMode === 'preview') showPreview()
    else showEditorInput()
}

// F2：按文件类型给编辑器头部徽章着色（.md 琥珀 / 代码蓝 / 图片紫 / 其他灰）
function updateFileTypeBadge() {
    const f = state.currentFile
    if (!els.fileTypeBadge) return
    if (!f || !f.path) { els.fileTypeBadge.textContent = ''; els.fileTypeBadge.className = 'fileTypeBadge'; return }
    const ext = getExt(f.name)
    let cls = 'fileTypeBadge'
    if (isMarkdown(f.name)) cls += ' type-md'
    else if (CODE_EXTS.has(ext)) cls += ' type-code'
    else if (IMAGE_EXTS.has(ext)) cls += ' type-img'
    els.fileTypeBadge.textContent = ext ? '.' + ext : 'TXT'
    els.fileTypeBadge.className = cls
}

// 编辑态入口：Markdown 走"所见即所得"渲染编辑，其他文本走纯文本框
function showEditorInput() {
    els.previewPane.classList.add('hidden')
    const f = state.currentFile
    if (f && isMarkdown(f.name)) {
        els.liveEditor.classList.remove('hidden')
        els.editor.classList.add('hidden')
        renderLiveEditor()
    } else {
        els.editor.classList.remove('hidden')
        els.liveEditor.classList.add('hidden')
        els.editor.focus()
        updateCursorPos()
    }
}

// 预览态：隐藏文本框与实时编辑，渲染静态阅读视图
function showPreview() {
    els.previewPane.classList.remove('hidden')
    els.editor.classList.add('hidden')
    els.liveEditor.classList.add('hidden')
    els.previewContent.innerHTML = buildPreviewHtml()
    highlightPreviewBlocks()
    els.previewPane.scrollTop = 0
}

/* ================================================================
 * Obsidian 风格"所见即所得"编辑器：
 * 编辑模式下整篇 Markdown 以渲染态展示；点击某个块 → 该块暴露原始
 * Markdown（textarea 就地编辑）；失焦 / Ctrl+Enter 提交并重渲染，
 * Esc 取消。块行号区间由 md-parser 的 data-s / data-e 提供。
 * ================================================================ */

let liveEditingBlk = null   // 当前正在编辑的块（.blk 元素）

function renderLiveEditor() {
    const f = state.currentFile
    if (!f || !isMarkdown(f.name)) return
    els.liveEditor.innerHTML = previewHtmlFor(f.path, f.content)
    highlightPreviewBlocks()
    liveEditingBlk = null
}

// 点击委托：任务勾选 > wikilink > 普通链接 > 点击块进入编辑
els.liveEditor.addEventListener('click', (e) => {
    const cb = e.target.closest('input[type=checkbox][data-line]')
    if (cb) { toggleTaskLine(cb); return }
    const wl = e.target.closest('.wikilink')
    if (wl) { e.preventDefault(); openWikilink(wl.getAttribute('data-target')); return }
    const link = e.target.closest('a[href]')
    if (link) {
        e.preventDefault()
        const href = link.getAttribute('href')
        if (/^(https?:|mailto:)/i.test(href)) { window.electronAPI.openExternal(href); return }
        let target = null
        if (/^file:/i.test(href)) target = decodeURIComponent(href.replace(/^file:\/\/\//i, '')).split('/').join('\\')
        else if (!/^[a-zA-Z]+:/.test(href)) { const f = state.currentFile; if (f) target = joinPath(parentDir(f.path), href) }
        if (target) openLocalPath(target)
        return
    }
    const blk = e.target.closest('.blk[data-s]')
    if (blk) openBlockEditor(blk)
})

// 点击块 → 就地暴露原始 Markdown 编辑
function openBlockEditor(blk) {
    const f = state.currentFile
    if (!f || blk.classList.contains('editing')) return
    const s = parseInt(blk.dataset.s, 10)
    const e = parseInt(blk.dataset.e, 10)
    if (isNaN(s) || isNaN(e) || s < 0 || e < s) return
    const lines = f.content.split('\n')
    if (e >= lines.length) return

    blk.classList.add('editing')
    blk.innerHTML = ''
    const ta = document.createElement('textarea')
    ta.className = 'blk-editor'
    ta.value = lines.slice(s, e + 1).join('\n')
    ta.spellcheck = false
    ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Escape') {
            ev.preventDefault()
            blk.dataset.cancel = '1'   // 取消标记：重渲染移除焦点触发的 blur 不得提交
            renderLiveEditor()
            return
        }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commitBlockEdit(blk) }
    })
    ta.addEventListener('keyup', () => trackBlockCursor(blk, ta))
    ta.addEventListener('click', () => trackBlockCursor(blk, ta))
    ta.addEventListener('blur', () => commitBlockEdit(blk))
    blk.appendChild(ta)
    liveEditingBlk = blk
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    trackBlockCursor(blk, ta)
}

// 块内光标 → 状态栏行号（全局行 = 块起始行 + 块内偏移）
function trackBlockCursor(blk, ta) {
    const s = parseInt(blk.dataset.s, 10)
    const upto = ta.value.slice(0, ta.selectionStart)
    const nl = upto.lastIndexOf('\n')
    state.cursorLine = s + 1 + (nl === -1 ? 0 : upto.slice(0, nl).split('\n').length)
    state.cursorCol = ta.selectionStart - nl
    updateStatusBar()
}

// 提交块编辑：把块的行区间替换成新内容 → 重渲染并滚回原位
function commitBlockEdit(blk) {
    if (!blk.classList.contains('editing')) return
    // 取消路径（Esc）：直接放弃，不提交
    if (blk.dataset.cancel === '1') { delete blk.dataset.cancel; return }
    // 块已被重渲染移除（重复 blur）时不提交
    if (!document.body.contains(blk)) return
    const f = state.currentFile
    const ta = blk.querySelector('textarea.blk-editor')
    if (!f || !ta) return
    const s = parseInt(blk.dataset.s, 10)
    const e = parseInt(blk.dataset.e, 10)
    const lines = f.content.split('\n')
    if (e < s || e >= lines.length) { renderLiveEditor(); return }
    const replacement = ta.value === '' ? [''] : ta.value.split('\n')
    f.content = lines.slice(0, s).concat(replacement, lines.slice(e + 1)).join('\n')
    updateSaveStatus()
    renderTabs()
    // 重渲染并滚回该块位置，闪烁提示
    const scrollTop = els.liveEditor.scrollTop
    renderLiveEditor()
    els.liveEditor.scrollTop = scrollTop
    const newBlk = els.liveEditor.querySelector('.blk[data-s="' + s + '"]')
    if (newBlk) {
        newBlk.scrollIntoView({ block: 'nearest' })
        newBlk.classList.add('flash')
        setTimeout(() => newBlk.classList.remove('flash'), 900)
    }
}

// 纯函数：任意文件（路径 + 内容）→ 预览 HTML（编辑器预览 + 悬浮预览共用）
// 传路径而非名称：Markdown 内嵌图片的相对路径要按"当前文件所在目录"解析
function previewHtmlFor(filePath, content) {
    const name = basename(filePath)
    if (isMarkdown(name)) {
        const { html } = window.MarkdownParser.parse(content)
        return '<div class="md-body">' + resolvePreviewImages(html, parentDir(filePath)) + '</div>'
    }
    const lang = langFromExt(getExt(name))
    const highlighted = window.SyntaxHighlighter && window.SyntaxHighlighter.supports(lang)
        ? window.SyntaxHighlighter.highlight(content, lang)
        : escapeHtml(content)
    return '<pre class="code-preview"><code>' + highlighted + '</code></pre>'
}

// Markdown 内嵌图片：#8b —— 把相对路径（子目录 / ../ / 盘符绝对路径）解析成 file:// URL。
// 网络图片（http/https）、data:、file: 协议原样保留；解析失败时浏览器显示裂图占位，不阻断其余预览。
function resolvePreviewImages(html, baseDir) {
    const holder = document.createElement('div')
    holder.innerHTML = html
    let changed = false
    holder.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src')
        if (!src) return
        if (/^(https?:|data:|file:)/i.test(src)) return   // 外部 / 内联 / 绝对 file:// 不动
        changed = true
        if (/^[a-zA-Z]:[\\/]/.test(src)) {
            img.src = pathToFileUrl(src)                    // 盘符绝对路径：直接转 file://
        } else {
            img.src = pathToFileUrl(joinPath(baseDir, src)) // 相对路径：相对当前文件所在目录
        }
    })
    return changed ? holder.innerHTML : html
}

// 根据当前文件构造预览 HTML（编辑器预览用）
function buildPreviewHtml() {
    const f = state.currentFile
    if (!f) return ''
    let html = previewHtmlFor(f.path, f.content)
    // Markdown 且标题 ≥ 2 个时自动生成 TOC 目录（纯渲染层，不动源文件）
    if (isMarkdown(f.name) && window.MarkdownParser) {
        const holder = document.createElement('div')
        holder.innerHTML = html
        const heads = holder.querySelectorAll('h1, h2, h3')
        if (heads.length >= 2) {
            let toc = '<div class="toc"><div class="toc-title">📑 目录</div><ul>'
            heads.forEach((h, i) => {
                h.id = 'toc-' + i // 给标题补锚点 id，供目录跳转
                const level = Number(h.tagName[1])
                toc += '<li class="toc-l' + level + '"><a href="#toc-' + i + '">'
                    + escapeHtml(h.textContent.trim()) + '</a></li>'
            })
            toc += '</ul></div>'
            html = toc + holder.innerHTML
        }
    }
    return html
}

// Markdown 里的代码块本来只是转义文本，这里再套一层语法高亮。
// 做法：parser 输出 <code data-lang="xx">转义文本</code>，
// textContent 拿到原文 → SyntaxHighlighter 转义并分词 → 写回 innerHTML。
// 同时处理阅读视图（previewContent）与所见即所得编辑（liveEditor）
function highlightPreviewBlocks() {
    if (!window.SyntaxHighlighter) return
    const roots = [els.previewContent, els.liveEditor]
    for (const root of roots) {
        if (!root) continue
        root.querySelectorAll('pre code[data-lang]').forEach((code) => {
            const lang = code.getAttribute('data-lang')
            const text = code.textContent
            code.innerHTML = window.SyntaxHighlighter.highlight(text, lang)
            code.classList.add('highlighted')
        })
    }
}

/* ================================================================
 * Markdown 增强：任务勾选回写 / 双向链接跳转 / 目录锚点滚动 / 反链
 * 全部用事件委托挂在 previewContent 上，只在预览态生效
 * ================================================================ */
els.previewContent.addEventListener('change', (e) => {
    const cb = e.target
    if (!cb.matches('input[type=checkbox][data-line]')) return
    toggleTaskLine(cb)
})
els.previewContent.addEventListener('click', (e) => {
    const wl = e.target.closest('.wikilink')
    if (wl) {
        e.preventDefault()
        openWikilink(wl.getAttribute('data-target'))
        return
    }
    const ta = e.target.closest('.toc a')
    if (ta) {
        e.preventDefault()
        const id = ta.getAttribute('href').slice(1)
        const el = els.previewContent.querySelector('#' + CSS.escape(id))
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
    }
    // 普通链接（B1）：外链用系统浏览器打开；本地路径在应用内打开。
    // 一律 preventDefault——绝不让应用窗口被导航走
    const link = e.target.closest('a[href]')
    if (link) {
        e.preventDefault()
        const href = link.getAttribute('href')
        if (/^(https?:|mailto:)/i.test(href)) {
            window.electronAPI.openExternal(href)
            return
        }
        let target = null
        if (/^file:/i.test(href)) {
            target = decodeURIComponent(href.replace(/^file:\/\/\//i, '')).split('/').join('\\')
        } else if (!/^[a-zA-Z]+:/.test(href)) {
            const f = state.currentFile
            if (f) target = joinPath(parentDir(f.path), href)   // 相对路径按当前文件目录解析
        }
        if (target) openLocalPath(target)
    }
})

// 在应用内打开本地路径（B1 辅助）：图片 / PDF 走预览，文本走标签页
async function openLocalPath(target) {
    const name = basename(target)
    if (isImageFile(name)) { showImage({ path: target, name }); return }
    if (isPdfFile(name)) { showPdf({ path: target, name }); return }
    if (isTextFile(name)) await openFileByPath(target)
}

// 任务列表勾选 → 定位源文件对应行，切换 [ ] ↔ [x] 并写回磁盘
async function toggleTaskLine(cb) {
    const f = state.currentFile
    if (!f) return
    const lineNo = parseInt(cb.getAttribute('data-line'), 10)
    const lines = f.content.split('\n')
    if (lineNo < 1 || lineNo > lines.length) return
    // 该行可能是 "- [ ]" / "1. [x]" 等任意前缀，只替换 [ ]/[x] 本身
    lines[lineNo - 1] = lines[lineNo - 1].replace(/\[([ xX])\]/i, cb.checked ? '[x]' : '[ ]')
    const content = lines.join('\n')
    f.content = content
    els.editor.value = content // 同步文本框，切回编辑态时内容一致
    if (!els.liveEditor.classList.contains('hidden')) renderLiveEditor()   // 所见即所得视图同步重渲染
    const res = await window.electronAPI.writeFile(f.path, content)
    if (!res.ok) {
        alert('保存失败：' + res.error)
        return
    }
    f.originalContent = content // 已落盘，刷新"未保存"基线
    updateSaveStatus()
    renderTabs()
}

// 点击 [[目标]]：在工作区里搜同名 .md（优先），找到就打开，否则提示
async function openWikilink(target) {
    const clean = String(target || '').trim()
    if (!clean) return
    const base = clean.replace(/\.md$/i, '')
    const res = await window.electronAPI.search(state.rootPath, base)
    if (res.ok) {
        const mdHit = res.results.find((r) => !r.isDir && /\.md$/i.test(r.name))
        const anyHit = res.results.find((r) => !r.isDir)
        const hit = mdHit || anyHit
        if (hit) {
            await openFileByPath(hit.path)
            return
        }
    }
    alert('找不到笔记：' + clean)
}

els.backlinksBtn.addEventListener('click', showBacklinks)
els.backlinksClose.addEventListener('click', closeBacklinks)

// 反链：全文搜索 "[[当前文件名"，列出引用方（排除本文档自己）
async function showBacklinks() {
    const f = state.currentFile
    if (!f || !isMarkdown(f.name)) return
    const base = f.name.replace(/\.md$/i, '')
    const res = await window.electronAPI.searchContent(state.rootPath, '[[' + base)
    const files = (res.ok ? res.results : []).filter((r) => r.path !== f.path)
    renderBacklinksList(files)
    els.backlinksPanel.classList.remove('hidden')
}

// 渲染反链结果：每个引用文件 + 命中行文本，点击打开
function renderBacklinksList(files) {
    els.backlinksList.innerHTML = ''
    if (!files.length) {
        els.backlinksList.innerHTML = '<div class="backlink-empty">还没有其他笔记引用本文档</div>'
        return
    }
    files.forEach((r) => {
        const item = document.createElement('div')
        item.className = 'backlink-item'
        item.title = r.path
        const first = r.matches && r.matches[0] ? r.matches[0].text : ''
        item.innerHTML =
            '<div class="backlink-name">' + escapeHtml(r.name) + '</div>'
            + (first ? '<div class="backlink-line">' + escapeHtml(first) + '</div>' : '')
        item.addEventListener('click', () => {
            closeBacklinks()
            openFileByPath(r.path)
        })
        els.backlinksList.appendChild(item)
    })
}

function closeBacklinks() {
    els.backlinksPanel.classList.add('hidden')
}

// 编辑 / 预览切换按钮
els.viewModeBtn.addEventListener('click', toggleViewMode)

function updateViewModeBtn() {
    const f = state.currentFile
    const hasFile = !!(f && f.path)
    els.viewModeBtn.style.display = hasFile ? '' : 'none'
    els.viewModeBtn.textContent = state.viewMode === 'preview' ? '✏️ 编辑' : '👁 预览'
    // 反链按钮：仅 Markdown 文件显示
    els.backlinksBtn.style.display = hasFile && isMarkdown(f.name) ? '' : 'none'
}

// 图片预览
function showImage(item) {
    hideAllStates()
    els.imageView.classList.remove('hidden')
    els.imagePreview.src = pathToFileUrl(item.path)
    els.imagePreview.alt = item.name
    els.imageName.textContent = item.name
    loadFileMeta(item.path)
}

// 二进制文件：占位提示
function showUntextable(item) {
    hideAllStates()
    els.imageView.classList.remove('hidden')
    els.imagePreview.src = ''
    els.imageName.textContent = item.name + '（二进制文件，无法在此查看）'
    loadFileMeta(item.path)
}

// PDF 预览：#9 —— 用 iframe 加载 file:// URL，交给 Chromium 内置 PDF 查看器渲染。
// 顶栏提供"系统打开"兜底：内置查看器不可用或渲染失败时可转到系统默认程序。
let currentPdfPath = null   // 当前预览的 PDF 路径（系统打开按钮用）
function showPdf(item) {
    hideAllStates()
    els.pdfView.classList.remove('hidden')
    els.pdfName.textContent = item.name
    currentPdfPath = item.path
    els.pdfFrame.src = pathToFileUrl(item.path)   // 重新赋值 src 会重新加载
    loadFileMeta(item.path)
}

// 空状态（可自定义文案）
function showEmpty(title, sub) {
    hideAllStates()
    els.emptyState.classList.remove('hidden')
    els.emptyState.querySelector('p').textContent = title
    els.emptyState.querySelector('.hint-sub').textContent = sub
}

// 空白标签：快捷键速查卡（B3）
function showBlankTabHint() {
    hideAllStates()
    els.blankHint.classList.remove('hidden')
}

// 三种状态视图互斥，先全部隐藏
function hideAllStates() {
    els.emptyState.classList.add('hidden')
    els.imageView.classList.add('hidden')
    els.editorPane.classList.add('hidden')
    els.pdfView.classList.add('hidden')
    els.blankHint.classList.add('hidden')
    currentPdfPath = null
}

// 编辑事件：内容变化时刷新"未保存"状态与标签圆点
els.editor.addEventListener('input', () => {
    const f = state.currentFile
    if (!f) return
    f.content = els.editor.value
    updateSaveStatus()
    renderTabs()
})

// 刷新保存状态文字 / 按钮可用性
function updateSaveStatus() {
    const dirty = isDirty()
    els.saveStatus.textContent = dirty ? '● 未保存' : '已保存'
    els.saveStatus.classList.toggle('dirty', dirty)
    els.saveBtn.disabled = !dirty
}

// 保存当前文件（写回磁盘）
async function saveFile() {
    const f = state.currentFile
    if (!f || !f.path || !isDirty()) return   // 空白标签无可保存内容
    const res = await window.electronAPI.writeFile(f.path, f.content)
    if (!res.ok) {
        alert('保存失败：' + res.error)
        return
    }
    f.originalContent = f.content  // 已保存，重置基线
    updateSaveStatus()
    renderTabs()
}

// 读取并展示文件大小 / 修改时间（编辑器头部）
async function loadFileMeta(filePath) {
    const res = await window.electronAPI.getFileInfo(filePath)
    els.fileMeta.textContent = res.ok
        ? formatSize(res.size) + ' · ' + formatTime(res.mtimeMs)
        : ''
}

// ================================================================
// 工作区（启动界面 / 刷新）
// ================================================================

// ================================================================
// 最近打开的文件夹（记忆功能，存 localStorage）
// ================================================================

const RECENT_KEY = 'emerald-recent-folders'
const RECENT_MAX = 10

function getRecentFolders() {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    } catch {
        return []
    }
}

function saveRecentFolders(list) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

// 记录一个打开过的文件夹：去重后插到最前，最多保留 10 个
function recordRecentFolder(path) {
    const list = getRecentFolders().filter((p) => p !== path)
    list.unshift(path)
    saveRecentFolders(list.slice(0, RECENT_MAX))
}

// 渲染启动界面的"最近打开"列表（没有历史则隐藏）
function renderRecentFolders() {
    const list = getRecentFolders()
    els.recentFolders.innerHTML = ''
    if (list.length === 0) {
        els.recentFolders.classList.add('hidden')
        return
    }
    els.recentFolders.classList.remove('hidden')
    const title = document.createElement('div')
    title.className = 'recent-title'
    title.textContent = '最近打开'
    els.recentFolders.appendChild(title)
    for (const p of list) {
        const item = document.createElement('div')
        item.className = 'recent-item'
        item.title = p
        const icon = document.createElement('span')
        icon.className = 'recent-icon'
        icon.textContent = '📁'
        const name = document.createElement('span')
        name.className = 'recent-name'
        name.textContent = basename(p)
        const pathEl = document.createElement('span')
        pathEl.className = 'recent-path'
        pathEl.textContent = p
        const arrow = document.createElement('span')   // A4：hover 滑入的进入箭头
        arrow.className = 'recent-arrow'
        arrow.textContent = '→'
        item.append(icon, name, pathEl, arrow)
        item.addEventListener('click', () => openRecentFolder(p))
        els.recentFolders.appendChild(item)
    }
}

// 点击最近文件夹：直接加载，不弹系统选择框
async function openRecentFolder(p) {
    state.rootPath = p
    els.currentPath.textContent = p
    await loadRoot()
    els.launchScreen.classList.add('hidden')
    recordRecentFolder(p)      // 移到最前
    renderRecentFolders()
}

// ================================================================
// 会话恢复（关闭时保存快照，启动时可一键恢复）
// ================================================================

const SESSION_KEY = 'emerald-session'

// 编辑器滚动到指定行并把光标置于该行行首（会话恢复、搜索跳转复用）
// 所见即所得模式下：滚动到包含该行的渲染块并闪烁提示
function revealLine(lineNum) {
    const f = state.currentFile
    if (!f) return false
    const n = Math.max(1, lineNum || 1)
    // Markdown 且 liveEditor 可见 → 按块定位
    if (isMarkdown(f.name) && !els.liveEditor.classList.contains('hidden')) {
        const blk = els.liveEditor.querySelector('.blk[data-s]') && [...els.liveEditor.querySelectorAll('.blk[data-s]')]
            .find((b) => parseInt(b.dataset.s, 10) <= n - 1 && parseInt(b.dataset.e, 10) >= n - 1)
        if (blk) {
            blk.scrollIntoView({ block: 'center' })
            blk.classList.add('flash')
            setTimeout(() => blk.classList.remove('flash'), 900)
            return true
        }
        return false
    }
    const editor = els.editor
    if (!editor || !f) return false
    const value = editor.value
    if (!value) return false
    const lines = value.split('\n')
    const nl = Math.max(1, Math.min(n, lines.length))
    let offset = 0
    for (let i = 0; i < nl - 1; i++) offset += lines[i].length + 1
    offset = Math.min(offset, value.length)
    editor.setSelectionRange(offset, offset)
    editor.scrollTop = Math.max(0, (nl - 4) * 21) // textarea 行高约 21px
    return true
}

// 保存会话快照：只存"打开了哪些文件 + 状态"，不存文件内容（内容从磁盘重读）
function saveSession() {
    if (!state.rootPath) return
    const session = {
        rootPath: state.rootPath,
        tabs: state.tabs.map((t) => ({ path: t.path, name: t.name })).filter((t) => t.path), // 空白标签不存档
        activeTabId: state.activeTabId,
        cursorLine: state.cursorLine,
        cursorCol: state.cursorCol,
        viewMode: state.viewMode,
        sidebarCollapsed: state.sidebarCollapsed,
        sortMode: state.sortMode,
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

// 启动界面显示"恢复上次会话"区块（无会话则隐藏）
function renderSessionRestore() {
    let session
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { session = null }
    if (!session || !session.rootPath) {
        els.sessionRestore.classList.add('hidden')
        return
    }
    els.sessionRestore.classList.remove('hidden')
    els.sessionInfo.textContent = '上次：' + basename(session.rootPath) + ' · ' + (session.tabs ? session.tabs.length : 0) + ' 个标签'
}

// 恢复会话：还原工作区 + 标签 + 激活标签 + 状态
async function restoreSession() {
    let session
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { session = null }
    if (!session || !session.rootPath) return
    state.rootPath = session.rootPath
    state.sortMode = session.sortMode || 'name'
    state.viewMode = session.viewMode || 'edit'
    state.sidebarCollapsed = session.sidebarCollapsed || false
    els.currentPath.textContent = session.rootPath
    document.querySelector('.appRow').classList.toggle('sidebar-collapsed', state.sidebarCollapsed)
    els.expandSidebarBtn.classList.toggle('hidden', !state.sidebarCollapsed)
    els.toggleSidebarBtn.textContent = state.sidebarCollapsed ? '▶' : '◀'
    await loadRoot()
    // 恢复标签：isNavigating 标记避免污染后退/前进历史
    isNavigating = true
    try {
        for (const t of session.tabs || []) await openFileInNewTab(t.path)
        if (session.activeTabId) activateTab(session.activeTabId)
    } finally {
        isNavigating = false
    }
    state.cursorLine = session.cursorLine || 1
    state.cursorCol = session.cursorCol || 1
    updateStatusBar()
    revealLine(state.cursorLine) // 真正把光标还原到上次位置（而不只是状态栏显示）
    els.launchScreen.classList.add('hidden')
    recordRecentFolder(session.rootPath)
    renderRecentFolders()
    renderRecentFiles()
}

// 点击恢复按钮
els.sessionRestoreBtn.addEventListener('click', restoreSession)

// 启动界面：弹出文件夹选择框，选好后进入主界面
async function chooseFolder() {
    els.launchErr.textContent = ''
    const res = await window.electronAPI.selectFolder()
    if (!res.ok) {
        // 用户取消时静默返回；真正失败才提示
        if (!res.canceled) els.launchErr.textContent = '打开失败：' + (res.error || '未知错误')
        return
    }
    state.rootPath = res.path
    els.currentPath.textContent = res.path
    await loadRoot()
    els.launchScreen.classList.add('hidden')  // 隐藏启动界面，显示主界面
    recordRecentFolder(res.path)              // 记住这次打开的文件夹
    renderRecentFiles()
}

// 进入指定目录作为新工作区（清空标签/历史/展开状态，重建目录树）
// 供切换工作区按钮与收藏的文件夹共用
async function enterDirectory(path) {
    if (path === state.rootPath) return   // 已在当前目录则不动
    // B3：切换工作区会清空所有打开的标签，先确认，防止收藏夹误触丢标签
    if (state.tabs.length > 0) {
        const ok = await window.confirm('切换工作区会关闭当前所有打开的标签，确定吗？')
        if (!ok) return
    }
    state.rootPath = path
    els.currentPath.textContent = path
    // 旧工作区的标签、历史、展开状态对新目录无意义，全部重置
    state.tabs = []
    state.activeTabId = null
    state.expanded.clear()
    state.history = []
    state.historyIndex = -1
    state.searchResults = []
    updateNavBtns()
    renderTabs()
    await loadRoot()
    recordRecentFolder(path)
    renderRecentFolders()
    renderRecentFiles()
}

// 切换工作区：弹系统对话框选文件夹
async function switchWorkspace() {
    const res = await window.electronAPI.selectFolder()
    if (!res.ok) return                       // 用户取消则保持现状
    await enterDirectory(res.path)
}

// 加载根目录并重新渲染整个目录树（保留已打开的标签）
async function loadRoot() {
    resetTreeFilter()          // 新工作区 / 刷新时清空树过滤
    state.expanded.clear()
    els.fileCatalogue.innerHTML = ''
    if (state.tabs.length === 0) {
        showEmpty('从左侧目录树选择一个文件', '文本文件可编辑，保存后写回磁盘')
    }
    const res = await window.electronAPI.readDir(state.rootPath)
    if (!res.ok) {
        showEmpty('无法读取文件夹：' + res.error, '')
        return
    }
    renderItems(res.items, els.fileCatalogue, 0)
    els.statusCenter.textContent = '根目录 ' + res.items.length + ' 项'
    maybeShowGuide()   // B4：首次使用引导条
    await loadTags()   // 标签索引随工作区一起加载（.emerald/index.json）
}

// B4：首次使用引导条——只在首次进入工作区时显示一次，关闭后记住
function maybeShowGuide() {
    if (localStorage.getItem('emerald-guide-dismissed')) return
    els.guideBar.classList.remove('hidden')
}

// 刷新按钮：重新加载当前工作区（标签内容保留，不会丢未保存修改）
async function refresh() {
    if (!state.rootPath) return
    await loadRoot()
}

// ================================================================
// 文件 / 文件夹管理（右键菜单）
// ================================================================

// 通用右键菜单：items = [{ label, action, danger?, submenu? }]
// submenu 是子菜单数组（如"插入"下的格式化选项），悬停弹出（Obsidian 风格）
function showContextMenu(x, y, items) {
    hideContextMenu()
    const menu = document.createElement('div')
    menu.className = 'contextMenu'
    for (const it of items) {
        const btn = document.createElement('div')
        btn.className = 'ctx-item' + (it.danger ? ' danger' : '')
        if (it.submenu) {
            // 有子菜单：标题 + ▸ 箭头，子菜单绝对定位在右侧，悬停显示
            btn.classList.add('has-sub')
            const label = document.createElement('span')
            label.textContent = it.label
            const arrow = document.createElement('span')
            arrow.className = 'ctx-arrow'
            arrow.textContent = '▸'
            btn.append(label, arrow)
            const sub = document.createElement('div')
            sub.className = 'ctx-submenu'
            for (const sit of it.submenu) {
                const sbtn = document.createElement('div')
                sbtn.className = 'ctx-item'
                sbtn.textContent = sit.label
                sbtn.addEventListener('click', () => { hideContextMenu(); sit.action() })
                sub.appendChild(sbtn)
            }
            btn.appendChild(sub)
        } else {
            btn.textContent = it.label
            btn.addEventListener('click', () => { hideContextMenu(); it.action() })
        }
        menu.appendChild(btn)
    }
    document.body.appendChild(menu)
    // 定位：超出右/下边界时折回窗口内
    const rect = menu.getBoundingClientRect()
    const px = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const py = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    menu.style.left = px + 'px'
    menu.style.top = py + 'px'
    // 菜单靠右时子菜单翻转往左开，避免飞出窗口
    menu.classList.toggle('flip', px + rect.width + 180 > window.innerWidth)
    state.contextMenu = menu
}

function hideContextMenu() {
    if (state.contextMenu) {
        state.contextMenu.remove()
        state.contextMenu = null
    }
}

// 文件 / 文件夹行的右键菜单
function showItemContextMenu(x, y, item) {
    const dir = item.isDir ? item.path : parentDir(item.path)
    const items = [
        { label: '📄 新建文件', action: () => createNewFile(dir) },
        { label: '📁 新建文件夹', action: () => createNewFolder(dir) },
        { label: '✏️ 重命名', action: () => renameItem(item) },
        { label: '🏷 编辑标签', action: () => editTagsFor(item.path, item.name, item.isDir) },
        { label: '📋 复制' + (item.isDir ? '文件夹' : '文件'), action: () => copyItem(item) },
        { label: '🗑 删除', danger: true, action: () => deleteItem(item) },
        { label: '📂 在系统中显示', action: () => window.electronAPI.showInFolder(item.path) },
    ]
    // 文件与文件夹都可收藏
    items.push({ label: isFavorite(item.path) ? '☆ 取消收藏' : '★ 收藏', action: () => toggleFavorite(item.path, item.isDir) })
    showContextMenu(x, y, items)
}

/* ================================================================
 * 编辑器右键菜单（Obsidian 风格：插入格式化 + 链接）
 * 只在编辑模式触发——预览态 textarea 被 .hidden 隐藏，点不到它
 * ================================================================ */

// 右键时记住的选区（菜单弹出会让 textarea 失焦，用这个保住原始选区）
let ctxSelStart = 0
let ctxSelEnd = 0

// 表格模板（插入时用）
const TABLE_SNIPPET = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'

// 底层：用 setRangeText 替换 [start,end) 区间，并手动派发 input 事件。
// setRangeText 本身不触发 input，不派发的话"未保存"状态不会更新。
function applyEditorEdit(start, end, text) {
    const el = els.editor
    el.setRangeText(text, start, end, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    updateCursorPos()
    el.focus()
}

// 光标处插入纯文本（替换选区）
function insertAtCursor(text) {
    applyEditorEdit(ctxSelStart, ctxSelEnd, text)
}

// 用 before/after 包裹选中文本；没选中时用占位文字（加粗/斜体等）
function surroundSelection(before, after, placeholder) {
    const el = els.editor
    const sel = el.value.slice(ctxSelStart, ctxSelEnd) || placeholder
    applyEditorEdit(ctxSelStart, ctxSelEnd, before + sel + after)
}

// 在当前行行首插入前缀（标题、列表、引用等块级语法）
function linePrefix(prefix) {
    const el = els.editor
    const start = el.value.lastIndexOf('\n', ctxSelStart - 1) + 1
    applyEditorEdit(start, start, prefix)
}

// 插入 Markdown 链接 [文字](url)：有选中文字当链接文字，否则依次问 url 和文字
async function insertLink() {
    const el = els.editor
    const selText = el.value.slice(ctxSelStart, ctxSelEnd).trim()
    const url = await window.prompt('链接地址（URL）：', 'https://')
    if (!url) return
    let text = selText
    if (!text) text = await window.prompt('链接显示文字：', '链接') || url
    applyEditorEdit(ctxSelStart, ctxSelEnd, '[' + text + '](' + url + ')')
}

// 插入图片 ![alt](url)
async function insertImage() {
    const el = els.editor
    const alt = el.value.slice(ctxSelStart, ctxSelEnd).trim() || '图片'
    const url = await window.prompt('图片地址（URL）：', 'https://')
    if (!url) return
    applyEditorEdit(ctxSelStart, ctxSelEnd, '![' + alt + '](' + url + ')')
}

// 插入双向链接 [[目标]]（有选中文字当目标）
async function insertWikilink() {
    const el = els.editor
    const sel = el.value.slice(ctxSelStart, ctxSelEnd).trim()
    const target = sel || await window.prompt('笔记名称：')
    if (!target) return
    applyEditorEdit(ctxSelStart, ctxSelEnd, '[[' + target + ']]')
}

// 编辑器右键菜单：插入子菜单 + 链接 + 常用编辑操作
function showEditorContextMenu(x, y) {
    const insert = [
        { label: '标题 H3', action: () => linePrefix('### ') },
        { label: '加粗', action: () => surroundSelection('**', '**', '加粗文本') },
        { label: '斜体', action: () => surroundSelection('*', '*', '斜体文本') },
        { label: '删除线', action: () => surroundSelection('~~', '~~', '删除线') },
        { label: '行内代码', action: () => surroundSelection('`', '`', '代码') },
        { label: '代码块', action: () => surroundSelection('\n```\n', '\n```\n', '代码') },
        { label: '引用', action: () => linePrefix('> ') },
        { label: '无序列表', action: () => linePrefix('- ') },
        { label: '有序列表', action: () => linePrefix('1. ') },
        { label: '任务列表', action: () => linePrefix('- [ ] ') },
        { label: '分割线', action: () => insertAtCursor('\n---\n') },
        { label: '表格', action: () => insertAtCursor(TABLE_SNIPPET) },
        { label: '图片', action: () => insertImage() },
        { label: '双向链接', action: () => insertWikilink() },
    ]
    showContextMenu(x, y, [
        { label: '📥 插入', submenu: insert },
        { label: '🔗 插入链接', action: () => insertLink() },
        { label: '✂️ 剪切', action: () => { els.editor.focus(); els.editor.setSelectionRange(ctxSelStart, ctxSelEnd); document.execCommand('cut') } },
        { label: '⧉ 复制', action: () => { els.editor.focus(); els.editor.setSelectionRange(ctxSelStart, ctxSelEnd); document.execCommand('copy') } },
        { label: '☑ 全选', action: () => { els.editor.focus(); els.editor.select() } },
    ])
}

// 目录树空白处右键：在根目录新建 / 刷新
els.fileCatalogue.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return
    e.preventDefault(); e.stopPropagation()
    if (!state.rootPath) return
    showContextMenu(e.clientX, e.clientY, [
        { label: '📄 新建文件（根目录）', action: () => createNewFile(state.rootPath) },
        { label: '📁 新建文件夹（根目录）', action: () => createNewFolder(state.rootPath) },
        { label: '🔄 刷新', action: refresh },
    ])
})

// 校验名称合法性（文件名不能含路径分隔符等）
function validName(name) {
    return typeof name === 'string' && name.trim() !== '' && !/[\\/:*?"<>|]/.test(name)
}

async function createNewFile(dir) {
    const name = await window.prompt('新文件名：')
    if (!name) return
    if (!validName(name)) { alert('文件名包含非法字符'); return }
    const res = await window.electronAPI.createFile(joinPath(dir, name))
    if (!res.ok) { alert('新建失败：' + res.error); return }
    await refreshDir(dir)
}

async function createNewFolder(dir) {
    const name = await window.prompt('新文件夹名：')
    if (!name) return
    if (!validName(name)) { alert('文件夹名包含非法字符'); return }
    const res = await window.electronAPI.createDir(joinPath(dir, name))
    if (!res.ok) { alert('新建失败：' + res.error); return }
    await refreshDir(dir)
}

async function renameItem(item) {
    const newName = await window.prompt('新名称：', item.name)
    if (!newName || newName === item.name) return
    if (!validName(newName)) { alert('名称包含非法字符'); return }
    const newPath = joinPath(parentDir(item.path), newName)
    const res = await window.electronAPI.rename(item.path, newPath)
    if (!res.ok) { alert('重命名失败：' + res.error); return }
    // 关闭指向旧路径的标签（重命名后路径变了）
    state.tabs = state.tabs.filter((t) => t.path !== item.path)
    if (state.activeTabId === item.path) {
        state.activeTabId = state.tabs[0] ? state.tabs[0].id : null
    }
    renderTabs()
    if (state.tabs.length) renderActiveFile()
    // 标签跟着路径走（重命名后旧路径的标签迁移到新路径）
    if (state.tags[item.path]) {
        state.tags[newPath] = state.tags[item.path]
        delete state.tags[item.path]
        await saveTags()
        renderTags()
        updateTreeBadges()
    }
    await refreshDir(parentDir(item.path))
}

async function deleteItem(item) {
    const ok = await window.confirm('确定删除「' + item.name + '」吗？删除后无法恢复。')
    if (!ok) return
    const res = await window.electronAPI.remove(item.path)
    if (!res.ok) { alert('删除失败：' + res.error); return }
    // 关闭该文件及其子文件的所有标签
    const prefix = item.path + '\\'
    state.tabs = state.tabs.filter((t) => t.path !== item.path && !t.path.startsWith(prefix))
    if (state.tabs.length) {
        if (!state.tabs.some((t) => t.id === state.activeTabId)) {
            state.activeTabId = state.tabs[0].id
        }
        renderTabs()
        renderActiveFile()
    } else {
        state.activeTabId = null
        renderTabs()
        showEmpty('从左侧目录树选择一个文件', '文本文件可编辑，保存后写回磁盘')
    }
    // 清理标签（文件本身 + 文件夹下的所有子项）
    const tagPrefix = item.path + '\\'
    let tagChanged = false
    for (const p of Object.keys(state.tags)) {
        if (p === item.path || p.startsWith(tagPrefix)) { delete state.tags[p]; tagChanged = true }
    }
    if (tagChanged) {
        await saveTags()
        renderTags()
        updateTreeBadges()
        renderTagFilter()
    }
    await refreshDir(parentDir(item.path))
}

async function copyItem(item) {
    const dir = parentDir(item.path)
    const dot = item.name.lastIndexOf('.')
    const stem = (dot === -1 || item.isDir) ? item.name : item.name.slice(0, dot)
    const ext = (dot === -1 || item.isDir) ? '' : item.name.slice(dot)
    // 找一个不冲突的名字：xxx - 副本.ext、xxx - 副本 2.ext…
    let dest = joinPath(dir, stem + ' - 副本' + ext)
    let n = 2
    while (await pathExists(dest)) {
        dest = joinPath(dir, stem + ' - 副本 ' + n + ext)
        n++
    }
    const res = await window.electronAPI.copy(item.path, dest)
    if (!res.ok) { alert('复制失败：' + res.error); return }
    await refreshDir(dir)
}

// 判断路径是否存在（复用 getFileInfo / fs:stat）
async function pathExists(p) {
    const res = await window.electronAPI.getFileInfo(p)
    return res.ok
}

// ================================================================
// 收藏 + 最近文件（localStorage，复用最近文件夹的模式）
// ================================================================

const FAV_KEY = 'emerald-favorites'
const RECENT_FILES_KEY = 'emerald-recent-files'

// FAV_KEY 从纯路径数组升级为对象数组 { path, name, isDir }，读取时自动迁移旧格式
function getFavorites() {
    try {
        const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
        return raw.map((f) => (typeof f === 'string' ? { path: f, name: basename(f), isDir: false } : f))
    } catch { return [] }
}
function saveFavorites(list) {
    localStorage.setItem(FAV_KEY, JSON.stringify(list))
}
function isFavorite(path) {
    return getFavorites().some((f) => f.path === path)
}
// 切换收藏状态（文件与文件夹都可收藏）
function toggleFavorite(path, isDir) {
    const list = getFavorites()
    const i = list.findIndex((f) => f.path === path)
    if (i === -1) list.push({ path, name: basename(path), isDir: !!isDir })
    else list.splice(i, 1)
    saveFavorites(list)
    renderFavorites()
}
// 渲染侧栏顶部的"★ 收藏"分组
function renderFavorites() {
    const list = getFavorites()
    els.favoritesSection.innerHTML = ''
    if (list.length === 0) {
        els.favoritesSection.classList.add('hidden')
        return
    }
    els.favoritesSection.classList.remove('hidden')
    const title = document.createElement('div')
    title.className = 'fav-title'
    title.textContent = '★ 收藏'
    const count = document.createElement('span')   // C1：数量角标
    count.className = 'fav-count'
    count.textContent = list.length
    title.appendChild(count)
    els.favoritesSection.appendChild(title)
    for (const f of list) {
        const item = document.createElement('div')
        item.className = 'fav-item'
        item.title = f.path
        const star = document.createElement('span')
        star.className = 'fav-star'
        star.textContent = f.isDir ? '📁' : '★'
        const name = document.createElement('span')
        name.className = 'fav-name'
        name.textContent = f.name || basename(f.path)
        item.append(star, name)
        // 文件夹 → 进入该目录为新工作区；文件 → 直接打开
        item.addEventListener('click', () => {
            if (f.isDir) enterDirectory(f.path)
            else openFileByPath(f.path)
        })
        els.favoritesSection.appendChild(item)
    }
}
// 记录最近打开的文件（去重 + 置顶，最多 20）
function recordRecentFile(path) {
    let list
    try { list = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]') } catch { list = [] }
    list = list.filter((p) => p !== path)
    list.unshift(path)
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list.slice(0, 20)))
    renderRecentFiles() // 打开文件即刷新侧栏最近文件区
}

// 读取最近文件列表（string[]，元素为绝对路径）
function getRecentFiles() {
    try { return JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]') } catch { return [] }
}

// 渲染侧栏"🕘 最近文件"分组（复用收藏区的 .fav-item 样式）
function renderRecentFiles() {
    const list = getRecentFiles()
    els.recentFilesSection.innerHTML = ''
    if (list.length === 0 || !state.rootPath) {
        els.recentFilesSection.classList.add('hidden')
        return
    }
    els.recentFilesSection.classList.remove('hidden')
    const title = document.createElement('div')
    title.className = 'fav-title'
    title.textContent = '🕘 最近文件'
    const count = document.createElement('span')   // C1：数量角标
    count.className = 'fav-count'
    count.textContent = list.length
    title.appendChild(count)
    els.recentFilesSection.appendChild(title)
    for (const p of list.slice(0, 10)) {
        const item = document.createElement('div')
        item.className = 'fav-item'
        item.title = p
        const icon = document.createElement('span')
        icon.className = 'fav-star'
        icon.textContent = '📄'
        const name = document.createElement('span')
        name.className = 'fav-name'
        name.textContent = basename(p)
        item.append(icon, name)
        item.addEventListener('click', () => openFileByPath(p))
        els.recentFilesSection.appendChild(item)
    }
}

// ================================================================
// 标签系统（#5）：文件 / 文件夹打标签，侧栏按标签过滤
// 持久化：工作区根目录 .emerald/index.json（侧车文件，避免把元数据塞进 localStorage）
//   结构：{ version: 1, tags: { "绝对路径": { tags: ["笔记","TODO"], dir: false } } }
//   .emerald 是隐藏目录（点开头），目录树与搜索都会自动跳过它
// ================================================================

const TAGS_DIR = '.emerald'
const TAGS_FILE = '.emerald/index.json'

function tagsFilePath() {
    return joinPath(state.rootPath, TAGS_FILE)
}

// 读取工作区标签索引；文件不存在 / 损坏时按空处理（下次保存会重建）
async function loadTags() {
    if (!state.rootPath) return
    state.tags = {}
    const res = await window.electronAPI.readFile(tagsFilePath())
    if (res.ok) {
        try {
            const data = JSON.parse(res.content)
            if (data && typeof data.tags === 'object') state.tags = data.tags
        } catch { /* 损坏的索引：按空处理 */ }
    }
    renderTags()
    updateTreeBadges()
    renderTagFilter()
}

// 把当前标签索引写回 .emerald/index.json（目录不存在先创建）
async function saveTags() {
    if (!state.rootPath) return
    const payload = JSON.stringify({ version: 1, tags: state.tags }, null, 2)
    await window.electronAPI.createDir(joinPath(state.rootPath, TAGS_DIR))
    const res = await window.electronAPI.writeFile(tagsFilePath(), payload)
    if (!res.ok) alert('标签保存失败：' + res.error)
}

// 取某路径的标签数组（兼容旧格式：值直接是数组）
function getTagsFor(path) {
    const v = state.tags[path]
    if (!v) return []
    return Array.isArray(v) ? v : (v.tags || [])
}

// 弹出编辑标签对话框：逗号分隔输入，留空 = 清除全部标签
async function editTagsFor(path, name, isDir) {
    const current = getTagsFor(path).join(', ')
    const input = await window.prompt('为「' + name + '」设置标签（逗号分隔，留空清除）：', current)
    if (input === null) return
    const tags = [...new Set(input.split(/[,，]/).map((s) => s.trim()).filter(Boolean))]
    if (tags.length) state.tags[path] = { tags, dir: !!isDir }
    else delete state.tags[path]
    await saveTags()
    renderTags()
    updateTreeBadges()
    renderTagFilter()
}

// 渲染侧栏"🏷 标签"区：标签 + 数量（按数量降序），点击切换过滤
function renderTags() {
    els.tagsSection.innerHTML = ''
    const counts = new Map()
    for (const v of Object.values(state.tags)) {
        for (const t of (Array.isArray(v) ? v : v.tags)) counts.set(t, (counts.get(t) || 0) + 1)
    }
    if (counts.size === 0) {
        els.tagsSection.classList.add('hidden')
        return
    }
    els.tagsSection.classList.remove('hidden')
    const title = document.createElement('div')
    title.className = 'fav-title'
    title.textContent = '🏷 标签'
    const count = document.createElement('span')   // C1：数量角标
    count.className = 'fav-count'
    count.textContent = counts.size
    title.appendChild(count)
    els.tagsSection.appendChild(title)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    for (const [tag, n] of sorted) {
        const chip = document.createElement('span')
        chip.className = 'tag-chip' + (state.activeTag === tag ? ' active' : '')
        chip.title = '按标签「' + tag + '」过滤（' + n + ' 项）'
        const label = document.createElement('span')
        label.textContent = tag
        const count = document.createElement('span')
        count.className = 'tag-count'
        count.textContent = n
        chip.append(label, count)
        chip.addEventListener('click', () => {
            state.activeTag = (state.activeTag === tag) ? null : tag
            renderTags()
            renderTagFilter()
        })
        els.tagsSection.appendChild(chip)
    }
}

// 标签过滤态：目录树临时隐藏，换成"标签：xxx"的平铺结果列表
function renderTagFilter() {
    const catalogue = els.fileCatalogue
    catalogue.querySelectorAll('.tagFilterBar').forEach((el) => el.remove())
    catalogue.querySelectorAll('.tagFilterItem').forEach((el) => el.remove())
    catalogue.querySelectorAll(':scope > .tree-node').forEach((n) => (n.style.display = ''))
    if (!state.activeTag) return

    const entries = Object.entries(state.tags)
        .filter(([, v]) => (Array.isArray(v) ? v : v.tags).includes(state.activeTag))
        .sort((a, b) => a[0].localeCompare(b[0], 'zh'))

    const bar = document.createElement('div')
    bar.className = 'tagFilterBar'
    const info = document.createElement('span')
    info.textContent = '🏷 ' + state.activeTag + ' · ' + entries.length + ' 项'
    const clear = document.createElement('button')
    clear.className = 'tagFilterClear'
    clear.textContent = '✕ 清除筛选'
    clear.addEventListener('click', () => { state.activeTag = null; renderTags(); renderTagFilter() })
    bar.append(info, clear)
    catalogue.prepend(bar)

    catalogue.querySelectorAll(':scope > .tree-node').forEach((n) => (n.style.display = 'none'))
    for (const [p, v] of entries) {
        const isDir = !Array.isArray(v) && v.dir
        const item = document.createElement('div')
        item.className = 'fav-item tagFilterItem'
        item.title = p
        const icon = document.createElement('span')
        icon.className = 'fav-star'
        icon.textContent = isDir ? '📁' : '📄'
        const name = document.createElement('span')
        name.className = 'fav-name'
        name.textContent = basename(p)
        const pathHint = document.createElement('span')
        pathHint.className = 'tagPath'
        pathHint.textContent = relativeOf(p)
        item.append(icon, name, pathHint)
        item.addEventListener('click', () => {
            state.activeTag = null
            renderTags()
            renderTagFilter()
            if (isDir) revealAndExpand(p)
            else { openFileByPath(p); syncTreeSelection(p) }
        })
        catalogue.appendChild(item)
    }
}

// 给树行同步标签徽章（只更新已在 DOM 里的行；懒加载的新行由 renderItems 直接带徽章）
function updateTreeBadges() {
    document.querySelectorAll('.tree-row[data-path]').forEach((row) => {
        row.querySelectorAll('.tag-badge').forEach((b) => b.remove())
        const tags = getTagsFor(row.dataset.path)
        if (!tags.length) return
        const badge = document.createElement('span')
        badge.className = 'tag-badge'
        badge.textContent = tags.join(' / ')
        badge.title = '标签：' + tags.join('、')
        row.appendChild(badge)
    })
}

// ================================================================
// 快速切换器（Ctrl+P）
// ================================================================

function openQuickSwitcher() {
    if (!state.rootPath) return
    els.quickSwitcher.classList.remove('hidden')
    els.qsInput.value = ''
    els.qsResults.innerHTML = ''
    state.searchResults = []
    state.searchIndex = 0
    els.qsInput.focus()
}

function closeQuickSwitcher() {
    els.quickSwitcher.classList.add('hidden')
}

let qsTimer
els.qsInput.addEventListener('input', () => {
    clearTimeout(qsTimer)
    qsTimer = setTimeout(() => runSearch(els.qsInput.value.trim()), 200) // 防抖：停止输入 200ms 才搜
})

els.qsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeQuickSwitcher(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveQsIndex(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveQsIndex(-1); return }
    if (e.key === 'Enter') { e.preventDefault(); openQsSelection() }
})

async function runSearch(q) {
    if (!q) {
        renderQsResults([], [])
        return
    }
    els.statusCenter.textContent = '正在搜索…'   // B8：大工作区全文搜索可能耗时，先给反馈避免"卡死"错觉
    // 并行搜索：文件名命中 + 文件内容命中（Promise.all 两个 IPC 同时进行）
    const [nameRes, contentRes] = await Promise.all([
        window.electronAPI.search(state.rootPath, q),
        window.electronAPI.searchContent(state.rootPath, q),
    ])
    renderQsResults(nameRes.ok ? nameRes.results : [], contentRes.ok ? contentRes.results : [])
    updateStatusBar()
}

// 结果排序：名字开头命中 > 名字包含 > 路径包含
// 分两组渲染：文件名命中（靠前）+ 文件内容命中（带命中行预览与行号）
function renderQsResults(results, contentResults) {
    const q = els.qsInput.value.trim().toLowerCase()
    const scored = results
        .map((r) => {
            const name = r.name.toLowerCase()
            let score = 2
            if (name.startsWith(q)) score = 0
            else if (name.includes(q)) score = 1
            return { r, score }
        })
        .sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name, 'zh'))
    // 给每个结果打 kind 标记，内容命中的额外带 lineNum（跳转用）
    const nameList = scored.map((s) => ({ ...s.r, kind: 'name' }))
    const contentList = (contentResults || []).map((r) => ({
        ...r,
        kind: 'content',
        lineNum: (r.matches[0] || {}).lineNum || 1,
    }))
    state.searchResults = nameList.concat(contentList)
    state.searchIndex = Math.min(state.searchIndex, Math.max(0, state.searchResults.length - 1))

    const addSeparator = (text) => {
        const sep = document.createElement('div')
        sep.className = 'qs-sep'
        sep.textContent = text
        els.qsResults.appendChild(sep)
    }
    const appendItem = (r, i) => {
        const item = document.createElement('div')
        item.className = 'qs-item' + (i === state.searchIndex ? ' active' : '')
        if (r.kind === 'content') item.classList.add('qs-content')
        item.dataset.i = i

        const icon = document.createElement('span')
        icon.className = 'qs-icon'
        icon.textContent = r.isDir ? '📁' : '📄'
        const name = document.createElement('span')
        name.className = 'qs-name'
        name.textContent = r.name
        item.append(icon, name)

        if (r.kind === 'content') {
            const line = document.createElement('div')
            line.className = 'qs-line'
            // 命中行预览：关键字用 <mark> 高亮，附行号
            line.innerHTML = highlightText(r.matches[0].text, q) + ' <span class="qs-ln">第 ' + r.lineNum + ' 行</span>'
            item.appendChild(line)
        }
        const rel = document.createElement('span')
        rel.className = 'qs-path'
        rel.textContent = (r.isDir ? '📂 ' : '') + relativeOf(r.path)
        item.appendChild(rel)

        item.addEventListener('click', () => { state.searchIndex = i; openQsSelection() })
        item.addEventListener('mousemove', () => highlightQs(i))
        els.qsResults.appendChild(item)
    }

    els.qsResults.innerHTML = ''
    let idx = 0
    if (nameList.length) {
        if (contentList.length) addSeparator('文件名匹配')
        nameList.forEach((r) => appendItem(r, idx++))
    }
    if (contentList.length) {
        addSeparator('内容匹配')
        contentList.forEach((r) => appendItem(r, idx++))
    }
    updateQsHighlight()
}

// 关键字高亮：先转义命中文本再包 <mark>，防止文件内容里的 HTML 被注入
function highlightText(text, q) {
    const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (!q) return esc
    const idx = esc.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return esc
    const end = idx + q.length
    return esc.slice(0, idx) + '<mark class="qs-mark">' + esc.slice(idx, end) + '</mark>' + esc.slice(end)
}

function moveQsIndex(delta) {
    if (!state.searchResults.length) return
    state.searchIndex = (state.searchIndex + delta + state.searchResults.length) % state.searchResults.length
    updateQsHighlight()
}

function highlightQs(i) {
    state.searchIndex = i
    updateQsHighlight()
}

function updateQsHighlight() {
    els.qsResults.querySelectorAll('.qs-item').forEach((el, i) => {
        el.classList.toggle('active', i === state.searchIndex)
    })
    const active = els.qsResults.querySelector('.qs-item.active')
    if (active) active.scrollIntoView({ block: 'nearest' })
}

// 回车打开选中项：内容命中 → 打开并跳到行；文件夹 → 展开目录；文件 → 打开标签
async function openQsSelection() {
    const r = state.searchResults[state.searchIndex]
    if (!r) return
    closeQuickSwitcher()
    if (r.kind === 'content') {
        await openFileAndRevealLine(r.path, r.lineNum)
        return
    }
    if (r.isDir) {
        await revealAndExpand(r.path)
        return
    }
    await openFileByPath(r.path)
    await revealAndExpand(parentDir(r.path))
}

// 打开文件并跳到命中行（内容搜索定位）；若上次停在预览模式则切回编辑态以显示光标
async function openFileAndRevealLine(path, lineNum) {
    await openFileByPath(path)
    await revealAndExpand(parentDir(path))
    if (state.viewMode !== 'edit') toggleViewMode()
    revealLine(lineNum)
}

// 相对工作区根目录的路径（用于搜索结果展示）
function relativeOf(p) {
    const base = state.rootPath
    const rel = p.startsWith(base) ? p.slice(base.length) : p
    return rel.replace(/^[\\/]+/, '').split('\\').join('/')
}

// ================================================================
// 命令注册表 + 命令面板（Ctrl+Shift+P）
// ================================================================

// 统一命令清单：把散落的按钮/菜单/快捷键动作收敛到这里。
// when() 返回 false 的命令不在面板显示（比如没打开文件就不显示"保存"）。
const COMMANDS = [
    { id: 'file.save', label: '保存当前文件', shortcut: 'Ctrl+S', when: () => !!state.currentFile, run: saveFile },
    { id: 'file.new', label: '新建文件', when: () => !!state.rootPath, run: () => createNewFile(state.rootPath) },
    { id: 'file.newFolder', label: '新建文件夹', when: () => !!state.rootPath, run: () => createNewFolder(state.rootPath) },
    { id: 'file.newNote', label: '新建笔记', when: () => !!state.rootPath, run: createNewNote },
    { id: 'nav.back', label: '后退', when: () => state.historyIndex > 0, run: goBack },
    { id: 'nav.forward', label: '前进', when: () => state.historyIndex < state.history.length - 1, run: goForward },
    { id: 'nav.toggleView', label: '切换 阅读/编辑', when: () => !!state.currentFile, run: toggleViewMode },
    { id: 'nav.closeTab', label: '关闭当前标签', when: () => !!state.currentFile, run: () => closeTab(state.currentFile) },
    { id: 'view.refresh', label: '刷新工作区', when: () => !!state.rootPath, run: refresh },
    { id: 'view.expandAll', label: '全部展开', when: () => !!state.rootPath, run: expandAll },
    { id: 'view.collapseAll', label: '全部收起', when: () => !!state.rootPath, run: collapseAll },
    { id: 'view.sort', label: '排序目录', when: () => !!state.rootPath, run: () => showSortMenu(null) },
    { id: 'file.switchWorkspace', label: '切换工作区', when: () => !!state.rootPath, run: switchWorkspace },
    { id: 'view.toggleSidebar', label: '收起 / 展开目录栏', run: toggleSidebar },
    { id: 'view.toggleTheme', label: '切换 亮色 / 暗色主题', run: toggleTheme },
    { id: 'search.files', label: '搜索文件', shortcut: 'Ctrl+P', when: () => !!state.rootPath, run: openQuickSwitcher },
    { id: 'tags.edit', label: '为当前文件编辑标签', when: () => !!state.currentFile, run: () => editTagsFor(state.currentFile.path, state.currentFile.name, false) },
    { id: 'tags.clearFilter', label: '清除标签筛选', when: () => !!state.activeTag, run: () => { state.activeTag = null; renderTags(); renderTagFilter() } },
]

let cpFiltered = []   // 当前过滤后的命令
let cpIndex = 0       // 当前高亮索引

function openCommandPalette() {
    els.commandPalette.classList.remove('hidden')
    els.cpInput.value = ''
    els.cpInput.focus()
    renderCommands('')
}

function closeCommandPalette() {
    els.commandPalette.classList.add('hidden')
}

// 过滤 + 渲染命令列表（label 匹配关键词）
function renderCommands(q) {
    const query = (q || '').toLowerCase()
    cpFiltered = COMMANDS.filter((c) => (!c.when || c.when()) && c.label.toLowerCase().includes(query))
    cpIndex = 0
    els.cpResults.innerHTML = ''
    cpFiltered.forEach((c, i) => {
        const item = document.createElement('div')
        item.className = 'qs-item' + (i === cpIndex ? ' active' : '')
        const icon = document.createElement('span')
        icon.className = 'qs-icon'
        icon.textContent = '▶'
        const name = document.createElement('span')
        name.className = 'qs-name'
        name.textContent = c.label
        const shortcut = document.createElement('span')
        shortcut.className = 'qs-path'
        shortcut.textContent = c.shortcut || ''
        item.append(icon, name, shortcut)
        item.addEventListener('click', () => runCommand(c))
        item.addEventListener('mousemove', () => { cpIndex = i; updateCpHighlight() })
        els.cpResults.appendChild(item)
    })
}

function updateCpHighlight() {
    els.cpResults.querySelectorAll('.qs-item').forEach((el, i) => el.classList.toggle('active', i === cpIndex))
}

function moveCpIndex(delta) {
    if (!cpFiltered.length) return
    cpIndex = (cpIndex + delta + cpFiltered.length) % cpFiltered.length
    updateCpHighlight()
}

function runCommand(c) {
    closeCommandPalette()
    c.run()
}

els.cpInput.addEventListener('input', () => renderCommands(els.cpInput.value.trim()))
els.cpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCpIndex(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCpIndex(-1); return }
    if (e.key === 'Enter') { e.preventDefault(); const c = cpFiltered[cpIndex]; if (c) runCommand(c) }
})

// ================================================================
// 主题切换
// ================================================================

function applyTheme(theme) {
    // 日月图标显隐由 CSS（:root[data-theme]）处理，这里只切主题变量
    document.documentElement.dataset.theme = theme
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('emerald-theme', state.theme)
    applyTheme(state.theme)
}

// ================================================================
// 状态栏
// ================================================================

function updateStatusBar() {
    const f = state.currentFile
    if (f && f.path) {
        els.statusLeft.textContent = '📄 ' + f.path
        els.statusCenter.textContent = state.tabs.length + ' 个标签 · '
            + (state.viewMode === 'preview' ? '👁 预览' : '✏️ 编辑')   // F1：模式图标
    } else {
        els.statusLeft.textContent = '就绪'
        if (state.rootPath) els.statusCenter.textContent = els.statusCenter.textContent || '工作区已打开'
    }
    els.statusRight.textContent = '行 ' + state.cursorLine + ' · 列 ' + state.cursorCol + ' · UTF-8'
}

// 光标位置跟踪（文本编辑时实时刷新状态栏右段）
function updateCursorPos() {
    const el = els.editor
    const pos = el.selectionStart
    const upto = el.value.slice(0, pos)
    const nl = upto.lastIndexOf('\n')
    state.cursorLine = nl === -1 ? 1 : upto.split('\n').length
    state.cursorCol = pos - nl
    updateStatusBar()
}

// ================================================================
// 悬浮提示（显示完整路径）
// ================================================================

let tooltipVisible = false
function showTooltipAt(x, y, text) {
    els.tooltip.textContent = text
    els.tooltip.classList.remove('hidden')
    const px = Math.min(x + 14, window.innerWidth - 280)
    const py = Math.min(y + 16, window.innerHeight - 44)
    els.tooltip.style.left = Math.max(4, px) + 'px'
    els.tooltip.style.top = Math.max(4, py) + 'px'
    tooltipVisible = true
}
function hideTooltip() {
    tooltipVisible = false
    els.tooltip.classList.add('hidden')
}

// ================================================================
// 悬浮预览（Hover 文本文件浮层预览，复用 previewHtmlFor）
// ================================================================

let previewTimer = null
let previewPath = null   // 当前正在预览的文件路径（去重）

function showHoverPreview(path, x, y) {
    if (previewPath === path) return   // 同一个文件不再重复读盘
    clearTimeout(previewTimer)
    previewTimer = setTimeout(async () => {
        const res = await window.electronAPI.readFile(path)
        if (!res.ok) return
        els.hoverPreview.innerHTML = previewHtmlFor(path, res.content)
        positionHoverPreview(x, y)
        els.hoverPreview.classList.remove('hidden')
        previewPath = path
    }, 400)   // 延迟 400ms，避免扫过一行就闪
}

function positionHoverPreview(x, y) {
    const pw = Math.min(480, Math.floor(window.innerWidth * 0.6)), ph = 360   // D3：窄窗口下与 CSS max-width 一致
    const px = Math.min(x + 16, window.innerWidth - pw - 8)
    const py = Math.min(y + 16, window.innerHeight - ph - 8)
    els.hoverPreview.style.left = Math.max(8, px) + 'px'
    els.hoverPreview.style.top = Math.max(8, py) + 'px'
}

function hideHoverPreview() {
    clearTimeout(previewTimer)
    els.hoverPreview.classList.add('hidden')
    previewPath = null
}

// 用事件委托统一处理树上的悬浮（避免给每行都加监听）
els.fileCatalogue.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.tree-row')
    if (row) {
        showTooltipAt(e.clientX, e.clientY, row.dataset.path)
        const isDir = row.querySelector('.tree-caret') !== null
        if (!isDir && isTextFile(basename(row.dataset.path))) {
            showHoverPreview(row.dataset.path, e.clientX, e.clientY)
        } else {
            hideHoverPreview()
        }
    } else {
        hideTooltip()
        hideHoverPreview()
    }
})
els.fileCatalogue.addEventListener('mouseleave', () => { hideTooltip(); hideHoverPreview() })

// ================================================================
// 排序（目录树顶部按钮）
// ================================================================

// 弹排序菜单让用户选（复用右键菜单机制）。
// 原顶部排序按钮已移除，命令面板调用时 anchorEl 为 null → 锚在目录区左上角
function showSortMenu(anchorEl) {
    const treeRect = els.fileCatalogue.getBoundingClientRect()
    const rect = anchorEl
        ? anchorEl.getBoundingClientRect()
        : { left: treeRect.left + 8, bottom: treeRect.top + 8 }
    const modes = [
        { key: 'name', label: '🔤 按名称（A→Z）' },
        { key: 'name-desc', label: '🔤 按名称（Z→A）' },
        { key: 'type', label: '🗂 按类型' },
    ]
    const items = modes.map((m) => ({
        label: (state.sortMode === m.key ? '✓ ' : '') + m.label,
        action: () => setSortMode(m.key),
    }))
    showContextMenu(rect.left, rect.bottom + 4, items)
}

// 应用排序并重排整棵已展开的树（保留展开状态）
async function setSortMode(mode) {
    if (state.sortMode === mode) return
    state.sortMode = mode
    await resortTree()
}

async function resortTree() {
    if (!state.rootPath) return
    const expanded = [...state.expanded]   // 记下之前展开的目录，排完再恢复
    state.expanded.clear()
    els.fileCatalogue.innerHTML = ''
    const res = await window.electronAPI.readDir(state.rootPath)
    if (!res.ok) return
    renderItems(res.items, els.fileCatalogue, 0)  // renderItems 内部会按新模式排序
    for (const p of expanded) await revealAndExpand(p)  // 恢复展开状态
}

// ================================================================
// 后退 / 前进（标题栏导航，浏览器式历史）
// ================================================================

let isNavigating = false   // 导航中不记录历史，避免 goBack 又往历史里塞

// 用户打开/切换文件时记录访问历史
function recordHistory(path) {
    if (isNavigating) return
    state.history = state.history.slice(0, state.historyIndex + 1)  // 分叉后截掉旧历史
    if (state.history[state.historyIndex] === path) return           // 连续重复不记
    state.history.push(path)
    state.historyIndex = state.history.length - 1
    updateNavBtns()
}

function goBack() {
    if (state.historyIndex <= 0) return
    state.historyIndex--
    activateHistoryPath(state.history[state.historyIndex])
}

function goForward() {
    if (state.historyIndex >= state.history.length - 1) return
    state.historyIndex++
    activateHistoryPath(state.history[state.historyIndex])
}

async function activateHistoryPath(path) {
    isNavigating = true
    try {
        const tab = state.tabs.find((t) => t.path === path)
        if (tab) activateTab(tab.id)
        else await openFileByPath(path)
    } finally {
        isNavigating = false
    }
    updateNavBtns()
}

// 后退/前进按钮的可用性视觉反馈（不可用则变淡）
function updateNavBtns() {
    els.backBtn.style.opacity = state.historyIndex > 0 ? '1' : '0.35'
    els.forwardBtn.style.opacity = state.historyIndex < state.history.length - 1 ? '1' : '0.35'
}

// ================================================================
// 新建笔记（.md）——目录树顶部按钮
// ================================================================

async function createNewNote() {
    if (!state.rootPath) return
    const name = await window.prompt('笔记名称（自动补 .md）：')
    if (!name) return
    if (!validName(name)) { alert('名称包含非法字符'); return }
    const fname = /\.(md|markdown)$/i.test(name) ? name : name + '.md'
    const full = joinPath(state.rootPath, fname)
    const res = await window.electronAPI.createFile(full)
    if (!res.ok) { alert('新建失败：' + res.error); return }
    await refreshDir(state.rootPath)
    await openFileByPath(full)   // 新建后直接打开编辑
}

// ================================================================
// 阅读 / 编辑切换（标题栏按钮，复用编辑器头部切换逻辑）
// ================================================================

function toggleViewMode() {
    const f = state.currentFile
    if (!f || !f.path) return   // 空白标签没有可预览的内容
    state.viewMode = state.viewMode === 'preview' ? 'edit' : 'preview'
    updateViewModeBtn()
    if (state.viewMode === 'preview') showPreview()
    else showEditorInput()
    updateStatusBar()
}

// ================================================================
// 目录栏收起 / 展开
// ================================================================

let autoCollapsed = false   // 是否由窄窗口自动收起（仅它触发的收起会在恢复宽度后自动展开）

function toggleSidebar() {
    autoCollapsed = false    // 手动操作后不再自动恢复，尊重用户意图
    state.sidebarCollapsed = !state.sidebarCollapsed
    document.querySelector('.appRow').classList.toggle('sidebar-collapsed', state.sidebarCollapsed)
    els.expandSidebarBtn.classList.toggle('hidden', !state.sidebarCollapsed)
    els.toggleSidebarBtn.textContent = state.sidebarCollapsed ? '▶' : '◀'
}

// D1：窗口过窄时自动收起侧栏，把空间让给编辑器；恢复宽度后自动展开
window.addEventListener('resize', () => {
    if (window.innerWidth < 720) {
        if (!state.sidebarCollapsed) { toggleSidebar(); autoCollapsed = true }
    } else if (autoCollapsed && state.sidebarCollapsed) {
        toggleSidebar()
    }
})

// ================================================================
// 事件绑定
// ================================================================

els.openFolderBtn.addEventListener('click', chooseFolder)
// 点击侧栏路径栏 = 切换工作区（功能与命令面板"切换工作区"一致）
els.currentPath.addEventListener('click', () => state.rootPath && switchWorkspace())
// 显眼的"⇄ 切换"按钮（工作区栏左侧第一个按钮）
els.switchWsBtn.addEventListener('click', () => state.rootPath && switchWorkspace())
// B4：引导条关闭（记住，不再显示）
els.guideClose.addEventListener('click', () => {
    els.guideBar.classList.add('hidden')
    localStorage.setItem('emerald-guide-dismissed', '1')
})
// B2：空状态快捷操作按钮
els.emptyOpenFolderBtn.addEventListener('click', () => (state.rootPath ? switchWorkspace() : chooseFolder()))
els.emptyNewNoteBtn.addEventListener('click', () => state.rootPath && createNewNote())
els.emptyNewFileBtn.addEventListener('click', () => state.rootPath && createNewFile(state.rootPath))
els.titleRefreshBtn.addEventListener('click', refresh)
els.searchBtn.addEventListener('click', openQuickSwitcher)
els.newFileBtn.addEventListener('click', () => state.rootPath && createNewFile(state.rootPath))
els.newFolderBtn.addEventListener('click', () => state.rootPath && createNewFolder(state.rootPath))
els.saveBtn.addEventListener('click', saveFile)
els.backBtn.addEventListener('click', goBack)
els.forwardBtn.addEventListener('click', goForward)
els.toggleSidebarBtn.addEventListener('click', toggleSidebar)
els.expandSidebarBtn.addEventListener('click', toggleSidebar)
// 标题栏右侧：主题切换（日月图标）
els.themeSunBtn.addEventListener('click', toggleTheme)
els.themeMoonBtn.addEventListener('click', toggleTheme)
// 导航栏最右侧"＋"：新建空白标签
els.tabAddBtn.addEventListener('click', addBlankTab)
// PDF 预览：右上角"系统打开"兜底
els.pdfOpenBtn.addEventListener('click', () => {
    if (currentPdfPath) window.electronAPI.openPath(currentPdfPath)
})

// 启动界面自带的窗口控制
document.getElementById('launchMin').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('launchClose').addEventListener('click', () => window.electronAPI.closeWindow())

// 主界面窗口控制（B2）：关闭流程统一交给主进程 close 拦截 → onConfirmClose 确认
document.getElementById('minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('fullscreen').addEventListener('click', () => window.electronAPI.fullscreen())
document.getElementById('closewindow').addEventListener('click', () => window.electronAPI.closeWindow())

// 主进程请求确认关闭：有未保存修改就弹自研确认框，确认后放行关闭。
// 覆盖所有关闭途径：关闭按钮 / Alt+F4 / 任务栏
window.electronAPI.onConfirmClose(async () => {
    if (anyDirty()) {
        const ok = await window.confirm('有文件未保存，确定退出吗？')
        if (!ok) return
    }
    saveSession()               // 退出前保存会话
    window.electronAPI.doClose()
})
window.addEventListener('beforeunload', saveSession)  // 兜底：系统方式关闭也保存

// 全局按键：点击别处 / 按 Esc 关闭右键菜单
document.addEventListener('click', hideContextMenu)
document.addEventListener('contextmenu', (e) => e.preventDefault()) // 全局禁用浏览器原生菜单
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!els.quickSwitcher.classList.contains('hidden')) closeQuickSwitcher()
        if (!els.commandPalette.classList.contains('hidden')) closeCommandPalette()
        hideContextMenu()
    }
})

// 光标位置更新
els.editor.addEventListener('keyup', updateCursorPos)
els.editor.addEventListener('click', updateCursorPos)
els.editor.addEventListener('select', updateCursorPos)

// 编辑器右键：弹出 Obsidian 风格快捷菜单（记住选区，弹出后 textarea 会失焦）
els.editor.addEventListener('contextmenu', (e) => {
    if (!state.currentFile) return
    e.preventDefault(); e.stopPropagation()
    ctxSelStart = els.editor.selectionStart
    ctxSelEnd = els.editor.selectionEnd
    showEditorContextMenu(e.clientX, e.clientY)
})

// 快捷键
document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()          // Ctrl+Shift+P：命令面板
        openCommandPalette()
        return
    }
    if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()          // 阻止浏览器默认的"另存为"
        saveFile()
        return
    }
    if (mod && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'k')) {
        e.preventDefault()          // Ctrl+P/K：快速切换器
        if (!els.quickSwitcher.classList.contains('hidden')) closeQuickSwitcher()
        else openQuickSwitcher()
    }
})

// ================================================================
// 启动初始化
// ================================================================

applyTheme(state.theme)
renderTabs()
updateStatusBar()
updateNavBtns()
renderRecentFolders()
renderSessionRestore()
renderFavorites()
renderRecentFiles()
renderTags()
// 自动恢复上次会话：存在快照则直接进入主界面，否则停在启动界面
restoreSession()
