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
    theme: localStorage.getItem('emerald-theme') || 'light',   // 有效主题（随 themeMode 更新）
    themeMode: localStorage.getItem('emerald-theme-mode') || 'light',   // 亮 / 暗 / 跟随系统
    contextMenu: null,       // 当前打开的右键菜单 DOM
    sortMode: localStorage.getItem('emerald-sort-mode') || 'name',   // 排序方式：name / name-desc / type（D 设置可改默认）
    history: [],             // 打开过的文件路径序列（后退/前进导航）
    historyIndex: -1,        // 当前在 history 中的位置
    sidebarCollapsed: false, // 目录栏是否收起
    tags: {},                // 标签索引：{ 绝对路径: { tags: string[], dir: bool } }，随工作区从 .emerald/index.json 加载
    activeTag: null,         // 侧栏正在过滤的标签（null = 未过滤）
    gitStatus: {},           // Git 状态：{ 绝对路径: badge 字母 }，随工作区加载（git:status）
    gitIsRepo: false,        // 工作区是否为 git 仓库
    gitBranchName: '',       // 当前分支名
    gitRemote: null,         // 远程仓库 { name, url, push } | null
    batchMode: false,        // 批量重命名选择模式
    batchSelection: [],      // 批量选择：绝对路径数组（点击顺序）
    panes: [{ tabId: null, viewMode: 'edit' }],   // #11 分屏：每个面板显示一个标签（tabId 指向 state.tabs）
    activePane: 0,           // 活动面板索引（文件打开 / 查找 / 光标操作作用于此面板）
}

// ================================================================
// #11 多面板分屏基础设施
// ================================================================

// 让 state.activeTabId 与活动面板的标签保持一致（currentFile 等继续可用）
function syncActiveTabId() {
    const pane = state.panes[state.activePane]
    state.activeTabId = pane ? pane.tabId : null
}

// 切换到指定面板（点击面板内任意处触发）
function setActivePane(i) {
    if (i === state.activePane) return
    state.activePane = i
    const pane = state.panes[i]
    if (pane) state.viewMode = pane.viewMode || 'edit'
    syncActiveTabId()
    // 切到该面板时把视图刷为该标签最新内容：防止"双面板显示同一标签"时，
    // 旧面板的陈旧 textarea 在后续输入时整段回写覆盖新内容
    if (pane && pane.tabId) {
        const tab = state.tabs.find((t) => t.id === pane.tabId)
        if (tab && typeof tab.content === 'string') {
            const P = paneEls(i)
            if (P.editor.value !== tab.content) P.editor.value = tab.content
            if (!P.liveEditor.classList.contains('hidden')) renderLiveEditor(i)
            else updateSaveStatus(i)
        }
    }
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('pane-active', Number(p.dataset.pane) === i))
    updateStatusBar()
}

// 面板 DOM 访问器：pane0 用静态 HTML（保留原 id），pane1 用动态创建的元素
let pane1Els = null
function paneEls(i) {
    if (i === 0) {
        return {
            pane: document.getElementById('pane0'),
            title: els.editorTitle,
            typeBadge: els.fileTypeBadge,
            viewModeBtn: els.viewModeBtn,
            backlinksBtn: els.backlinksBtn,
            fileMeta: els.fileMeta,
            saveStatus: els.saveStatus,
            editor: els.editor,
            liveEditor: els.liveEditor,
            previewPane: els.previewPane,
            previewContent: els.previewContent,
            backlinksPanel: els.backlinksPanel,
            backlinksList: els.backlinksList,
            backlinksClose: els.backlinksClose,
            empty: document.getElementById('pane0Empty'),
        }
    }
    if (!pane1Els) pane1Els = createPaneDom()
    return pane1Els
}

function curPaneEls() {
    return paneEls(state.activePane)
}

// 活动面板的文本框（供光标 / 选区 / 右键菜单等共用）
function curEditor() {
    return curPaneEls().editor
}

// 动态创建第二个分屏面板（结构与 pane0 一致，类名寻址）
function createPaneDom() {
    const pane = document.createElement('div')
    pane.className = 'pane'
    pane.dataset.pane = '1'

    const header = document.createElement('div')
    header.className = 'editorHeader'
    const typeBadge = document.createElement('span'); typeBadge.className = 'fileTypeBadge'
    const title = document.createElement('span'); title.className = 'editorTitle'
    const viewModeBtn = document.createElement('button'); viewModeBtn.className = 'viewModeBtn'; viewModeBtn.style.display = 'none'; viewModeBtn.textContent = '👁 预览'
    const backlinksBtn = document.createElement('button'); backlinksBtn.className = 'viewModeBtn'; backlinksBtn.style.display = 'none'; backlinksBtn.textContent = '🔗 反链'; backlinksBtn.title = '查看引用了本文档的笔记'
    const fileMeta = document.createElement('span'); fileMeta.className = 'fileMeta'
    const saveStatus = document.createElement('span'); saveStatus.className = 'saveStatus'; saveStatus.textContent = '已保存'
    const pluginBtn = document.createElement('button'); pluginBtn.className = 'viewModeBtn pluginBtn'; pluginBtn.textContent = '🧩'; pluginBtn.title = '插件命令'
    pluginBtn.addEventListener('click', (e) => showPluginMenu(e.clientX, e.clientY))
    header.append(typeBadge, title, viewModeBtn, backlinksBtn, fileMeta, saveStatus, pluginBtn)

    const empty = document.createElement('div'); empty.className = 'pane-empty hidden'; empty.textContent = '点击左侧文件在此打开'
    const editor = document.createElement('textarea'); editor.className = 'editor'; editor.spellcheck = false; editor.wrap = 'off'
    const liveEditor = document.createElement('div'); liveEditor.className = 'previewPane liveEditor hidden'
    const previewPane = document.createElement('div'); previewPane.className = 'previewPane hidden'
    const previewContent = document.createElement('div')
    previewPane.appendChild(previewContent)
    const backlinksPanel = document.createElement('div'); backlinksPanel.className = 'backlinksPanel hidden'
    const head = document.createElement('div'); head.className = 'backlinks-head'
    const sp = document.createElement('span'); sp.textContent = '🔗 反链'
    const close = document.createElement('button'); close.className = 'backlinks-close'; close.textContent = '×'; close.title = '关闭'
    head.append(sp, close)
    const list = document.createElement('div'); list.className = 'backlinks-list'
    backlinksPanel.append(head, list)

    pane.append(header, empty, editor, liveEditor, previewPane, backlinksPanel)
    els.splitContainer.appendChild(pane)

    // 事件接线（与 pane0 一致）
    pane.addEventListener('click', () => setActivePane(1))
    editor.addEventListener('input', () => onEditorInput(1))
    editor.addEventListener('keyup', updateCursorPos)
    editor.addEventListener('click', updateCursorPos)
    editor.addEventListener('select', updateCursorPos)
    editor.addEventListener('contextmenu', (e) => {
        if (!state.currentFile) return
        e.preventDefault(); e.stopPropagation()
        ctxSelStart = editor.selectionStart
        ctxSelEnd = editor.selectionEnd
        showEditorContextMenu(e.clientX, e.clientY)
    })
    viewModeBtn.addEventListener('click', () => { setActivePane(1); toggleViewMode() })
    backlinksBtn.addEventListener('click', () => { setActivePane(1); showBacklinks() })
    close.addEventListener('click', closeBacklinks)
    liveEditor.addEventListener('click', handleLiveEditorClick)
    liveEditor.addEventListener('contextmenu', handleLiveEditorCtxMenu)
    previewContent.addEventListener('change', handlePreviewChange)
    previewContent.addEventListener('click', handlePreviewClick)

    return {
        pane, title, typeBadge, viewModeBtn, backlinksBtn, fileMeta, saveStatus, pluginBtn,
        editor, liveEditor, previewPane, previewContent, backlinksPanel, backlinksList: list,
        backlinksClose: close, empty,
    }
}

// 面板文本框输入 → 更新该面板标签的内容 + 脏状态
function onEditorInput(paneIndex) {
    const tab = state.tabs.find((t) => t.id === state.panes[paneIndex].tabId)
    if (!tab) return
    tab.content = paneEls(paneIndex).editor.value
    updateSaveStatus(paneIndex)
    renderTabs()
    if (paneIndex === state.activePane) renderOutline()   // G：大纲随输入刷新
}

// ================================================================
// #11 分屏：2 面板各自独立编辑（textarea / 实时编辑 / 阅读视图）
// ================================================================

// 分屏：新增第二个面板（空白），文件可点进任意面板
function splitPane() {
    if (state.panes.length >= 2) return
    state.panes.push({ tabId: null, viewMode: 'edit' })
    pane1Els = createPaneDom()   // 创建 DOM + 事件接线（必须赋值，paneEls(1) 才能复用）
    els.splitBtn.classList.add('on')
    els.splitBtn.title = '取消分屏'
    setActivePane(1)   // 新面板成为活动面板
    renderAllPanes()
}

// 取消分屏：移除第二个面板
function unsplitPane() {
    if (state.panes.length < 2) return
    state.panes.length = 1
    if (pane1Els) { pane1Els.pane.remove(); pane1Els = null }
    state.activePane = 0
    syncActiveTabId()
    els.splitBtn.classList.remove('on')
    els.splitBtn.title = '分屏（▥）'
    renderAllPanes()
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

// 轻量通知（插件 showNotice 等）：右下角自动消失，不打断操作
let noticeTimer = null
function showNotice(msg) {
    let el = document.getElementById('appNotice')
    if (!el) {
        el = document.createElement('div')
        el.id = 'appNotice'
        el.className = 'appNotice'
        document.body.appendChild(el)
    }
    el.textContent = String(msg)
    el.classList.add('show')
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => el.classList.remove('show'), 2600)
}

// ================================================================
// 插件系统（#14）：注入 PluginManager 的 API 实现 + 命令面板/设置联动
// ================================================================

// 插件文件权限边界：只允许读写当前工作区（及其子目录）内的路径。
// 工作区 .emerald/plugins 可能来自克隆的仓库，限制后恶意插件无法读走用户任意文件或覆盖应用自身。
function assertPluginPathAllowed(p) {
    const root = state.rootPath
    if (!root) throw new Error('没有打开工作区')
    const abs = String(p || '')
    if (!(abs === root || abs.startsWith(root + '\\') || abs.startsWith(root + '/'))) {
        throw new Error('插件只能访问工作区内的文件')
    }
}

PluginManager.api = {
    showNotice: (msg) => showNotice(msg),
    getCurrentFile: () => {
        const f = state.currentFile
        if (!f || !f.path) return null
        return { path: f.path, name: f.name, content: f.content }
    },
    getWorkspace: () => ({ path: state.rootPath }),
    openFile: async (p) => {
        if (!p) throw new Error('openFile: 路径为空')
        assertPluginPathAllowed(p)
        await openFileByPath(String(p))
    },
    readFile: async (p) => {
        assertPluginPathAllowed(p)
        const r = await window.electronAPI.readFile(String(p))
        if (!r.ok) throw new Error(r.error || '读取失败')
        return r.content
    },
    writeFile: async (p, c) => {
        assertPluginPathAllowed(p)
        const r = await window.electronAPI.writeFile(String(p), String(c))
        if (!r.ok) throw new Error(r.error || '写入失败')
    },
    readDir: async (p) => {
        assertPluginPathAllowed(p)
        const r = await window.electronAPI.readDir(String(p))
        if (!r.ok) throw new Error(r.error || '读取目录失败')
        return r.items
    },
    // 在活动编辑器光标处插入文本（插件商店：emoji / 日期等）
    insertAtCursor: (text) => {
        if (!state.currentFile) throw new Error('没有打开的文件')
        pluginInsertText(String(text))
    },
    log: (...args) => console.log('[plugin]', ...args),
}

// —— 插件插入（#14 商店）：在活动编辑器当前光标处插入文本，任何模式都可见 ——
// 关键：不依赖陈旧的 ctxSelStart/ctxSelEnd（那只在右键菜单时更新）。
// - 实时模式（liveEditor，Markdown 默认）：DOM 选区 → 源文本偏移（.blk 的 data-s 行号 + 块内偏移）
// - 文本框模式：直接用 textarea.selectionStart/End
// 插入后同步 f.content + 各面板 textarea + 重渲染 liveEditor。

// liveEditor DOM 光标 → 源文本字符偏移
function liveCursorToSourcePos(P, sel, norm) {
    let node = sel.anchorNode
    let blk = null
    while (node && node !== P.liveEditor) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('blk') && node.hasAttribute('data-s')) {
            blk = node
            break
        }
        node = node.parentNode
    }
    if (!blk) return -1
    const s = parseInt(blk.dataset.s, 10) || 0   // data-s = 块起始行号（0-based）
    const lines = norm.split('\n')
    let blockStart = 0
    for (let i = 0; i < s && i < lines.length; i++) blockStart += lines[i].length + 1
    let inner = 0
    try {
        const range = document.createRange()
        range.setStart(blk, 0)
        range.setEnd(sel.anchorNode, sel.anchorOffset)
        inner = range.toString().length
    } catch { inner = 0 }
    return Math.min(blockStart + inner, norm.length)
}

function pluginInsertText(text) {
    const f = state.currentFile
    if (!f || !f.path) { showNotice('请先打开一个文件'); return }
    // 正在行编辑（liveEditor 行编辑器）时先提交，避免插入丢失
    if (liveEdit) commitLineEdit()
    const P = curPaneEls()
    const norm = f.content.replace(/\r\n/g, '\n')
    const isLive = P.liveEditor && !P.liveEditor.classList.contains('hidden')
    let pos = norm.length   // 兜底：插到末尾
    if (isLive) {
        if (lastCaretPos >= 0 && lastCaretPos <= norm.length) {
            pos = lastCaretPos   // 最近真实光标优先（块编辑/点击时记录；blur 后的假 selection 不可信）
        } else {
            const sel = window.getSelection()
            if (sel && sel.anchorNode && P.liveEditor.contains(sel.anchorNode)) {
                const mapped = liveCursorToSourcePos(P, sel, norm)
                if (mapped >= 0) pos = mapped
            }
        }
    } else if (P.editor && !P.editor.classList.contains('hidden')) {
        pos = Math.min(P.editor.selectionStart, norm.length)
        lastCaretPos = pos
    }
    const ins = String(text)
    f.content = norm.slice(0, pos) + ins + norm.slice(pos)
    // 同步所有面板里打开同一文件的 textarea（保持数据一致）
    for (let i = 0; i < state.panes.length; i++) {
        const pEls = paneEls(i)
        const pane = state.panes[i]
        const tab = state.tabs.find((t) => t.id === pane.tabId)
        if (tab && pEls.editor && pEls.editor.value !== undefined) pEls.editor.value = f.content
    }
    updateSaveStatus(state.activePane)
    renderTabs()
    if (isLive) {
        renderLiveEditor(state.activePane)
        // 尽量把光标滚到插入位置附近（找到插入文本所在块）
        const posLine = f.content.slice(0, pos + ins.length).split('\n').length
        const newBlk = P.liveEditor.querySelector('.blk[data-s="' + (posLine - 1) + '"]')
        if (newBlk) newBlk.scrollIntoView({ block: 'nearest' })
    }
    if (state.activePane === state.panes.findIndex((p) => p.tabId === f.id)) renderOutline()
    showNotice('已插入')
}

// 插件命令列表变化 → 刷新命令面板过滤结果 + 设置面板插件信息
PluginManager._onChange = () => {
    renderCommands(els.cpInput ? els.cpInput.value : '')
    updatePluginInfo()
}

function updatePluginInfo() {
    if (!els.setPluginInfo) return
    const cmds = PluginManager.commands()
    const names = PluginManager._iframes.map((f) => f.name).join('、')
    els.setPluginInfo.textContent = names
        ? '已加载：' + names + '（' + cmds.length + ' 个命令）'
        : '未加载插件（用户目录 plugins/ 或工作区 .emerald/plugins/ 下放 .js 脚本）'
}

// 插件加载入口：进入/刷新工作区时调用
async function loadPluginsForWorkspace() {
    await PluginManager.load(state.rootPath || null)
}

// 全局重载（插件商店安装/卸载后调用）
window.reloadPlugins = () => {
    PluginManager.load(state.rootPath || null)
}

// 编辑器头部 🧩 按钮：弹出插件命令菜单（作用于活动面板）
function showPluginMenu(x, y) {
    const items = PluginManager.commands().map((c) => ({ label: c.label, action: () => PluginManager.runCommand(c) }))
    if (!items.length) { showNotice('未加载插件命令（设置 → 插件商店 安装）'); return }
    showContextMenu(x, y, items)
}

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
    pluginBtn: $('pluginBtn'),
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
    gitBtn: $('gitBtn'),
    gitPanel: $('gitPanel'),
    gitBranch: $('gitBranch'),
    gitCount: $('gitCount'),
    gitFiles: $('gitFiles'),
    gitDiff: $('gitDiff'),
    gitMsgInput: $('gitMsgInput'),
    gitCommitBtn: $('gitCommitBtn'),
    gitRefreshBtn: $('gitRefreshBtn'),
    gitCloseBtn: $('gitCloseBtn'),
    gitRemoteInfo: $('gitRemoteInfo'),
    gitLinkRemoteBtn: $('gitLinkRemoteBtn'),
    gitPushBtn: $('gitPushBtn'),
    gitPullBtn: $('gitPullBtn'),
    findBar: $('findBar'),
    findInput: $('findInput'),
    findCount: $('findCount'),
    findPrev: $('findPrev'),
    findNext: $('findNext'),
    findCase: $('findCase'),
    replaceInput: $('replaceInput'),
    replaceOne: $('replaceOne'),
    replaceAll: $('replaceAll'),
    findClose: $('findClose'),
    batchBar: $('batchBar'),
    batchCount: $('batchCount'),
    batchRenameBtn: $('batchRenameBtn'),
    batchDoneBtn: $('batchDoneBtn'),
    batchDialogOverlay: $('batchDialogOverlay'),
    brSeqPanel: $('brSeqPanel'),
    brRePanel: $('brRePanel'),
    brTemplate: $('brTemplate'),
    brStart: $('brStart'),
    brDigits: $('brDigits'),
    brFind: $('brFind'),
    brReplace: $('brReplace'),
    brPreview: $('brPreview'),
    brErr: $('brErr'),
    brCancel: $('brCancel'),
    brOk: $('brOk'),
    splitContainer: $('splitContainer'),
    splitBtn: $('splitBtn'),
    aiBtn: $('aiBtn'),
    aiPanel: $('aiPanel'),
    aiCtxStatus: $('aiCtxStatus'),
    aiMessages: $('aiMessages'),
    aiInput: $('aiInput'),
    aiSendBtn: $('aiSendBtn'),
    aiAbortBtn: $('aiAbortBtn'),
    aiCtxBtn: $('aiCtxBtn'),
    aiSettingsBtn: $('aiSettingsBtn'),
    aiCloseBtn: $('aiCloseBtn'),
    aiSettingsOverlay: $('aiSettingsOverlay'),
    aiProvider: $('aiProvider'),
    aiBaseUrl: $('aiBaseUrl'),
    aiModel: $('aiModel'),
    aiModelList: $('aiModelList'),
    aiKey: $('aiKey'),
    aiKeyToggle: $('aiKeyToggle'),
    aiProviderHint: $('aiProviderHint'),
    aiCfgErr: $('aiCfgErr'),
    aiCfgCancel: $('aiCfgCancel'),
    aiCfgOk: $('aiCfgOk'),
    aiModelBtn: $('aiModelBtn'),
    aiModelLabel: $('aiModelLabel'),
    aiModelMenu: $('aiModelMenu'),
    aiModeBtn: $('aiModeBtn'),
    aiModeLabel: $('aiModeLabel'),
    aiModeMenu: $('aiModeMenu'),
    aiModelChips: $('aiModelChips'),
    aiSessionNew: $('aiSessionNew'),
    aiSessionList: $('aiSessionList'),
    dropOverlay: $('dropOverlay'),
    splitDropHint: $('splitDropHint'),
    helpBtn: $('helpBtn'),
    helpOverlay: $('helpOverlay'),
    helpClose: $('helpClose'),
    launchHelpBtn: $('launchHelpBtn'),
    linkPicker: $('linkPicker'),
    lkInput: $('lkInput'),
    lkResults: $('lkResults'),
    graphBtn: $('graphBtn'),
    graphPanel: $('graphPanel'),
    graphStats: $('graphStats'),
    graphRefreshBtn: $('graphRefreshBtn'),
    graphCloseBtn: $('graphCloseBtn'),
    graphCanvas: $('graphCanvas'),
    graphHint: $('graphHint'),
    graphEmpty: $('graphEmpty'),
    graphLoading: $('graphLoading'),
    sidebarResizer: $('sidebarResizer'),
    outlineSection: $('outlineSection'),
    settingsBtn: $('settingsBtn'),
    settingsOverlay: $('settingsOverlay'),
    setThemeMode: $('setThemeMode'),
    setSortMode: $('setSortMode'),
    setClearRecentFolders: $('setClearRecentFolders'),
    setClearRecentFiles: $('setClearRecentFiles'),
    setClearFavorites: $('setClearFavorites'),
    setClearTags: $('setClearTags'),
    setExportWorkspace: $('setExportWorkspace'),
    setPluginInfo: $('setPluginInfo'),
    setReloadPlugins: $('setReloadPlugins'),
    setOpenStore: $('setOpenStore'),
    setOk: $('setOk'),
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

// 把 file:// URL 转成本地路径（容错：支持 file:///C:/x、file://C:/x、file://localhost/C:/x 形态；
// 解码失败（URL 含未编码 % 等）返回 null，由调用方跳过该条，不影响其余处理）
function fileUrlToPath(url) {
    const s = String(url || '')
    let p = null
    // 形态1：Windows 盘符（file:///C:/x / file://C:/x / file://localhost/C:/x）
    let m = /^file:\/\/(?:localhost\/)?\/?([A-Za-z]:[\\/])(.*)$/.exec(s)
    if (m) p = m[1] + m[2]
    else {
        // 形态2：Unix 绝对路径（file:///home/x）
        m = /^file:\/\/(?:localhost\/)?(\/.*)$/.exec(s)
        if (m) p = m[1]
    }
    if (p === null) return null
    try {
        return decodeURIComponent(p).split('/').join('\\')
    } catch {
        return null
    }
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
            row.addEventListener('click', () => {
                if (state.batchMode) { toggleBatchSelect(item, row); return }   // 批量模式：选择
                toggleFolder(node, item, children, caret)
            })
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
            row.draggable = true   // FIX2：文件行可拖拽（拖到渲染区分屏）
            row.addEventListener('dragstart', (e) => {
                if (state.batchMode) { e.preventDefault(); return }
                e.dataTransfer.setData('application/x-emerald-path', item.path)
                e.dataTransfer.effectAllowed = 'copy'
            })
            row.addEventListener('click', () => {
                if (state.batchMode) { toggleBatchSelect(item, row); return }   // 批量模式：选择
                selectFile(item, row)
            })
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
        // Git 状态徽章（#10）：M 修改 / A 新增 / U 未跟踪 / D 删除 / R 重命名
        const gBadge = state.gitStatus[item.path]
        if (gBadge) {
            const g = document.createElement('span')
            g.className = 'git-badge b-' + gBadge
            g.textContent = gBadge
            g.title = 'Git 状态：' + gBadge
            row.appendChild(g)
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

// 切换到指定标签（显示在活动面板）
function activateTab(id) {
    if (!state.tabs.some((t) => t.id === id)) return
    state.panes[state.activePane].tabId = id
    state.activeTabId = id
    renderTabs()
    renderActiveFile()
    const t = state.tabs.find((x) => x.id === id)
    if (t && t.path) recordHistory(t.path)   // 空白标签不进历史
}

// 渲染所有面板（#11 分屏）；若没有任何面板打开文件 → 全局空状态/速查卡
function renderActiveFile() {
    const hasContent = state.panes.some((p) => {
        const t = state.tabs.find((x) => x.id === p.tabId)
        return t && t.path
    })
    if (!hasContent) {
        if (state.tabs.length > 0) showBlankTabHint()   // 只有空白标签 → 快捷键速查卡
        else showEmpty('从左侧目录树选择一个文件', '文本文件可编辑，保存后写回磁盘')
        return
    }
    renderAllPanes()
}

function renderAllPanes() {
    closeBacklinks()
    hideAllStates()
    els.editorPane.classList.remove('hidden')
    for (let i = 0; i < state.panes.length; i++) renderPane(i)
    syncActiveTabId()
    renderOutline()   // G：大纲随活动文件刷新
    const f = state.currentFile
    if (f && f.path) {
        loadFileMeta(f.path)
        syncTreeSelection(f.path)
    }
    updateStatusBar()
}

// 渲染单个面板：显示其标签对应的文件（空白 → 面板内空提示）
function renderPane(i) {
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) {
        P.editor.classList.add('hidden')
        P.liveEditor.classList.add('hidden')
        P.previewPane.classList.add('hidden')
        P.empty.classList.remove('hidden')
        P.title.textContent = ''
        P.typeBadge.textContent = ''
        P.typeBadge.className = 'fileTypeBadge'
        P.viewModeBtn.style.display = 'none'
        P.backlinksBtn.style.display = 'none'
        P.saveStatus.textContent = ''
        return
    }
    P.empty.classList.add('hidden')
    P.title.textContent = f.name
    P.editor.value = f.content
    pane.viewMode = pane.viewMode || 'edit'
    updateFileTypeBadge(i)
    updateSaveStatus(i)
    updateViewModeBtn(i)
    if (pane.viewMode === 'preview') showPanePreview(i)
    else showPaneEditorInput(i)
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
    // 关闭的标签若被某个面板显示，让该面板退回相邻标签 / 空白
    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i].tabId === tab.id) {
            const next = state.tabs[idx] || state.tabs[idx - 1] || null
            state.panes[i].tabId = next ? next.id : null
        }
    }
    syncActiveTabId()
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

// 按路径打开文本文件（分屏语义）：
//   文件已在某标签 → 切到所在面板显示（避免同一文件占多个标签）
//   否则 → 在"当前活动面板"里打开，替换该面板的旧内容（标签数量不增加）
async function openFileByPath(path, rowEl) {
    const existing = state.tabs.find((t) => t.path === path)
    if (existing) {
        // 切到包含该文件的标签所在面板
        const pi = state.panes.findIndex((p) => p.tabId === existing.id)
        if (pi !== -1) setActivePane(pi)
        activateTab(existing.id)
        return
    }
    // 替换活动面板的标签前，若它有不保存的修改先确认，防止丢数据
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
    // 活动面板当前标签（可能是 null = 空白面板）
    const activeTabId = state.panes[state.activePane].tabId
    let target = activeTabId ? state.tabs.find((t) => t.id === activeTabId) : null
    if (!target) {
        // 空白面板（无标签）：新建一个标签装这个文件
        state.tabs.push({ id: path, path, name: basename(path), content: res.content, originalContent: res.content })
        state.panes[state.activePane].tabId = path
    } else {
        // 替换活动面板标签的内容（空白标签 = 填充；有文件 = 替换）
        Object.assign(target, {
            id: path,
            path,
            name: basename(path),
            content: res.content,
            originalContent: res.content,
        })
        state.panes[state.activePane].tabId = target.id
    }
    syncActiveTabId()
    renderTabs()
    renderActiveFile()
    recordHistory(path)
    recordRecentFile(path)
}

// 会话恢复专用：总是新建标签并挂到活动面板（避免恢复时互相覆盖）
async function openFileInNewTab(path) {
    const existing = state.tabs.find((t) => t.path === path)
    if (existing) { activateTab(existing.id); return }
    const res = await window.electronAPI.readFile(path)
    if (!res.ok) return
    state.tabs.push({ id: path, path, name: basename(path), content: res.content, originalContent: res.content })
    state.panes[state.activePane].tabId = path
    syncActiveTabId()
    renderTabs()
    renderActiveFile()
}

// 新建一个空白标签（导航栏最右侧"＋"按钮）→ 挂到活动面板
let blankSeq = 0
function addBlankTab() {
    state.tabs.push({ id: 'blank-' + (++blankSeq), path: null, name: '空白', content: '', originalContent: '' })
    state.panes[state.activePane].tabId = state.tabs[state.tabs.length - 1].id
    syncActiveTabId()
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

// F2：按文件类型给面板头部徽章着色（.md 琥珀 / 代码蓝 / 图片紫 / 其他灰）
function updateFileTypeBadge(paneIndex) {
    const i = paneIndex == null ? state.activePane : paneIndex
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f || !P.typeBadge) { P.typeBadge.textContent = ''; P.typeBadge.className = 'fileTypeBadge'; return }
    const ext = getExt(f.name)
    let cls = 'fileTypeBadge'
    if (isMarkdown(f.name)) cls += ' type-md'
    else if (CODE_EXTS.has(ext)) cls += ' type-code'
    else if (IMAGE_EXTS.has(ext)) cls += ' type-img'
    P.typeBadge.textContent = ext ? '.' + ext : 'TXT'
    P.typeBadge.className = cls
}

// 按面板渲染所见即所得编辑器
function renderLiveEditor(paneIndex) {
    // 任何重渲染前先提交未完成的行编辑（切换面板 / 切换文件 / 切视图时避免内容丢失）。
    // commitLineEdit 内部会置 liveEdit=null 再调本函数 → 不会递归。
    if (liveEdit) commitLineEdit()
    const i = paneIndex == null ? state.activePane : paneIndex
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f || !isMarkdown(f.name)) return
    P.liveEditor.innerHTML = previewHtmlFor(f.path, f.content)
    highlightPreviewBlocks()
    liveEdit = null   // 重渲染后行编辑器失效
}

// 实时编辑器点击委托（面板 0 静态绑定 + 面板 1 动态绑定共用）：
// 任务勾选 > wikilink > 普通链接 > 点击块进入编辑
// —— mousedown：行编辑入口（一次点击直达）——
// 用 mousedown 而非 click：点击另一行时，旧行 blur 会同步重渲染，导致
// mouseup/click 的目标 DOM 已失效、click 不派发（于是要点两次）。
// mousedown 先于 blur，手动提交后立即用坐标重新定位新行，一次完成。
function handleLiveEditorMouseDown(e) {
    const t = e.target
    if (!t || !t.closest) return
    if (t.closest('.line-inline')) return                              // 行编辑器内部（移动光标）
    if (t.closest('input[type=checkbox], a[href]')) return             // 勾选框/普通链接交回 click
    // wikilink：普通点击 = 进入行编辑（可编辑 [[...]] 源码）；Ctrl/Cmd+点击 = 跳转（交回 click）
    if (t.closest('.wikilink') && (e.ctrlKey || e.metaKey)) return
    if (liveEdit) commitLineEdit()                                     // 先提交当前行（同步重渲染）
    const hit = document.elementFromPoint(e.clientX, e.clientY) || t   // 重渲染后用坐标重新定位
    const blk = hit.closest('.blk[data-s]')
    if (blk) {
        e.preventDefault()   // 阻止默认 blur 干扰（已手动提交）
        openLineEditor(e, blk)
        return
    }
    // 点击文档末尾空白处（最后一个块下方）→ 追加空行编辑器（Obsidian 习惯：点哪儿写哪儿）
    const paneHit = hit.closest ? hit.closest('.pane') : null
    const paneIdx = paneHit ? Number(paneHit.dataset.pane) : state.activePane
    const pane = paneEls(paneIdx)
    const lastBlk = [...pane.liveEditor.querySelectorAll('.blk[data-s]')].pop()
    if (lastBlk) {
        const lb = lastBlk.getBoundingClientRect()
        if (e.clientY > lb.bottom + 4) {
            e.preventDefault()
            appendTailLineEditor(parseInt(lastBlk.dataset.e, 10) + 1, paneIdx)
        }
    }
}
els.liveEditor.addEventListener('mousedown', handleLiveEditorMouseDown)

function handleLiveEditorClick(e) {
    // 交互元素优先处理（先提交未完成的行编辑）；行编辑已由 mousedown 处理
    const cb = e.target.closest('input[type=checkbox][data-line]')
    if (cb) { if (liveEdit) commitLineEdit(); toggleTaskLine(cb); return }
    // wikilink：Ctrl/Cmd+点击才跳转；普通点击已由 mousedown 进入行编辑（[[...]] 可直接编辑）
    const wl = e.target.closest('.wikilink')
    if (wl) {
        if (e.ctrlKey || e.metaKey) {
            if (liveEdit) commitLineEdit()
            e.preventDefault()
            openWikilink(wl.getAttribute('data-target'))
        }
        return
    }
    const link = e.target.closest('a[href]')
    if (link) {
        if (liveEdit) commitLineEdit()
        e.preventDefault()
        const href = link.getAttribute('href')
        if (/^(https?:|mailto:)/i.test(href)) { window.electronAPI.openExternal(href); return }
        let target = null
        if (/^file:/i.test(href)) target = fileUrlToPath(href)
        else if (!/^[a-zA-Z]+:/.test(href)) { const f = state.currentFile; if (f) target = joinPath(parentDir(f.path), href) }
        if (target) openLocalPath(target)
        return
    }
}
// ================================================================
// Obsidian 风格"行渲染"编辑器：点击行 → 整行容器（li / 标题 / 段落）内容就地
// 替换为原生 Markdown 行编辑器（无边框无弹窗），其余行保持渲染。
// 行号由"行容器序号"映射（li[0]→块起始行，li[1]→下一行…），不依赖渲染文本换行数，
// 多行列表 / 行内 strong/em 也不会错位；Enter / 失焦提交，Esc 取消，↑↓ 移动。
// 复杂块（表格 / 代码块 / 多行段落）整块编辑。
// ================================================================
let liveEdit = null   // { mode:'line'|'block', paneIdx, blk, lineNo, s, e, ta, cancel }

// —— 行编辑撤销栈（Ctrl+Z）：记录提交 / 移动前的行内容 ——
let editUndoStack = []   // [{ path, content }]：每次编辑前的完整内容快照
const EDIT_UNDO_MAX = 60

// 快照式撤销：捕获修改前的全文内容。行号漂移（插入/删除行）天然免疫。
function pushEditUndo(path) {
    const tab = state.tabs.find((t) => t.path === path) || state.tabs.find((t) => t.id === path)
    if (!tab || typeof tab.content !== 'string') return
    const last = editUndoStack[editUndoStack.length - 1]
    if (last && last.path === (tab.path || path) && last.content === tab.content) return   // 去重：无操作不入栈
    editUndoStack.push({ path: tab.path || path, content: tab.content })
    if (editUndoStack.length > EDIT_UNDO_MAX) editUndoStack.shift()
}

// Ctrl+Z：恢复上一次编辑前的完整内容快照
function undoLineEdit() {
    const item = editUndoStack.pop()
    if (!item) return
    const tab = state.tabs.find((t) => t.path === item.path) || state.tabs.find((t) => t.id === item.path)
    if (!tab) return
    if (liveEdit) commitLineEdit()
    tab.content = item.content
    // 同步所有打开该文件的文本框
    for (let i = 0; i < state.panes.length; i++) {
        const pEls = paneEls(i)
        if (state.panes[i].tabId === tab.id && pEls.editor) pEls.editor.value = tab.content
    }
    const pi = state.panes.findIndex((p) => p.tabId === tab.id)
    if (pi < 0) { renderTabs(); return }
    updateSaveStatus(pi)
    renderTabs()
    if (state.activePane === pi) renderOutline()
    const P = paneEls(pi)
    const st = P.liveEditor.scrollTop
    renderLiveEditor(pi)
    P.liveEditor.scrollTop = st
}

// 向上找"行容器"元素（不越过 blk）：li / 标题 / 段落 / 引用 / 软换行行片段（span.md-line）
function rowElementOf(node, blk) {
    let el = node && node.nodeType === 3 ? node.parentNode : node
    while (el && el !== blk) {
        if (!el.tagName) { el = el.parentNode; continue }
        const tag = el.tagName.toUpperCase()
        if (tag === 'LI' || /^H[1-6]$/.test(tag) || tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'HR') return el
        if (tag === 'SPAN' && el.classList && el.classList.contains('md-line')) return el
        el = el.parentNode
    }
    return null
}

// 块内行容器列表（行号映射基准）；软换行段落用 span.md-line 表示各源行，
// 此时排除包裹它们的 <p>，避免同一段落被计数两次
function rowElementsOf(blk) {
    return [...blk.querySelectorAll('li, h1, h2, h3, h4, h5, h6, p, blockquote, hr, span.md-line')]
        .filter((el) => !(el.tagName === 'P' && el.querySelector('span.md-line')))
}

// 行容器 → 源行号：软换行行片段直接读 data-line；其余 = 块起始行 + 容器序号
function rowElToLineNo(blk, rowEl) {
    if (rowEl && rowEl.dataset && rowEl.dataset.line != null) return parseInt(rowEl.dataset.line, 10)
    const idx = rowElementsOf(blk).indexOf(rowEl)
    if (idx < 0) return -1
    return parseInt(blk.dataset.s, 10) + idx
}

// 点击渲染内容 → 打开行（或整块）的原生 Markdown 编辑器
function openLineEditor(e, blk) {
    if (liveEdit) commitLineEdit()
    const paneIdx = blk.closest('.pane') ? Number(blk.closest('.pane').dataset.pane) : state.activePane
    const tab = state.tabs.find((t) => t.id === state.panes[paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const s = parseInt(blk.dataset.s, 10)
    const eEnd = parseInt(blk.dataset.e, 10)
    if (isNaN(s) || isNaN(eEnd) || s < 0 || eEnd < s) return
    // 整块编辑：表格 / 代码块 / 多行引用；软换行段落（span.md-line）与列表走行模式逐行编辑
    const hasTablePre = blk.querySelector('table, pre')
    const hasList = blk.querySelector('ul, ol')
    const hasMdLine = blk.querySelector('span.md-line')
    if (hasTablePre) {
        // 表格：把光标放到被点击的单元格处（不再是表尾）
        const caretOff = blk.querySelector('table') ? tableClickCaret(e, blk, s, eEnd) : -1
        openBlockInlineEditor(blk, s, eEnd, caretOff)
        return
    }
    if (eEnd > s && !hasList && !hasMdLine) { openBlockInlineEditor(blk, s, eEnd); return }
    // 行容器定位：用坐标重新命中（重渲染后旧 e.target 已 detached；合成/真实点击坐标始终有效）
    const node = document.elementFromPoint(e.clientX, e.clientY) || e.target
    const rowEl = rowElementOf(node, blk)
    if (!rowEl) return
    const lineNo = rowElToLineNo(blk, rowEl)
    const lines = f.content.split('\n')
    // 光标位置：点击坐标 → 渲染偏移 → 源偏移（逐字符贪心映射，跳过行首/行内标记字符）
    let caret = -1
    try {
        const cp = document.caretPositionFromPoint(e.clientX, e.clientY)
        if (cp && cp.offsetNode) {
            const rowEl2 = rowElementOf(cp.offsetNode, blk)
            if (rowEl2) {
                const r = document.createRange()
                r.setStart(rowEl2, 0)
                r.setEnd(cp.offsetNode, cp.offset)
                const renderOff = r.toString().length
                const srcLine = lines[lineNo] || ''
                caret = renderOffsetToSrc((rowEl2.textContent || ''), srcLine, renderOff)
            }
        }
    } catch { caret = -1 }
    openRowEditor(blk, rowEl, lineNo, caret)
}

// 渲染文本偏移 → 源行偏移：跳过源行中的标记字符（- / # / ** / * / ` 等）
// 贪心匹配：渲染文本逐字符在源行中找对应（源中不匹配的字符视为标记直接跳过）
function renderOffsetToSrc(renderText, srcLine, renderOff) {
    if (!srcLine) return 0
    let s = 0
    const rl = String(renderText || '')
    for (let i = 0; i < renderOff; i++) {
        const ch = rl[i]
        if (ch === undefined) break
        // 在源行中从当前位置找匹配字符（跳过标记字符）
        while (s < srcLine.length && srcLine[s] !== ch) s++
        if (s < srcLine.length) s++
    }
    return Math.min(s, srcLine.length)
}

// ================================================================
// 富文本行编辑（Obsidian 式）：行内加粗 / 删除线 / 斜体 / 高亮在编辑态保持渲染，
// 修饰符不直接显示；点击对应文本才暴露修饰符（便于修改）。其余（链接、代码、
// wikilink 等）仍以原始 Markdown 文本显示，可直接编辑。
// 实现：用 contenteditable div 取代 textarea，并为其模拟 textarea 的
// value / selectionStart / selectionEnd / setSelectionRange 接口，
// 让既有的行编辑管线（commit/move/enter/liveSurround…）无需改动。
// ================================================================

// 源行 → 富文本 HTML（只处理四种行内样式；输入已转义）
function lineToRichHtml(srcLine) {
    let s = escapeHtml(String(srcLine == null ? '' : srcLine))
    s = s.replace(/==([^=\n]+)==/g, '<mark data-mk="==">$1</mark>')
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong data-mk="**">$1</strong>')
    s = s.replace(/~~([^~\n]+)~~/g, '<del data-mk="~~">$1</del>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em data-mk="*">$2</em>')
    return s
}

// 序列化：DOM → Markdown 行（给带 data-mk 的样式元素补回修饰符）
function richLineValue(el) {
    let out = ''
    const walk = (node) => {
        if (node.nodeType === 3) { out += node.data; return }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toLowerCase()
        if (tag === 'br') return   // 行模式不产生换行
        const mk = node.getAttribute ? node.getAttribute('data-mk') : null
        if (mk) out += mk
        for (const ch of node.childNodes) walk(ch)
        if (mk) out += mk
    }
    for (const ch of el.childNodes) walk(ch)
    return out
}

// 渲染偏移（DOM 光标）→ 源偏移（含隐藏修饰符）
function richCaretToSrc(el, renderOff) {
    let src = 0
    let seen = 0
    let found = -1
    const walk = (node) => {
        if (found >= 0) return
        if (node.nodeType === 3) {
            const len = node.data.length
            if (renderOff >= seen && renderOff <= seen + len) { found = src + (renderOff - seen); return }
            seen += len
            src += len
            return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toLowerCase()
        if (tag === 'br') {
            if (renderOff === seen) { found = src; return }
            seen += 1
            src += 1
            return
        }
        const mk = node.getAttribute ? node.getAttribute('data-mk') : null
        if (mk) src += mk.length
        for (const ch of node.childNodes) walk(ch)
        if (found >= 0) return
        if (mk) src += mk.length
    }
    walk(el)
    return found >= 0 ? found : src
}

// 源偏移 → DOM 光标位置
function richSrcToPoint(el, srcOffset) {
    let src = 0
    const walk = (node) => {
        if (node.nodeType === 3) {
            const len = node.data.length
            if (srcOffset <= src + len) return { node, off: Math.max(0, srcOffset - src) }
            src += len
            return null
        }
        if (node.nodeType !== 1) return null
        const tag = node.tagName.toLowerCase()
        if (tag === 'br') {
            if (srcOffset === src) return { node, off: 0 }
            src += 1
            return null
        }
        const mk = node.getAttribute ? node.getAttribute('data-mk') : null
        if (mk) src += mk.length
        for (const ch of node.childNodes) {
            const r = walk(ch)
            if (r) return r
        }
        if (mk) src += mk.length
        return null
    }
    const r = walk(el)
    if (r) return r
    // 越界：定位到最后一个文本节点末尾
    const lastText = (() => {
        let out = null
        const w = (n) => {
            if (n.nodeType === 3) out = n
            else if (n.nodeType === 1) for (const ch of n.childNodes) w(ch)
        }
        w(el)
        return out
    })()
    if (lastText) return { node: lastText, off: lastText.data.length }
    return { node: el, off: 0 }
}

// 创建富文本行编辑器（模拟 textarea 接口）
function createRichLineEditor(srcLine) {
    const el = document.createElement('div')
    el.className = 'line-inline line-ce'
    el.contentEditable = 'true'
    el.spellcheck = false
    el.innerHTML = lineToRichHtml(srcLine) || '<br>'

    Object.defineProperty(el, 'value', {
        get: () => richLineValue(el),
        set: (v) => { el.innerHTML = lineToRichHtml(v) || '<br>' },
        enumerable: true,
        configurable: true,
    })

    const caretOffset = (useEnd) => {
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return richLineValue(el).length
        const range = sel.getRangeAt(0)
        if (!el.contains(range.startContainer)) return 0
        const pre = document.createRange()
        pre.selectNodeContents(el)
        pre.setEnd(useEnd ? range.endContainer : range.startContainer, useEnd ? range.endOffset : range.startOffset)
        return richCaretToSrc(el, pre.toString().length)
    }
    Object.defineProperty(el, 'selectionStart', { get: () => caretOffset(false), enumerable: true, configurable: true })
    Object.defineProperty(el, 'selectionEnd', { get: () => caretOffset(true), enumerable: true, configurable: true })

    el.setSelectionRange = (start, end) => {
        const pt = richSrcToPoint(el, end == null ? start : end)
        try {
            if (pt && pt.node.isConnected) {
                const r = document.createRange()
                r.setStart(pt.node, pt.off)
                r.setEnd(pt.node, pt.off)
                const sel = window.getSelection()
                sel.removeAllRanges()
                sel.addRange(r)
            }
        } catch { /* 定位失败时保持现状 */ }
        el.focus()
    }

    // 点击样式化文本 → 暴露修饰符（**text** / ~~text~~ / *text* / ==text==）。
    // 光标落在"实际点击的字符位置"（而不是固定在文本开头），展开后无需再点一次。
    // 修饰符是"收放式"的：光标离开该文本（点其它位置 / 方向键移出 / 展开另一处）→ 自动收拢回渲染态。
    const revealed = new Set()   // 当前被展开为原始文本的节点（元素被替换后的文本节点）

    const placeCaret = (node, offset) => {
        try {
            if (node.isConnected) {
                const r = document.createRange()
                r.setStart(node, offset)
                r.setEnd(node, offset)
                const sel = window.getSelection()
                sel.removeAllRanges()
                sel.addRange(r)
            }
        } catch { /* noop */ }
        el.focus()
    }
    // 点击位置在样式文本内的渲染偏移（mousedown 已把光标落位；合成事件用坐标兜底）
    const clickRelIn = (node, x, y) => {
        let rel = 0
        try {
            const cp = document.caretPositionFromPoint(x, y)
            if (cp && cp.offsetNode && (cp.offsetNode === node || node.contains(cp.offsetNode))
                && cp.offsetNode.nodeType === 3) {
                rel = cp.offset
            }
        } catch { rel = 0 }
        if (!rel) {
            const sel = window.getSelection()
            if (sel && sel.rangeCount) {
                const range = sel.getRangeAt(0)
                if (node.contains(range.startContainer)) {
                    try {
                        const pre = document.createRange()
                        pre.setStart(node, 0)
                        pre.setEnd(range.startContainer, range.startOffset)
                        rel = pre.toString().length
                    } catch { rel = 0 }
                }
            }
        }
        return rel
    }
    // 把样式元素替换为带修饰符的原始文本；rel = 点击处在该文本内的字符偏移
    const revealNode = (node, rel) => {
        const mk = node.getAttribute('data-mk')
        const text = node.textContent
        const raw = document.createTextNode(mk + text + mk)
        node.parentNode.replaceChild(raw, node)
        revealed.add(raw)
        const r = Math.max(0, Math.min(text.length, rel || 0))
        placeCaret(raw, mk.length + r)
        updateLineStatus()
    }
    el.addEventListener('click', (e) => {
        const t = e.target
        if (!t || t.nodeType !== 1) return
        const mk = t.getAttribute && t.getAttribute('data-mk')
        if (mk && /^(STRONG|DEL|EM|MARK)$/.test(t.tagName)) {
            e.preventDefault()
            e.stopPropagation()
            const rel = clickRelIn(t, e.clientX, e.clientY)
            if (revealed.size) {
                // 收拢其它已展开项：把它们的原始文本节点局部还原为渲染态
                // （不整体重渲染，避免行宽变化导致点击元素失效）
                for (const node of [...revealed]) {
                    if (!node.parentNode) { revealed.delete(node); continue }
                    const holder = document.createElement('span')
                    holder.innerHTML = lineToRichHtml(node.data)
                    node.parentNode.replaceChild(holder, node)
                    while (holder.firstChild) holder.parentNode.insertBefore(holder.firstChild, holder)
                    holder.remove()
                    revealed.delete(node)
                }
            }
            revealNode(t, rel)
        }
    })

    // 光标离开已展开文本 → 收拢：序列化当前值 → 重新富文本渲染 → 按源偏移恢复光标
    el._maybeCollapse = () => {
        if (!revealed.size) return
        const sel = window.getSelection()
        let inside = false
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0)
            for (const node of revealed) {
                if (!node.parentNode) { revealed.delete(node); continue }
                const inStart = range.startContainer === node && range.startOffset >= 0 && range.startOffset <= node.data.length
                const inEnd = range.endContainer === node && range.endOffset >= 0 && range.endOffset <= node.data.length
                if (inStart || inEnd) { inside = true; break }
            }
        }
        if (inside) return
        const caret = el.selectionStart            // 收拢前光标源偏移
        el.value = richLineValue(el)               // 重渲染：修饰符隐藏、恢复渲染态
        revealed.clear()
        el.setSelectionRange(caret, caret)
    }
    el.addEventListener('keyup', () => el._maybeCollapse())
    el.addEventListener('input', () => { updateLineStatus(); el._maybeCollapse() })

    // 粘贴只插纯文本（不引入富文本/换行）
    el.addEventListener('paste', (e) => {
        e.preventDefault()
        const text = (e.clipboardData || window.clipboardData).getData('text/plain')
        if (!text) return
        document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '))
    })

    richEditorActive = el
    return el
}

// 当前富文本行编辑器（document 级 selectionchange 用它判断光标是否离开已展开修饰符）
let richEditorActive = null
document.addEventListener('selectionchange', () => {
    if (richEditorActive && richEditorActive._maybeCollapse) richEditorActive._maybeCollapse()
})

// 打开指定行编辑（点击 / 回车前进共用）；caret 为行内源偏移（-1 = 行尾）
function openRowEditor(blk, rowEl, lineNo, caret) {
    const paneIdx = blk.closest('.pane') ? Number(blk.closest('.pane').dataset.pane) : state.activePane
    const tab = state.tabs.find((t) => t.id === state.panes[paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f || !rowEl) return
    const lines = f.content.split('\n')
    if (lineNo < 0 || lineNo >= lines.length) return
    const ta = createRichLineEditor(lines[lineNo])
    // 软换行段落（span.md-line 之间由 <br> 分隔）：块级行编辑器会让相邻 <br>
    // 产生多余空行（上方文本与下方链接行之间出现空隙）。编辑期间移除相邻
    // <br> 与空白文本节点，提交/取消时整块重渲染会自动恢复。
    if (rowEl.tagName !== 'HR') {
        const isSeparator = (n) =>
            (n && n.nodeType === 1 && n.tagName === 'BR') ||
            (n && n.nodeType === 3 && /^[\n\r\t ]*$/.test(n.data))
        let sib = rowEl.previousSibling
        while (sib && isSeparator(sib)) { const t = sib; sib = sib.previousSibling; t.remove() }
        sib = rowEl.nextSibling
        while (sib && isSeparator(sib)) { const t = sib; sib = sib.nextSibling; t.remove() }
    }
    // 分割线（hr）是自闭合元素，无子节点可替换 → 直接替换元素本身
    if (rowEl.tagName === 'HR') {
        rowEl.parentNode.replaceChild(ta, rowEl)
    } else {
        // 整行容器内容就地替换为透明行编辑器（零视觉：无边框 / 无阴影 / 字体与预览一致）
        const range = document.createRange()
        range.selectNodeContents(rowEl)
        range.deleteContents()
        range.insertNode(ta)
    }
    liveEdit = { mode: 'line', paneIdx, path: f.path, blk, lineNo, s: parseInt(blk.dataset.s, 10), e: parseInt(blk.dataset.e, 10), ta, cancel: false }
    bindLineEditorEvents(ta)
    // 光标停在点击位置（或行尾）；caret 为源偏移，内部映射到渲染位置
    const pos = (caret != null && caret >= 0) ? Math.min(caret, ta.value.length) : ta.value.length
    ta.setSelectionRange(pos, pos)
    updateLineStatus()
}

// 按行号打开编辑（回车前进 / ↑↓ 移动等程序化场景；paneIdx 缺省 = 活动面板）
// 普通行 → 行编辑器；表格 / 代码 / 多行段落 → 整块编辑器；
// 无块覆盖的行（空分隔行 / 文档末尾）→ 在正确位置插入空行编辑器
function openLineAt(lineNo, paneIdx, caret) {
    const idx = (paneIdx != null && state.panes[paneIdx]) ? paneIdx : state.activePane
    const P = paneEls(idx)
    const blks = [...P.liveEditor.querySelectorAll('.blk[data-s]')]
    const blk = blks.find((b) => parseInt(b.dataset.s, 10) <= lineNo && parseInt(b.dataset.e, 10) >= lineNo)
    if (blk) {
        const s = parseInt(blk.dataset.s, 10)
        const e = parseInt(blk.dataset.e, 10)
        const hasTablePre = blk.querySelector('table, pre')
        const hasList = blk.querySelector('ul, ol')
        const hasMdLine = blk.querySelector('span.md-line')
        // 软换行段落（span.md-line）与列表走行模式逐行编辑；表格 / 代码 / 其它多行块整块编辑
        if (hasTablePre || (e > s && !hasList && !hasMdLine)) { openBlockInlineEditor(blk, s, e); return }
        const rowEl = rowElementsOf(blk)[lineNo - s]
        if (rowEl) { openRowEditor(blk, rowEl, lineNo, caret); return }
        openBlockInlineEditor(blk, s, e)   // 防御：块内无行容器（复杂多行条目）
        return
    }
    // 无块覆盖（空分隔行 / 文档末尾 / 空文档）：在相邻块之间插入行编辑器
    const tab = state.tabs.find((t) => t.id === state.panes[idx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const ta = createRichLineEditor('')
    const nextBlk = blks.find((b) => parseInt(b.dataset.s, 10) > lineNo)
    const bodyEl = P.liveEditor.querySelector('.md-body')
    if (nextBlk) nextBlk.parentNode.insertBefore(ta, nextBlk)
    else if (bodyEl) bodyEl.appendChild(ta)
    else P.liveEditor.appendChild(ta)
    liveEdit = { mode: 'line', paneIdx: idx, path: f.path, blk: null, lineNo, s: lineNo, e: lineNo, ta, cancel: false }
    bindLineEditorEvents(ta)
    if (caret != null && caret > 0) ta.setSelectionRange(caret, caret)
    if (!nextBlk) P.liveEditor.scrollTop = P.liveEditor.scrollHeight
}

// 复杂块整块就地编辑：块内容替换为多行 textarea（值 = 源行区间 markdown）
// caretOff 可选：打开后把光标放到该源偏移（表格点击单元格用）
function openBlockInlineEditor(blk, s, e, caretOff) {
    const paneIdx = blk.closest('.pane') ? Number(blk.closest('.pane').dataset.pane) : state.activePane
    const tab = state.tabs.find((t) => t.id === state.panes[paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const lines = f.content.split('\n')
    const ta = document.createElement('textarea')
    ta.className = 'line-inline block-inline'
    ta.value = lines.slice(s, e + 1).join('\n')
    ta.spellcheck = false
    ta.wrap = 'off'
    blk.innerHTML = ''
    blk.appendChild(ta)
    liveEdit = { mode: 'block', paneIdx, path: f.path, blk, lineNo: s, s, e, ta, cancel: false }
    bindLineEditorEvents(ta)
    if (typeof caretOff === 'number' && caretOff >= 0 && caretOff <= ta.value.length) {
        ta.setSelectionRange(caretOff, caretOff)
    }
    updateLineStatus()
}

// 表格：点击坐标 → 被点击单元格在块内源码（lines.slice(s,e+1).join('\n')) 的偏移
function tableClickCaret(e, blk, s, eEnd) {
    try {
        const f = state.currentFile
        if (!f) return -1
        const lines = f.content.split('\n')
        const src = lines.slice(s, eEnd + 1).join('\n')
        const cp = document.caretPositionFromPoint(e.clientX, e.clientY)
        if (!cp || !cp.offsetNode) return -1
        const node = cp.offsetNode.nodeType === 1 ? cp.offsetNode : cp.offsetNode.parentNode
        const td = node.closest ? node.closest('td, th') : null
        if (!td) return -1
        const table = td.closest('table')
        if (!table) return -1
        const cells = [...table.querySelectorAll('th, td')]
        const idx = cells.indexOf(td)
        if (idx < 0) return -1
        const off = tableCellSrcOffset(src, idx)
        if (off < 0) return -1
        // 单元格内渲染偏移（近似：纯文本单元格通常与源一致；带修饰符时落在附近）
        let inner = 0
        if (cp.offsetNode.nodeType === 3 && td.contains(cp.offsetNode)) {
            try {
                const pre = document.createRange()
                pre.setStart(td, 0)
                pre.setEnd(cp.offsetNode, cp.offset)
                inner = pre.toString().length
            } catch { inner = 0 }
        }
        return off + Math.min(inner, 20)
    } catch { return -1 }
}

// 在表格源码中定位第 cellIdx 个单元格的起始偏移（镜像 splitCells 规则：去首尾 | 后按 | 拆分）
function tableCellSrcOffset(src, cellIdx) {
    let off = 0
    let count = 0
    const srcLines = src.split('\n')
    for (let li = 0; li < srcLines.length; li++) {
        const line = srcLines[li]
        const isSep = li === 1   // 块内第 2 行必为 |---| 分隔行，不产出单元格
        const lead = /^[ \t]*/.exec(line)[0].length
        let base = lead
        let s = line.slice(lead)
        if (s.startsWith('|')) { base += 1; s = s.slice(1) }
        if (s.endsWith('|')) s = s.slice(0, -1)
        const parts = s.split('|')
        let pos = base
        for (let k = 0; k < parts.length; k++) {
            if (!isSep) {
                if (count === cellIdx) {
                    let start = pos
                    while (line[start] === ' ') start++
                    return off + start
                }
                count++
            }
            const pipe = line.indexOf('|', pos)
            if (pipe < 0) break
            pos = pipe + 1
        }
        off += line.length + 1
    }
    return -1
}

// 行编辑器事件绑定：行模式 Enter 提交并前进下一行；块模式（表格/代码）Enter 换行、Ctrl+Enter 提交
function bindLineEditorEvents(ta) {
    ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Escape') { ev.preventDefault(); cancelLineEdit(); return }
        if (ev.key === 'Enter') {
            const isBlock = liveEdit && liveEdit.mode === 'block'
            if (isBlock) {
                if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); commitLineEdit(); return }
                return   // 块模式：Enter 换行（不拦截，textarea 默认行为）
            }
            // 行模式：Enter 提交前进；Shift+Enter 不产生换行（行编辑器是单行语义）
            ev.preventDefault()
            if (!ev.shiftKey) lineEditEnter()
            return
        }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); moveLineEdit(-1); return }
        if (ev.key === 'ArrowDown') { ev.preventDefault(); moveLineEdit(1); return }
        // Backspace 行首合并：非空行 + 光标在行首 → 合并到上一行（Obsidian 习惯）
        if (ev.key === 'Backspace' && liveEdit && liveEdit.mode === 'line'
            && ta.selectionStart === 0 && ta.selectionEnd === 0 && ta.value !== '') {
            ev.preventDefault()
            mergeLineUp()
            return
        }
        // Backspace 空行回退：空行 + 光标在行首 → 删除该空行并回到上一行行尾
        if (ev.key === 'Backspace' && liveEdit && liveEdit.mode === 'line' && ta.value === '' && ta.selectionStart === 0) {
            ev.preventDefault()
            backspaceBlankLine()
            return
        }
    })
    ta.addEventListener('blur', () => commitLineEdit())
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
}

// Backspace 行首合并：当前行拼到上一行末尾，光标停在拼接处
function mergeLineUp() {
    const le = liveEdit
    if (!le || le.mode !== 'line') return
    const tab = state.tabs.find((t) => t.path === le.path)
        || state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const lines = f.content.split('\n')
    if (le.lineNo <= 0 || le.lineNo >= lines.length) { commitLineEdit(); return }
    const prev = lines[le.lineNo - 1] || ''
    pushEditUndo(f.path)
    lines[le.lineNo - 1] = prev + le.ta.value
    lines.splice(le.lineNo, 1)
    f.content = lines.join('\n')
    commitAndReopen(le.lineNo - 1, prev.length)
}

// Backspace 空行回退：删除当前空行并回到上一行行尾（Obsidian 行为）
function backspaceBlankLine() {
    const le = liveEdit
    if (!le || le.mode !== 'line') return
    const tab = state.tabs.find((t) => t.path === le.path)
        || state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) { commitLineEdit(); return }
    const lines = f.content.split('\n')
    if (le.lineNo <= 0 || le.lineNo >= lines.length) { commitLineEdit(); return }
    if ((lines[le.lineNo] || '') !== '') { commitLineEdit(); return }   // 非空行：走默认删除
    const prevLen = (lines[le.lineNo - 1] || '').length
    pushEditUndo(f.path)
    lines.splice(le.lineNo, 1)
    f.content = lines.join('\n')
    commitAndReopen(le.lineNo - 1, prevLen)
}

// 行编辑器内容 → 状态栏行号 + lastCaretPos（供插件插入定位）
function updateLineStatus() {
    const le = liveEdit
    if (!le) return
    if (le.mode === 'block') {
        // 块模式（表格/代码/多行段）：按光标前换行数算实际行号
        const upto = le.ta.value.slice(0, le.ta.selectionStart)
        const nl = upto.lastIndexOf('\n')
        state.cursorLine = le.s + 1 + (nl === -1 ? 0 : upto.slice(0, nl).split('\n').length)
        state.cursorCol = le.ta.selectionStart - nl
        updateStatusBar()
        return
    }
    state.cursorLine = le.lineNo + 1
    state.cursorCol = le.ta.selectionStart + 1
    updateStatusBar()
    const f = state.currentFile
    if (f && typeof f.content === 'string') {
        const lines = f.content.split('\n')
        let start = 0
        for (let i = 0; i < le.lineNo; i++) start += (lines[i] || '').length + 1
        lastCaretPos = start + le.ta.selectionStart
    }
}

// 行模式：↑↓ 光标移动到相邻行（编辑器跟随光标位置重新打开；可跨块移动，光标列尽量保持）
function moveLineEdit(delta) {
    const le = liveEdit
    if (!le || le.mode !== 'line') return
    const tab = state.tabs.find((t) => t.path === le.path)
        || state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const lines = f.content.split('\n')
    const next = le.lineNo + delta
    if (next < 0 || next >= lines.length) return   // 边界：不越出文档
    // 保存当前行修改（记录撤销），然后在新行位置重新打开编辑器 → 光标跟随移动
    const col = le.ta.selectionStart
    if (le.ta.value !== lines[le.lineNo]) pushEditUndo(f.path)
    lines[le.lineNo] = le.ta.value
    f.content = lines.join('\n')
    commitAndReopen(next, col)
}

// 提交：把编辑器内容写回源文件对应行（或行区间）→ 重渲染恢复渲染态
function commitLineEdit() {
    const le = liveEdit
    if (!le) return
    liveEdit = null
    // 优先按"打开编辑器时记录的路径"定位标签：面板中途切换文件时，编辑内容仍写回原文件
    const tab = (le.path && state.tabs.find((t) => t.path === le.path))
        || state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    const newVal = le.ta.value
    le.ta.remove()
    if (le.cancel || !f) {
        if (f) renderLiveEditor(le.paneIdx)   // 取消：恢复渲染（就地替换删了渲染文本，必须重渲染）
        return
    }
    const lines = f.content.split('\n')
    if (le.mode === 'line') {
        if (le.lineNo >= 0 && le.lineNo < lines.length) {
            if (newVal !== lines[le.lineNo]) pushEditUndo(f.path)
            lines[le.lineNo] = newVal
        }
    } else {
        const replacement = newVal === '' ? [''] : newVal.split('\n')
        if (le.s >= 0 && le.s <= le.e && le.e < lines.length) {
            if (lines.slice(le.s, le.e + 1).join('\n') !== newVal) pushEditUndo(f.path)
            lines.splice(le.s, le.e - le.s + 1, ...replacement)
        }
    }
    f.content = lines.join('\n')
    updateSaveStatus(le.paneIdx)
    renderTabs()
    if (le.paneIdx === state.activePane) renderOutline()
    // 无条件重渲染：恢复该行渲染态
    const P = paneEls(le.paneIdx)
    const scrollTop = P.liveEditor.scrollTop
    renderLiveEditor(le.paneIdx)
    P.liveEditor.scrollTop = scrollTop
}

// 提交并重渲染后，在指定行重新打开编辑（回车前进 / ↑↓ 移动等连续编辑场景）
function commitAndReopen(lineNo, caret) {
    const le = liveEdit
    if (!le) return
    liveEdit = null
    updateSaveStatus(le.paneIdx)
    renderTabs()
    if (le.paneIdx === state.activePane) renderOutline()
    const P = paneEls(le.paneIdx)
    const scrollTop = P.liveEditor.scrollTop
    renderLiveEditor(le.paneIdx)
    P.liveEditor.scrollTop = scrollTop
    if (lineNo >= 0) {
        const paneIdx = le.paneIdx
        setTimeout(() => {
            openLineAt(lineNo, paneIdx, caret)
            if (!liveEdit) {
                // 新行不在任何块（防御）：在 liveEditor 正确位置追加行编辑器，光标继续
                appendTailLineEditor(lineNo, paneIdx)
            }
        }, 0)
    }
}

// 在指定行位置插入空行编辑器（无块覆盖行：空分隔行 / 文档末尾）
function appendTailLineEditor(lineNo, paneIdx) {
    const idx = (paneIdx != null && state.panes[paneIdx]) ? paneIdx : state.activePane
    const P = paneEls(idx)
    const ta = createRichLineEditor('')
    const blks = [...P.liveEditor.querySelectorAll('.blk[data-s]')]
    const nextBlk = blks.find((b) => parseInt(b.dataset.s, 10) > lineNo)
    const bodyEl = P.liveEditor.querySelector('.md-body')
    if (nextBlk) nextBlk.parentNode.insertBefore(ta, nextBlk)
    else if (bodyEl) bodyEl.appendChild(ta)
    else P.liveEditor.appendChild(ta)
    const tab = state.tabs.find((t) => t.id === state.panes[idx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) { ta.remove(); return }
    liveEdit = { mode: 'line', paneIdx: idx, path: f.path, blk: null, lineNo, s: lineNo, e: lineNo, ta, cancel: false }
    bindLineEditorEvents(ta)
    if (!nextBlk) P.liveEditor.scrollTop = P.liveEditor.scrollHeight
}

// 行模式回车：Obsidian 行为 + 行中间拆分
// - 光标在行中间 → 拆分：光标前留在本行，光标后移到下一行（符合人类编辑习惯）
//   · 列表行：新行沿用列表标识（有序编号递增 1. → 2.）
// - 光标在行尾 / 空行：
//   · 列表行：下方插入同类型标识行；若下一行已是"空标识行"→ 去掉标识下移（结束列表）
//   · 当前行本身是"空标识行"（刚回车产生）→ 回车即去除标识，光标停在该行（两次回车结束列表）
//   · 普通行 / 空行：下方插入空行，光标下移（可无限连续回车产生空行）
function lineEditEnter() {
    const le = liveEdit
    if (!le || le.mode !== 'line') { commitLineEdit(); return }
    const tab = state.tabs.find((t) => t.path === le.path)
        || state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) { commitLineEdit(); return }
    const lines = f.content.split('\n')
    const curLine = le.ta.value
    const caret = (typeof le.ta.selectionStart === 'number' && le.ta.selectionStart >= 0) ? le.ta.selectionStart : curLine.length
    const marker = /^(\s*)([-*+]|\d+\.)\s+/.exec(curLine)
    const curIsBareMarker = marker && curLine.slice(marker[0].length) === ''
    const nextNo = le.lineNo + 1
    // 当前行是"只有标识"（上一次回车产生）→ 直接在编辑器内去掉标识，光标保持在该行（Obsidian：两次回车结束列表）
    if (curIsBareMarker) {
        le.ta.value = ''
        le.ta.focus()
        updateLineStatus()
        return
    }
    // —— 行中间拆分：光标前留在本行，光标后（含列表标识）移到下一行 ——
    if (caret > 0 && caret < curLine.length) {
        pushEditUndo(f.path)
        const before = curLine.slice(0, caret)
        const after = curLine.slice(caret)
        if (marker && caret >= marker[0].length) {
            // 列表行：新行沿用标识（有序编号递增）
            let prefix = marker[1] + marker[2] + ' '
            const num = /^(\d+)\.$/.exec(marker[2])
            if (num) prefix = marker[1] + (parseInt(num[1], 10) + 1) + '. '
            lines[le.lineNo] = before
            lines.splice(nextNo, 0, prefix + after)
            f.content = lines.join('\n')
            commitAndReopen(nextNo, prefix.length)
            return
        }
        lines[le.lineNo] = before
        lines.splice(nextNo, 0, after)
        f.content = lines.join('\n')
        commitAndReopen(nextNo, 0)
        return
    }
    // —— 行尾 / 空行：提交当前行（记录撤销）——
    pushEditUndo(f.path)
    lines[le.lineNo] = curLine
    if (marker) {
        // 下一行是"空标识行"（上一次回车产生，且光标又回到本行）→ 去掉标识并下移（结束列表）
        const nextLine = lines[nextNo] || ''
        const nextMarker = /^(\s*)([-*+]|\d+\.)\s+/.exec(nextLine)
        const nextIsBareMarker = nextMarker && nextLine.slice(nextMarker[0].length) === ''
        if (nextIsBareMarker) {
            lines[nextNo] = ''
            f.content = lines.join('\n')
            commitAndReopen(nextNo)
            return
        }
        // 列表续接：插入新的标识行（下一行及后续整体下移，不覆盖原内容；有序编号递增）
        let prefix = marker[1] + marker[2] + ' '
        const num = /^(\d+)\.$/.exec(marker[2])
        if (num) prefix = marker[1] + (parseInt(num[1], 10) + 1) + '. '
        lines.splice(nextNo, 0, prefix)
        f.content = lines.join('\n')
        commitAndReopen(nextNo)
        return
    }
    // 普通行 / 空行：插入空行，光标下移（可无限连续回车）
    lines.splice(nextNo, 0, '')
    f.content = lines.join('\n')
    commitAndReopen(nextNo)
}

// 取消（Esc）：不提交，恢复渲染
function cancelLineEdit() {
    const le = liveEdit
    if (!le) return
    le.cancel = true
    commitLineEdit()   // 让 commitLineEdit 走取消分支（移除编辑器并重渲染恢复）
}
function showPaneEditorInput(i) {
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    P.previewPane.classList.add('hidden')
    if (f && isMarkdown(f.name)) {
        P.liveEditor.classList.remove('hidden')
        P.editor.classList.add('hidden')
        renderLiveEditor(i)
        // 空文档（新建笔记）：自动打开第 0 行编辑器，用户可直接输入（贴合 Obsidian）
        if (i === state.activePane && f.content.trim() === '') {
            setTimeout(() => openLineAt(0, i, 0), 0)
        }
    } else {
        P.editor.classList.remove('hidden')
        P.liveEditor.classList.add('hidden')
        if (i === state.activePane) { P.editor.focus(); updateCursorPos() }
    }
}

// 预览态（按面板）：渲染静态阅读视图
function showPanePreview(i) {
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    P.previewPane.classList.remove('hidden')
    P.editor.classList.add('hidden')
    P.liveEditor.classList.add('hidden')
    if (!f) return
    P.previewContent.innerHTML = buildPreviewHtml(f)
    highlightPreviewBlocks()
    P.previewPane.scrollTop = 0
}

/* ================================================================
 * Obsidian 风格"所见即所得"编辑器：
 * 编辑模式下整篇 Markdown 以渲染态展示；点击某个块 → 该块暴露原始
 * Markdown（textarea 就地编辑）；失焦 / Ctrl+Enter 提交并重渲染，
 * Esc 取消。块行号区间由 md-parser 的 data-s / data-e 提供。
 * ================================================================ */

// 面板 0 的实时编辑器事件委托（面板 1 在 createPaneDom 里绑定同一个处理函数）
els.liveEditor.addEventListener('click', handleLiveEditorClick)

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

// 根据文件构造预览 HTML（阅读视图 / 分屏预览共用）
function buildPreviewHtml(f) {
    if (!f || !f.path) return ''
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
// 遍历所有面板的阅读视图与所见即所得容器
function highlightPreviewBlocks() {
    if (!window.SyntaxHighlighter) return
    for (let i = 0; i < state.panes.length; i++) {
        const P = paneEls(i)
        for (const root of [P.previewContent, P.liveEditor]) {
            if (!root) continue
            root.querySelectorAll('pre code[data-lang]').forEach((code) => {
                const lang = code.getAttribute('data-lang')
                const text = code.textContent
                code.innerHTML = window.SyntaxHighlighter.highlight(text, lang)
                code.classList.add('highlighted')
            })
        }
    }
}

/* ================================================================
 * Markdown 增强：任务勾选回写 / 双向链接跳转 / 目录锚点滚动 / 反链
 * 事件委托挂在每个面板的 previewContent 上（面板 1 由 createPaneDom 绑定）
 * ================================================================ */

function handlePreviewChange(e) {
    const cb = e.target
    if (!cb.matches('input[type=checkbox][data-line]')) return
    toggleTaskLine(cb)
}

function handlePreviewClick(e) {
    const wl = e.target.closest('.wikilink')
    if (wl) {
        e.preventDefault()
        openWikilink(wl.getAttribute('data-target'))
        return
    }
    const ta = e.target.closest('.toc a')
    if (ta) {
        e.preventDefault()
        const root = e.currentTarget
        const id = ta.getAttribute('href').slice(1)
        const el = root.querySelector('#' + CSS.escape(id))
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
            target = fileUrlToPath(href)
        } else if (!/^[a-zA-Z]+:/.test(href)) {
            const f = state.currentFile
            if (f) target = joinPath(parentDir(f.path), href)   // 相对路径按当前文件目录解析
        }
        if (target) openLocalPath(target)
    }
}

els.previewContent.addEventListener('change', handlePreviewChange)
els.previewContent.addEventListener('click', handlePreviewClick)

// 在应用内打开本地路径（B1 辅助）：图片 / PDF 走预览，文本走标签页
async function openLocalPath(target) {
    const name = basename(target)
    if (isImageFile(name)) { showImage({ path: target, name }); return }
    if (isPdfFile(name)) { showPdf({ path: target, name }); return }
    if (isTextFile(name)) await openFileByPath(target)
}

// 任务列表勾选 → 定位源文件对应行，切换 [ ] ↔ [x] 并写回磁盘
// 勾选框可能来自任一面板：按所在面板解析标签
async function toggleTaskLine(cb) {
    const paneIdx = cb.closest('.pane') ? Number(cb.closest('.pane').dataset.pane) : state.activePane
    const tab = state.tabs.find((t) => t.id === state.panes[paneIdx].tabId) || null
    const f = tab && tab.path ? tab : null
    if (!f) return
    const lineNo = parseInt(cb.getAttribute('data-line'), 10)
    const lines = f.content.split('\n')
    if (lineNo < 1 || lineNo > lines.length) return
    // 该行可能是 "- [ ]" / "1. [x]" 等任意前缀，只替换 [ ]/[x] 本身
    lines[lineNo - 1] = lines[lineNo - 1].replace(/\[([ xX])\]/i, cb.checked ? '[x]' : '[ ]')
    const content = lines.join('\n')
    f.content = content
    const P = paneEls(paneIdx)
    P.editor.value = content // 同步文本框，切回编辑态时内容一致
    if (!P.liveEditor.classList.contains('hidden')) renderLiveEditor(paneIdx)   // 所见即所得视图同步重渲染
    const res = await window.electronAPI.writeFile(f.path, content)
    if (!res.ok) {
        alert('保存失败：' + res.error)
        return
    }
    f.originalContent = content // 已落盘，刷新"未保存"基线
    updateSaveStatus(paneIdx)
    if (paneIdx === state.activePane) renderOutline()
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

// 反链：全文搜索 "[[当前文件名"，列出引用方（排除本文档自己），作用于活动面板
async function showBacklinks() {
    const P = curPaneEls()
    const f = state.currentFile
    if (!f || !isMarkdown(f.name)) return
    const base = f.name.replace(/\.md$/i, '')
    const res = await window.electronAPI.searchContent(state.rootPath, '[[' + base)
    const files = (res.ok ? res.results : []).filter((r) => r.path !== f.path)
    renderBacklinksList(files)
    P.backlinksPanel.classList.remove('hidden')
}

// 渲染反链结果：每个引用文件 + 命中行文本，点击打开
function renderBacklinksList(files) {
    const P = curPaneEls()
    P.backlinksList.innerHTML = ''
    if (!files.length) {
        P.backlinksList.innerHTML = '<div class="backlink-empty">还没有其他笔记引用本文档</div>'
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
        P.backlinksList.appendChild(item)
    })
}

function closeBacklinks() {
    for (let i = 0; i < state.panes.length; i++) {
        const P = paneEls(i)
        if (P.backlinksPanel) P.backlinksPanel.classList.add('hidden')
    }
}

// 编辑 / 预览切换按钮（作用于活动面板）
els.viewModeBtn.addEventListener('click', toggleViewMode)

function updateViewModeBtn(paneIndex) {
    const i = paneIndex == null ? state.activePane : paneIndex
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const f = tab && tab.path ? tab : null
    const hasFile = !!f
    P.viewModeBtn.style.display = hasFile ? '' : 'none'
    P.viewModeBtn.textContent = pane.viewMode === 'preview' ? '✏️ 编辑' : '👁 预览'
    // 反链按钮：仅 Markdown 文件显示
    P.backlinksBtn.style.display = hasFile && isMarkdown(f.name) ? '' : 'none'
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
    els.gitPanel.classList.add('hidden')
    els.aiPanel.classList.add('hidden')
    closeGraph()   // 知识图谱（#13）：关闭并停止模拟
    closeQuickSwitcher()   // 避免浮层残留盖在打开的面板上
    closeCommandPalette()
    closeFindBar()   // 查找条是 editorPane 子元素，切到其它面板时清理，防止回来时残留陈旧状态
    currentPdfPath = null
}

// 编辑事件：内容变化时刷新"未保存"状态与标签圆点（面板 0 文本框；面板 1 由 createPaneDom 绑定 onEditorInput）
els.editor.addEventListener('input', () => onEditorInput(0))

// 刷新保存状态文字 / 自动保存调度（按面板）
// 任何内容变化都会走到这里 → 触发防抖自动保存（无需保存按钮，实时落盘）
function updateSaveStatus(paneIndex) {
    const i = paneIndex == null ? state.activePane : paneIndex
    const P = paneEls(i)
    const pane = state.panes[i]
    const tab = state.tabs.find((t) => t.id === pane.tabId) || null
    const dirty = !!(tab && tab.path && tab.content !== tab.originalContent)
    if (dirty) {
        P.saveStatus.textContent = '● 保存中…'
        P.saveStatus.classList.add('dirty')
        P.saveStatus.classList.remove('fail')
        scheduleAutoSave()
    } else {
        P.saveStatus.textContent = '已保存'
        P.saveStatus.classList.remove('dirty', 'fail')
    }
}

// —— 自动保存（实时落盘）：防抖 600ms，写入所有有未保存修改的标签 ——
let autoSaveTimer = null
function scheduleAutoSave() {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(autoSaveAll, 600)
}

async function autoSaveAll() {
    autoSaveTimer = null
    for (const tab of state.tabs) {
        if (!tab || !tab.path || typeof tab.content !== 'string') continue
        if (tab.content === tab.originalContent) continue
        const res = await window.electronAPI.writeFile(tab.path, tab.content)
        if (!res.ok) {
            // 落盘失败：保持"未保存"状态并提示，下次输入会重试
            for (let i = 0; i < state.panes.length; i++) {
                const P = paneEls(i)
                if (state.panes[i].tabId === tab.id) {
                    P.saveStatus.textContent = '⚠ 保存失败'
                    P.saveStatus.classList.add('fail')
                }
            }
            continue
        }
        tab.originalContent = tab.content
        for (let i = 0; i < state.panes.length; i++) {
            if (state.panes[i].tabId === tab.id) updateSaveStatus(i)
        }
    }
    renderTabs()
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
    for (let i = 0; i < state.panes.length; i++) {
        const pane = state.panes[i]
        if (pane.tabId === f.id) updateSaveStatus(i)
    }
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
// 所见即所得模式下：滚动到包含该行的渲染块并闪烁提示（作用于活动面板）
function revealLine(lineNum) {
    const f = state.currentFile
    if (!f) return false
    const n = Math.max(1, lineNum || 1)
    const P = curPaneEls()
    // Markdown 且 liveEditor 可见 → 按块定位
    if (isMarkdown(f.name) && !P.liveEditor.classList.contains('hidden')) {
        const blk = P.liveEditor.querySelector('.blk[data-s]') && [...P.liveEditor.querySelectorAll('.blk[data-s]')]
            .find((b) => parseInt(b.dataset.s, 10) <= n - 1 && parseInt(b.dataset.e, 10) >= n - 1)
        if (blk) {
            blk.scrollIntoView({ block: 'center' })
            blk.classList.add('flash')
            setTimeout(() => blk.classList.remove('flash'), 900)
            return true
        }
        return false
    }
    const editor = P.editor
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
    // 恢复面板视图模式（会话保存了 viewMode；不应用则状态栏与视图不一致）
    if (state.panes[0]) state.panes[0].viewMode = state.viewMode
    if (state.currentFile) {
        if (state.viewMode === 'preview') showPanePreview(0)
        else showPaneEditorInput(0)
    }
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
    exitBatchMode()   // 退出批量选择模式
    els.batchDialogOverlay.classList.add('hidden')
    state.rootPath = path
    els.currentPath.textContent = path
    // 旧工作区的标签、历史、展开状态对新目录无意义，全部重置
    state.tabs = []
    state.activeTabId = null
    state.activeTag = null            // 清标签筛选，避免旧标签过滤新工作区
    state.expanded.clear()
    state.history = []
    state.historyIndex = -1
    state.searchResults = []
    if (state.panes.length > 1) unsplitPane()   // 切换工作区回到单面板，避免分屏残留悬空
    updateNavBtns()
    renderTags()
    renderTagFilter()
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
    await loadGitStatus()   // Git 状态随工作区加载（树徽章）
    await loadPluginsForWorkspace()   // 插件随工作区加载（#14）
    // 图谱开着时重扫（切换工作区/刷新后数据已变）
    if (!els.graphPanel.classList.contains('hidden')) loadGraph()
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
let lastCaretPos = -1   // 最后光标源偏移（实时跟踪，插件插入兜底；块编辑/文本框都更新）

// 表格模板（插入时用）
const TABLE_SNIPPET = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'

// 底层：用 setRangeText 替换 [start,end) 区间，并手动派发 input 事件。
// setRangeText 本身不触发 input，不派发的话"未保存"状态不会更新。
function applyEditorEdit(start, end, text) {
    const el = curEditor()
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
    const el = curEditor()
    const sel = el.value.slice(ctxSelStart, ctxSelEnd) || placeholder
    applyEditorEdit(ctxSelStart, ctxSelEnd, before + sel + after)
}

// 在当前行行首插入前缀（标题、列表、引用等块级语法）
function linePrefix(prefix) {
    const el = curEditor()
    const start = el.value.lastIndexOf('\n', ctxSelStart - 1) + 1
    applyEditorEdit(start, start, prefix)
}

// 插入 Markdown 链接 [文字](url)：有选中文字当链接文字，否则依次问 url 和文字
async function insertLink() {
    const el = curEditor()
    const selText = el.value.slice(ctxSelStart, ctxSelEnd).trim()
    const url = await window.prompt('链接地址（URL）：', 'https://')
    if (!url) return
    let text = selText
    if (!text) text = await window.prompt('链接显示文字：', '链接') || url
    applyEditorEdit(ctxSelStart, ctxSelEnd, '[' + text + '](' + url + ')')
}

// 插入图片 ![alt](url)
async function insertImage() {
    const el = curEditor()
    const alt = el.value.slice(ctxSelStart, ctxSelEnd).trim() || '图片'
    const url = await window.prompt('图片地址（URL）：', 'https://')
    if (!url) return
    applyEditorEdit(ctxSelStart, ctxSelEnd, '![' + alt + '](' + url + ')')
}

// 插入双向链接 [[目标]]（有选中文字当目标）
async function insertWikilink() {
    const el = curEditor()
    const sel = el.value.slice(ctxSelStart, ctxSelEnd).trim()
    const target = sel || await window.prompt('笔记名称：')
    if (!target) return
    applyEditorEdit(ctxSelStart, ctxSelEnd, '[[' + target + ']]')
}

// ================================================================
// 插入内部笔记链接选择器（Obsidian 风格）：输入笔记名 → 搜索工作区 md → 选择插入 [[名称]]
// ================================================================
let lkResults = []      // [{ name, path }]（去 .md 后缀显示）
let lkIndex = 0

function openLinkPicker() {
    if (!state.rootPath) { showNotice('请先打开一个工作区'); return }
    els.linkPicker.classList.remove('hidden')
    els.lkInput.value = ''
    els.lkResults.innerHTML = ''
    lkResults = []
    lkIndex = 0
    els.lkInput.focus()
    renderLkResults('')
}

function closeLinkPicker() {
    els.linkPicker.classList.add('hidden')
}

// 搜索 + 渲染：调用主进程 fs:search 匹配文件名，只留 Markdown
let lkTimer
els.lkInput.addEventListener('input', () => {
    clearTimeout(lkTimer)
    lkTimer = setTimeout(() => renderLkResults(els.lkInput.value.trim()), 180)
})

async function renderLkResults(q) {
    const list = els.lkResults
    list.innerHTML = ''
    lkResults = []
    lkIndex = 0
    let items = []
    if (q) {
        const res = await window.electronAPI.search(state.rootPath, q)
        if (res.ok) {
            items = res.results
                .filter((r) => !r.isDir && /\.md$/i.test(r.name))
                .map((r) => ({ name: r.name.replace(/\.md$/i, ''), path: r.path }))
        }
    } else {
        // 空输入：列出根目录全部 md（快速链接常用笔记）
        const res = await window.electronAPI.readDir(state.rootPath)
        if (res.ok) {
            items = res.items
                .filter((i) => !i.isDir && /\.md$/i.test(i.name))
                .map((i) => ({ name: i.name.replace(/\.md$/i, ''), path: joinPath(state.rootPath, i.name) }))
        }
    }
    // 去重 + 截断
    const seen = new Set()
    lkResults = items.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true))).slice(0, 50)
    if (!lkResults.length) {
        list.innerHTML = '<div class="qs-item" style="cursor:default;color:var(--icon-muted)">没有找到 Markdown 笔记</div>'
        return
    }
    lkResults.forEach((it, i) => {
        const item = document.createElement('div')
        item.className = 'qs-item' + (i === lkIndex ? ' active' : '')
        const icon = document.createElement('span')
        icon.className = 'qs-icon'
        icon.textContent = '📄'
        const name = document.createElement('span')
        name.className = 'qs-name'
        name.textContent = it.name
        const pathEl = document.createElement('span')
        pathEl.className = 'qs-path'
        pathEl.textContent = it.path
        item.append(icon, name, pathEl)
        item.addEventListener('click', () => insertLkPick(i))
        item.addEventListener('mousemove', () => { lkIndex = i; updateLkHighlight() })
        list.appendChild(item)
    })
}

function updateLkHighlight() {
    [...els.lkResults.children].forEach((el, i) => el.classList.toggle('active', i === lkIndex))
}

// 插入选中的笔记链接 [[名称]]（文本框模式用 ctxSel；实时模式用记录的位置 lkInsertPos）
function insertLkPick(i) {
    const it = lkResults[i]
    if (!it) return
    closeLinkPicker()
    const link = '[[' + it.name + ']]'
    if (lkInsertPos >= 0) {
        srcApply((f) => {
            const norm = f.content.replace(/\r\n/g, '\n')
            f.content = norm.slice(0, lkInsertPos) + link + norm.slice(lkInsertPos)
        })
        lkInsertPos = -1
    } else {
        applyEditorEdit(ctxSelStart, ctxSelEnd, link)
        renderLiveEditor(state.activePane)   // 实时模式重渲染显示新链接
    }
}

els.lkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLinkPicker(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); lkIndex = Math.min(lkIndex + 1, lkResults.length - 1); updateLkHighlight(); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); lkIndex = Math.max(lkIndex - 1, 0); updateLkHighlight(); return }
    if (e.key === 'Enter') { e.preventDefault(); insertLkPick(lkIndex); return }
})
els.linkPicker.addEventListener('click', (e) => { if (e.target === els.linkPicker) closeLinkPicker() })

// 编辑器右键菜单：插入子菜单 + 链接 + 常用编辑操作
function showEditorContextMenu(x, y) {
    // 标题：H1-H6 子菜单（参考 Obsidian）
    const headings = [1, 2, 3, 4, 5, 6].map((n) => ({
        label: '标题 H' + n,
        action: () => linePrefix('#'.repeat(n) + ' '),
    }))
    const insert = [
        { label: '标题', submenu: headings },
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
    ]
    const items = []
    // 有选区时置顶"用选中文字问 AI"
    if (ctxSelEnd > ctxSelStart) {
        items.push({ label: '🤖 用选中文字问 AI（' + (ctxSelEnd - ctxSelStart) + ' 字符）', action: askAiSelection })
    }
    // 插件命令子菜单（#14 商店）：动态列出已加载插件
    const pluginCmds = PluginManager.commands()
    if (pluginCmds.length) {
        items.push({ label: '🧩 插件命令', submenu: pluginCmds.map((c) => ({ label: c.label, action: () => PluginManager.runCommand(c) })) })
    }
    items.push(
        { label: '🔗 插入内部笔记链接…', action: () => { hideContextMenu(); openLinkPicker() } },
        { label: '📥 插入', submenu: insert },
        { label: '🔗 插入链接', action: () => insertLink() },
        { label: '✂️ 剪切', action: () => { const el = curEditor(); el.focus(); el.setSelectionRange(ctxSelStart, ctxSelEnd); document.execCommand('cut') } },
        { label: '⧉ 复制', action: () => { const el = curEditor(); el.focus(); el.setSelectionRange(ctxSelStart, ctxSelEnd); document.execCommand('copy') } },
        { label: '☑ 全选', action: () => { const el = curEditor(); el.focus(); el.select() } },
    )
    showContextMenu(x, y, items)
}

// 用右键菜单保存的选区直接问 AI（文本框模式）
function askAiSelection() {
    aiSel = ctxSelEnd > ctxSelStart ? { start: ctxSelStart, end: ctxSelEnd } : null
    aiSelText = null
    openAiPanel(true)   // 跳过重复捕获（用已保存的选区）
}

// 所见即所得模式右键：有渲染选区时提供"用选中文字问 AI"，另附插件命令子菜单
// —— liveEditor 右键：点击位置 → 源偏移 / 行号（供插入操作定位）——
let lkInsertPos = -1   // 链接选择器在实时模式的插入位置（源偏移）

// 渲染节点 → 源字符偏移（近似：行号 + 行内渲染偏移）
// 渲染节点 → 源字符偏移（行容器序号定位：列表 / 标题逐项准确）
function nodeToSrcOffset(blk, node, offset) {
    const f = state.currentFile
    if (!f || !blk) return -1
    const rowEl = rowElementOf(node, blk)
    if (!rowEl) return -1
    const lineNo = rowElToLineNo(blk, rowEl)
    const lines = f.content.replace(/\r\n/g, '\n').split('\n')
    if (lineNo < 0 || lineNo >= lines.length) return -1
    let start = 0
    for (let i = 0; i < lineNo; i++) start += (lines[i] || '').length + 1
    // 行内偏移（渲染 → 源）：渲染行可能不含源行的行首标记（- / # / > 等），按子串位置补偿
    let col = 0
    try {
        const r = document.createRange()
        r.setStart(rowEl, 0)
        r.setEnd(node, offset)
        col = r.toString().length
    } catch { col = 0 }
    const srcLine = lines[lineNo]
    const renderLine = (rowEl.textContent || '').trim()
    let offsetInSrc = col
    if (renderLine && srcLine.includes(renderLine)) {
        offsetInSrc = col + srcLine.indexOf(renderLine)   // 标记补偿（列表/标题/引用）
    }
    return start + Math.min(offsetInSrc, srcLine.length)
}

// 就地修改源文件并重渲染（实时模式右键插入用）
function srcApply(fn, lineNo) {
    // 菜单操作前安全清理行编辑器（值已由 flushLineEditValue 写回源，直接移除 ta 即可；
    // 避免 renderLiveEditor 重渲染时与 blur 竞争报错"node no longer a child"）
    if (liveEdit) {
        const le = liveEdit
        liveEdit = null
        if (le.ta && le.ta.parentNode) le.ta.remove()
    }
    const f = state.currentFile
    if (!f) return
    pushEditUndo(f.path)   // 右键格式化/删除/插入链接等操作可撤销
    fn(f)
    for (let i = 0; i < state.panes.length; i++) {
        const pEls = paneEls(i)
        const pane = state.panes[i]
        const tab = state.tabs.find((t) => t.id === pane.tabId)
        if (tab && pEls.editor) pEls.editor.value = f.content
    }
    updateSaveStatus(state.activePane)
    renderTabs()
    if (state.activePane === state.panes.findIndex((p) => p.tabId === f.id)) renderOutline()
    const P = curPaneEls()
    const scrollTop = P.liveEditor.scrollTop
    renderLiveEditor(state.activePane)
    P.liveEditor.scrollTop = scrollTop
    if (lineNo != null) revealLine(lineNo + 1)
}

// 实时模式右键菜单（与文本框对齐：链接 / 标题 / 格式 / 列表，作用于点击位置或选区）
// 行号 → 源字符偏移（该行行首）
function lineSrcOffset(lineNo) {
    const f = state.currentFile
    if (!f) return -1
    const lines = f.content.replace(/\r\n/g, '\n').split('\n')
    if (lineNo < 0 || lineNo >= lines.length) return -1
    let s = 0
    for (let i = 0; i < lineNo; i++) s += (lines[i] || '').length + 1
    return s
}

// 定位覆盖 pos 的链接（wikilink [[目标]] / [[目标|别名]] 或 markdown 链接 [文字](url)）。
// 返回 { start, end, keep }：start/end 为链接整体在文本中的区间，keep 为移除语法后保留的文字。
function findLinkAround(text, pos) {
    const s = String(text || '')
    const wlRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
    const mdRe = /\[([^\]]+)\]\(([^)\n]*)\)/g
    let m
    wlRe.lastIndex = 0
    while ((m = wlRe.exec(s))) {
        if (pos >= m.index && pos <= m.index + m[0].length) {
            return { start: m.index, end: m.index + m[0].length, keep: (m[2] != null && m[2] !== '') ? m[2] : m[1] }
        }
    }
    mdRe.lastIndex = 0
    while ((m = mdRe.exec(s))) {
        if (pos >= m.index && pos <= m.index + m[0].length) {
            return { start: m.index, end: m.index + m[0].length, keep: m[1] }
        }
    }
    return null
}

// 把行编辑器当前值写回源文件（不重渲染、不退出编辑）：供右键菜单操作基于最新内容
function flushLineEditValue() {
    const le = liveEdit
    if (!le || le.mode !== 'line') return
    const tab = state.tabs.find((t) => t.id === state.panes[le.paneIdx].tabId)
    const f = tab && tab.path ? tab : null
    if (!f) return
    const lines = f.content.split('\n')
    if (le.lineNo >= 0 && le.lineNo < lines.length && lines[le.lineNo] !== le.ta.value) {
        pushEditUndo(f.path)
        lines[le.lineNo] = le.ta.value
        f.content = lines.join('\n')
    }
}

function handleLiveEditorCtxMenu(e) {
    e.preventDefault()
    e.stopPropagation()
    const target = e.target || e.currentTarget || null
    if (!target) return
    // —— 编辑行优先：正在编辑某行时，右键操作作用在该行（不退出编辑）——
    let lineNo = -1
    let pos = -1
    if (liveEdit) {
        lineNo = liveEdit.lineNo
        if (liveEdit.mode === 'block') {
            commitLineEdit()   // 块模式（表格/代码/多行段）：提交收起再操作（块内行号难精确）
            pos = lineSrcOffset(lineNo)
        } else {
            flushLineEditValue()   // 行模式：当前值写回源（不重渲染），保持编辑且操作基于最新内容
            pos = lineSrcOffset(lineNo) + (liveEdit.ta.selectionStart || 0)   // 光标位置，而非行首
        }
    } else {
        const blk = target.closest('.blk[data-s]')
        pos = blk ? nodeToSrcOffset(blk, target, 0) : -1
        if (blk) {
            const rowEl = rowElementOf(target, blk)
            lineNo = rowEl ? rowElToLineNo(blk, rowEl) : parseInt(blk.dataset.s, 10)
        }
    }
    if (pos >= 0) lkInsertPos = pos
    // liveEditor 选区（供包裹类操作）
    const sel = window.getSelection()
    let selRange = null
    if (sel && !sel.isCollapsed) {
        // 行编辑中：直接用模拟 selectionStart/End（源偏移，含隐藏修饰符，天然精确）
        if (liveEdit && liveEdit.mode === 'line' && liveEdit.ta && typeof liveEdit.ta.selectionStart === 'number') {
            const s = liveEdit.ta.selectionStart
            const e = liveEdit.ta.selectionEnd
            if (s >= 0 && e >= 0) selRange = { start: Math.min(s, e), end: Math.max(s, e) }
        } else {
            const blk = target.closest('.blk[data-s]')
            if (blk && e.currentTarget.contains(sel.anchorNode)) {
                const a = nodeToSrcOffset(blk, sel.anchorNode, sel.anchorOffset)
                const b = nodeToSrcOffset(blk, sel.focusNode, sel.focusOffset)
                if (a >= 0 && b >= 0) selRange = { start: Math.min(a, b), end: Math.max(a, b) }
            }
        }
    }
    const headings = [1, 2, 3, 4, 5, 6].map((n) => ({
        label: '标题 H' + n,
        action: () => lineNo >= 0 && srcApply((f) => {
            const lines = f.content.split('\n')
            lines[lineNo] = '#'.repeat(n) + ' ' + lines[lineNo].replace(/^#{1,6}\s+/, '')
            f.content = lines.join('\n')
        }, lineNo),
    }))
    const prefix = (pfx) => () => lineNo >= 0 && srcApply((f) => {
        const lines = f.content.split('\n'); lines[lineNo] = pfx + lines[lineNo]; f.content = lines.join('\n')
    }, lineNo)
    const items = []
    // AI（有选区）
    if (sel && sel.toString().trim() && e.currentTarget.contains(sel.anchorNode)) {
        items.push({ label: '🤖 用选中文字问 AI（' + sel.toString().length + ' 字符）', action: () => {
            aiSel = null
            aiSelText = sel.toString()
            openAiPanel(true)
        } })
    }
    items.push({ label: '🔗 插入内部笔记链接…', action: () => { hideContextMenu(); openLinkPicker() } })
    items.push({ label: '🔗 移除链接', action: () => {
        const p = selRange ? selRange.start : pos
        if (p < 0) return
        srcApply((f) => {
            const norm = f.content.replace(/\r\n/g, '\n')
            const link = findLinkAround(norm, p)
            if (!link) { showNotice('光标不在链接内'); return }
            f.content = norm.slice(0, link.start) + link.keep + norm.slice(link.end)
        })
    } })
    items.push({ label: '标题', submenu: headings })
    items.push(
        { label: '加粗', action: () => liveSurround('**', '**', '加粗文本', pos, selRange, lineNo) },
        { label: '斜体', action: () => liveSurround('*', '*', '斜体文本', pos, selRange, lineNo) },
        { label: '删除线', action: () => liveSurround('~~', '~~', '删除线', pos, selRange, lineNo) },
        { label: '高亮', action: () => liveSurround('==', '==', '高亮', pos, selRange, lineNo) },
        { label: '行内代码', action: () => liveSurround('`', '`', '代码', pos, selRange, lineNo) },
        { label: '代码块', action: () => liveSurround('\n```\n', '\n```\n', '代码', pos, selRange, lineNo) },
        { label: '引用', action: prefix('> ') },
        { label: '列表', submenu: [
            { label: '无序列表', action: prefix('- ') },
            { label: '有序列表', action: prefix('1. ') },
            { label: '任务列表', action: prefix('- [ ] ') },
        ] },
        { label: '分割线', action: () => pos >= 0 && srcApply((f) => {
            const norm = f.content.replace(/\r\n/g, '\n')
            f.content = norm.slice(0, pos) + '\n---\n' + norm.slice(pos)
        }, lineNo) },
        { label: '表格', action: () => pos >= 0 && srcApply((f) => {
            const norm = f.content.replace(/\r\n/g, '\n')
            f.content = norm.slice(0, pos) + TABLE_SNIPPET + norm.slice(pos)
        }, lineNo) },
    )
    // 行操作（Obsidian 高频）：复制 / 删除 / 上移 / 下移当前行
    items.push(
        { label: '⧉ 复制当前行', action: () => lineNo >= 0 && srcApply((f) => {
            const lines = f.content.split('\n'); lines.splice(lineNo + 1, 0, lines[lineNo]); f.content = lines.join('\n')
        }, lineNo + 1) },
        { label: '⬆ 上移当前行', action: () => lineNo > 0 && srcApply((f) => {
            const lines = f.content.split('\n'); const t = lines[lineNo]; lines[lineNo] = lines[lineNo - 1]; lines[lineNo - 1] = t; f.content = lines.join('\n')
        }, lineNo - 1) },
        { label: '⬇ 下移当前行', action: () => lineNo >= 0 && lineNo < state.currentFile.content.split('\n').length - 1 && srcApply((f) => {
            const lines = f.content.split('\n'); const t = lines[lineNo]; lines[lineNo] = lines[lineNo + 1]; lines[lineNo + 1] = t; f.content = lines.join('\n')
        }, lineNo + 1) },
        { label: '🗑 删除当前行', danger: true, action: () => lineNo >= 0 && srcApply((f) => {
            const lines = f.content.split('\n'); lines.splice(lineNo, 1); f.content = lines.join('\n')
        }, Math.max(0, lineNo - 1)) },
    )
    const pluginCmds = PluginManager.commands()
    if (pluginCmds.length) {
        items.push({ label: '🧩 插件命令', submenu: pluginCmds.map((c) => ({ label: c.label, action: () => PluginManager.runCommand(c) })) })
    }
    if (items.length) showContextMenu(e.clientX, e.clientY, items)
}

// 实时模式包裹选区（或光标处插入修饰符对）；多行选区逐行包裹；无选区只插修饰符、光标居中
function liveSurround(before, after, placeholder, pos, selRange, lineNo) {
    const f = state.currentFile
    if (!f) return
    if (selRange) {
        const text = f.content.slice(selRange.start, selRange.end) || placeholder
        const isBlockSyntax = before.startsWith('\n')
        const wrapped = text.includes('\n') && !isBlockSyntax
            ? text.split('\n').map((ln) => before + ln + after).join('\n')
            : before + text + after
        srcApply((ff) => {
            const norm = ff.content.replace(/\r\n/g, '\n')
            ff.content = norm.slice(0, selRange.start) + wrapped + norm.slice(selRange.end)
        })
    } else if (pos >= 0) {
        // 行编辑中：直接在编辑器内插入修饰符对（不重渲染不跳转），光标进入修饰符之间等待输入
        if (liveEdit && liveEdit.ta && liveEdit.mode === 'line') {
            const caret = liveEdit.ta.selectionStart || 0
            const cur = liveEdit.ta.value
            liveEdit.ta.value = cur.slice(0, caret) + before + after + cur.slice(caret)
            liveEdit.ta.focus()
            liveEdit.ta.setSelectionRange(caret + before.length, caret + before.length)
            flushLineEditValue()   // 同步到源（不重渲染）
            updateLineStatus()
            return
        }
        // 非行编辑：插入修饰符对并尝试重开行编辑定位光标
        const beforeLen = before.length
        const insert = before + after
        srcApply((ff) => {
            const norm = ff.content.replace(/\r\n/g, '\n')
            ff.content = norm.slice(0, pos) + insert + norm.slice(pos)
        }, lineNo)
        if (lineNo >= 0) {
            setTimeout(() => {
                openLineAt(lineNo)
                if (liveEdit && liveEdit.ta) {
                    const lineStart = lineSrcOffset(liveEdit.lineNo)
                    const caret = pos + beforeLen - lineStart
                    liveEdit.ta.focus()
                    liveEdit.ta.setSelectionRange(Math.max(0, caret), Math.max(0, caret))
                }
            }, 0)
        }
    }
}
els.liveEditor.addEventListener('contextmenu', handleLiveEditorCtxMenu)

// 目录树空白处右键：在根目录新建 / 刷新
els.fileCatalogue.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return
    e.preventDefault(); e.stopPropagation()
    if (!state.rootPath) return
    showContextMenu(e.clientX, e.clientY, [
        { label: '📄 新建文件（根目录）', action: () => createNewFile(state.rootPath) },
        { label: '📁 新建文件夹（根目录）', action: () => createNewFolder(state.rootPath) },
        { label: '🔀 批量重命名…', action: enterBatchMode },
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

// 标签被移除（重命名/删除）后：把仍指向已移除标签的面板退回相邻标签 / 空白
function fixPanesAfterTabsRemoved() {
    for (let i = 0; i < state.panes.length; i++) {
        const id = state.panes[i].tabId
        if (id && !state.tabs.some((t) => t.id === id)) {
            state.panes[i].tabId = state.tabs.length ? state.tabs[0].id : null
        }
    }
    syncActiveTabId()
}

// 重命名文件 / 文件夹
async function renameItem(item) {
    const newName = await window.prompt('新名称：', item.name)
    if (!newName || newName === item.name) return
    if (!validName(newName)) { alert('名称包含非法字符'); return }
    const newPath = joinPath(parentDir(item.path), newName)
    const res = await window.electronAPI.rename(item.path, newPath)
    if (!res.ok) { alert('重命名失败：' + res.error); return }
    // 关闭指向旧路径的标签（重命名后路径变了）
    state.tabs = state.tabs.filter((t) => t.path !== item.path)
    fixPanesAfterTabsRemoved()   // 分屏面板里若显示被改名文件，退回相邻标签 / 空白
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
    fixPanesAfterTabsRemoved()   // 分屏面板里若显示被删文件，退回相邻标签 / 空白
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
// Git 集成（#10）：树内脏文件标记 + 变更面板（暂存 / 差异 / 提交）
// ================================================================

// 加载工作区 Git 状态：git:status + git:branch + git:remote
// → state.gitStatus（绝对路径 → 徽章字母）+ 远程信息
async function loadGitStatus() {
    if (!state.rootPath) return
    state.gitStatus = {}
    state.gitIsRepo = false
    state.gitRemote = null
    const [s, b, r] = await Promise.all([
        window.electronAPI.gitStatus(state.rootPath),
        window.electronAPI.gitBranch(state.rootPath),
        window.electronAPI.gitRemote(state.rootPath),
    ])
    if (s.ok) {
        state.gitIsRepo = true
        for (const e of s.entries) {
            const abs = joinPath(state.rootPath, e.rel.split('/').join('\\'))
            state.gitStatus[abs] = e.badge
        }
        state.gitBranchName = b.ok ? b.branch : ''
        if (r.ok && r.remotes && r.remotes.length) {
            state.gitRemote = r.remotes[0]   // 取第一个远程（通常 origin）
        }
    }
    applyGitBadges()
    renderGitRemote()
    if (!els.gitPanel.classList.contains('hidden')) renderGitPanel()
}

// 渲染远程仓库状态栏
function renderGitRemote() {
    if (!els.gitRemoteInfo) return
    if (!state.gitIsRepo) {
        els.gitRemoteInfo.textContent = '非 Git 仓库'
        els.gitRemoteInfo.classList.remove('linked')
        return
    }
    if (state.gitRemote) {
        els.gitRemoteInfo.textContent = '远程：' + state.gitRemote.name + ' → ' + (state.gitRemote.url || state.gitRemote.push || '')
        els.gitRemoteInfo.classList.add('linked')
    } else {
        els.gitRemoteInfo.textContent = '远程：未配置（点"🔗 链接远程"连接 GitHub 等仓库）'
        els.gitRemoteInfo.classList.remove('linked')
    }
}

// 链接远程仓库：输入 GitHub 仓库地址（origin 已存在则更换）
async function linkGitRemote() {
    const url = await window.prompt('输入远程仓库地址（GitHub 等）：\n如 https://github.com/用户名/仓库.git', 'https://github.com/')
    if (!url) return
    const res = await window.electronAPI.gitSetRemote(state.rootPath, 'origin', url)
    if (!res.ok) { showGitError('链接远程失败：' + (res.error || '')); return }
    await loadGitStatus()
    showGitInfo('✅ 已链接远程仓库：' + url)
}

// 推送到远程（首次自动设置上游分支）
async function doGitPush() {
    if (!state.gitRemote) {
        showGitInfo('⚠ 尚未配置远程仓库，先点"🔗 链接远程"')
        return
    }
    els.gitPushBtn.disabled = true
    els.gitPushBtn.textContent = '推送中…'
    const res = await window.electronAPI.gitPush(state.rootPath, state.gitBranchName)
    els.gitPushBtn.disabled = false
    els.gitPushBtn.textContent = '⬆ 推送'
    if (!res.ok) { showGitError('推送失败：' + (res.error || '')); return }
    showGitInfo('✅ 已推送到 ' + state.gitRemote.name + '/' + state.gitBranchName)
}

// 从远程拉取
async function doGitPull() {
    if (!state.gitRemote) {
        showGitInfo('⚠ 尚未配置远程仓库，先点"🔗 链接远程"')
        return
    }
    els.gitPullBtn.disabled = true
    els.gitPullBtn.textContent = '拉取中…'
    const res = await window.electronAPI.gitPull(state.rootPath)
    els.gitPullBtn.disabled = false
    els.gitPullBtn.textContent = '⬇ 拉取'
    if (!res.ok) { showGitError('拉取失败：' + (res.error || '')); return }
    showGitInfo('✅ 已从远程拉取')
    await loadGitStatus()
    renderGitPanel()
}

// 给已在 DOM 中的树行同步 git 徽章（懒加载的新行由 renderItems 直接带徽章）
function applyGitBadges() {
    document.querySelectorAll('.tree-row[data-path]').forEach((row) => {
        row.querySelectorAll('.git-badge').forEach((b) => b.remove())
        const code = state.gitStatus[row.dataset.path]
        if (!code) return
        const g = document.createElement('span')
        g.className = 'git-badge b-' + code
        g.textContent = code
        g.title = 'Git 状态：' + code
        row.appendChild(g)
    })
}

// 打开 Git 变更面板（主区视图）
async function openGitPanel() {
    hideAllStates()
    await loadGitStatus()   // 面板未显示前先取状态，避免 loadGitStatus 内部重复渲染
    els.gitPanel.classList.remove('hidden')
    renderGitPanel()
}

// 渲染面板：分支 + 变更列表（checkbox 暂存）+ 状态区
async function renderGitPanel() {
    els.gitDiff.classList.add('hidden')
    els.gitFiles.innerHTML = ''
    els.gitCount.textContent = '0'
    if (!state.gitIsRepo) {
        els.gitBranch.textContent = '非 Git 仓库'
        els.gitFiles.innerHTML = '<div class="gitEmpty">当前文件夹不是 Git 仓库<br><button id="gitInitBtn">初始化仓库</button></div>'
        const initBtn = document.getElementById('gitInitBtn')
        if (initBtn) initBtn.addEventListener('click', doGitInit)
        updateGitCommitBtn()
        return
    }
    els.gitBranch.textContent = state.gitBranchName || '—'
    const res = await window.electronAPI.gitStatus(state.rootPath)
    if (!res.ok) {
        els.gitFiles.innerHTML = '<div class="gitEmpty">获取状态失败：' + escapeHtml(res.error || '') + '</div>'
        updateGitCommitBtn()
        return
    }
    const entries = res.entries
    els.gitCount.textContent = entries.length
    if (entries.length === 0) {
        els.gitFiles.innerHTML = '<div class="gitEmpty">工作区干净，没有变更 ✓</div>'
        updateGitCommitBtn()
        return
    }
    entries.forEach((e) => {
        const staged = e.xy[0] !== ' ' && e.xy[0] !== '?'   // index 列非空 = 已暂存
        const row = document.createElement('div')
        row.className = 'gitFileRow' + (staged ? ' staged' : '')
        row.title = e.rel
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = staged
        cb.addEventListener('change', () => toggleStage(e, cb))
        const badge = document.createElement('span')
        badge.className = 'git-badge b-' + e.badge
        badge.textContent = e.badge
        const rel = document.createElement('span')
        rel.className = 'gitRelPath'
        rel.textContent = e.rel
        const tag = document.createElement('span')
        tag.className = 'gitStageTag'
        tag.textContent = '✓ 已暂存'
        row.append(cb, badge, rel, tag)
        row.addEventListener('click', (ev) => {
            if (ev.target === cb) return
            showGitDiff(e, row)
        })
        els.gitFiles.appendChild(row)
    })
    updateGitCommitBtn()
}

// 暂存 / 取消暂存单个文件，然后刷新列表与树徽章
async function toggleStage(e, cb) {
    const res = cb.checked
        ? await window.electronAPI.gitStage(state.rootPath, e.rel)
        : await window.electronAPI.gitUnstage(state.rootPath, e.rel)
    if (!res.ok) {
        alert('操作失败：' + (res.error || ''))
        cb.checked = !cb.checked
        return
    }
    await loadGitStatus()
    renderGitPanel()
}

// 查看单文件差异（git diff HEAD，包含已暂存 + 未暂存 vs HEAD）
async function showGitDiff(e, rowEl) {
    els.gitFiles.querySelectorAll('.gitFileRow').forEach((r) => r.classList.remove('active'))
    if (rowEl) rowEl.classList.add('active')
    els.gitDiff.classList.remove('hidden')
    if (e.badge === 'U') {
        els.gitDiff.innerHTML = '<div class="gitEmpty">未跟踪文件：暂存（勾选）后在差异区可见内容变化</div>'
        return
    }
    const res = await window.electronAPI.gitDiff(state.rootPath, e.rel)
    if (!res.ok) {
        els.gitDiff.innerHTML = '<div class="gitEmpty">差异获取失败：' + escapeHtml(res.error || '') + '</div>'
        return
    }
    els.gitDiff.innerHTML = renderDiffHtml(res.diff || '(无差异)')
}

// 统一 diff 文本 → 带行着色的 HTML（+ 绿 / - 红 / @@ 蓝 / 其余灰）
function renderDiffHtml(diffText) {
    const lines = String(diffText || '').split('\n')
    return lines.map((line) => {
        let cls = 'd-meta'
        if (line.startsWith('@@')) cls = 'd-hunk'
        else if (line.startsWith('+')) cls = 'd-add'
        else if (line.startsWith('-')) cls = 'd-del'
        return '<div class="' + cls + '">' + escapeHtml(line) + '</div>'
    }).join('')
}

// 提交：未勾选任何文件时自动"暂存全部"再提交（新手友好，写说明即可提交）；
// 勾选了部分文件则只提交勾选部分。错误在面板内联显示，不打断操作。
async function doGitCommit() {
    const msg = els.gitMsgInput.value.trim()
    if (!msg) return
    const anyStaged = els.gitFiles.querySelector('.gitFileRow.staged') !== null
    if (!anyStaged) {
        const stageRes = await window.electronAPI.gitStageAll(state.rootPath)
        if (!stageRes.ok) {
            showGitError('自动暂存失败：' + (stageRes.error || ''))
            return
        }
    }
    const res = await window.electronAPI.gitCommit(state.rootPath, msg)
    if (!res.ok) {
        showGitError('提交失败：' + (res.error || ''))
        return
    }
    els.gitMsgInput.value = ''
    await loadGitStatus()
    renderGitPanel()
}

// 提交错误内联展示在差异区（比 alert 更直观，且不打断）
function showGitError(text) {
    els.gitDiff.classList.remove('hidden')
    els.gitDiff.innerHTML = '<div class="gitEmpty">⚠ ' + escapeHtml(text) + '</div>'
}

// 成功 / 提示信息同样内联展示
function showGitInfo(text) {
    els.gitDiff.classList.remove('hidden')
    els.gitDiff.innerHTML = '<div class="gitEmpty">' + escapeHtml(text) + '</div>'
}

// 初始化仓库
async function doGitInit() {
    const res = await window.electronAPI.gitInit(state.rootPath)
    if (!res.ok) { alert('初始化失败：' + (res.error || '')); return }
    await loadGitStatus()
    renderGitPanel()
}

// 提交按钮可用性：有变更（存在文件行）且消息非空即可用——
// 是否暂存不影响可点性（未暂存时提交会自动暂存全部）
function updateGitCommitBtn() {
    const hasChanges = els.gitFiles.querySelector('.gitFileRow') !== null
    els.gitCommitBtn.disabled = !(hasChanges && els.gitMsgInput.value.trim())
}

els.gitBtn.addEventListener('click', openGitPanel)
els.gitCloseBtn.addEventListener('click', () => { els.gitPanel.classList.add('hidden'); renderActiveFile() })
els.gitRefreshBtn.addEventListener('click', async () => { await loadGitStatus(); renderGitPanel() })
els.gitCommitBtn.addEventListener('click', doGitCommit)
els.gitLinkRemoteBtn.addEventListener('click', linkGitRemote)
els.gitPushBtn.addEventListener('click', doGitPush)
els.gitPullBtn.addEventListener('click', doGitPull)
els.gitMsgInput.addEventListener('input', updateGitCommitBtn)
els.gitMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (!els.gitCommitBtn.disabled) doGitCommit()
    }
})

// ================================================================
// 快速切换器（Ctrl+P）
// ================================================================

function openQuickSwitcher() {
    if (!state.rootPath) return
    closeCommandPalette()   // 与命令面板互斥，避免双浮层叠加
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
    { id: 'file.batchRename', label: '批量重命名', when: () => !!state.rootPath, run: enterBatchMode },
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
    { id: 'ai.open', label: '打开 AI 助手', run: openAiPanel },
    { id: 'graph.open', label: '打开知识图谱', when: () => !!state.rootPath, run: openGraph },
    { id: 'plugins.reload', label: '重新加载插件', when: () => !!state.rootPath, run: () => { PluginManager.load(state.rootPath); showNotice('插件已重新加载') } },
    { id: 'plugins.store', label: '打开插件商店', run: () => window.PluginStore.open() },
    { id: 'help.open', label: '打开使用帮助', run: openHelp },
    { id: 'app.settings', label: '设置', run: openSettings },
]

let cpFiltered = []   // 当前过滤后的命令
let cpIndex = 0       // 当前高亮索引

function openCommandPalette() {
    closeQuickSwitcher()   // 与快速切换器互斥，避免双浮层叠加
    els.commandPalette.classList.remove('hidden')
    els.cpInput.value = ''
    els.cpInput.focus()
    renderCommands('')
}

function closeCommandPalette() {
    els.commandPalette.classList.add('hidden')
}

// 过滤 + 渲染命令列表（label 匹配关键词）；插件命令动态合并（#14）
function renderCommands(q) {
    const query = (q || '').toLowerCase()
    const pluginCmds = PluginManager.commands().map((c) => ({
        id: 'plugin.' + c.id,
        label: '🧩 ' + c.label,
        pluginCmd: c,
        run: () => PluginManager.runCommand(c),
    }))
    cpFiltered = COMMANDS.concat(pluginCmds)
        .filter((c) => (!c.when || c.when()) && c.label.toLowerCase().includes(query))
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
// 主题切换（C：亮色 / 暗色 / 跟随系统）
// ================================================================

const THEME_MODE_KEY = 'emerald-theme-mode'

// 计算有效主题：跟随系统时读 prefers-color-scheme
function effectiveTheme() {
    if (state.themeMode === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return state.themeMode === 'dark' ? 'dark' : 'light'
}

function applyTheme(mode) {
    state.themeMode = mode || state.themeMode || 'light'
    const eff = effectiveTheme()
    state.theme = eff
    // 日月图标显隐由 CSS（:root[data-theme]）处理，这里只切主题变量
    document.documentElement.dataset.theme = eff
}

// 手动切换 = 切到当前有效主题的反面，并转为手动模式
function toggleTheme() {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark')
    localStorage.setItem(THEME_MODE_KEY, state.themeMode)
}

// 系统主题变化时自动跟随
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.themeMode === 'system') applyTheme('system')
})

// ================================================================
// 状态栏
// ================================================================

function updateStatusBar() {
    const f = state.currentFile
    if (f && f.path) {
        els.statusLeft.textContent = '📄 ' + f.path
        els.statusCenter.textContent = state.tabs.length + ' 个标签 · '
            + (state.viewMode === 'preview' ? '👁 预览' : '✏️ 编辑')   // F1：模式图标
        // B：字数统计（字符数 / 行数）
        const totalLines = f.content.split('\n').length
        els.statusRight.textContent = '行 ' + state.cursorLine + ' · 列 ' + state.cursorCol
            + ' · ' + f.content.length + ' 字符 · ' + totalLines + ' 行 · UTF-8'
    } else {
        els.statusLeft.textContent = '就绪'
        if (state.rootPath) els.statusCenter.textContent = els.statusCenter.textContent || '工作区已打开'
        els.statusRight.textContent = '行 ' + state.cursorLine + ' · 列 ' + state.cursorCol + ' · UTF-8'
    }
}

// 光标位置跟踪（文本编辑时实时刷新状态栏右段，作用于活动面板文本框）
function updateCursorPos() {
    const el = curEditor()
    if (!el) return
    const pos = el.selectionStart
    lastCaretPos = pos   // 记录源偏移（供插件插入定位）
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
    els.tooltip.style.transform = 'none'   // 文件树场景：左上角定位，不带居中偏移
    const px = Math.min(x + 14, window.innerWidth - 280)
    const py = Math.min(y + 16, window.innerHeight - 44)
    els.tooltip.style.left = Math.max(4, px) + 'px'
    els.tooltip.style.top = Math.max(4, py) + 'px'
    tooltipVisible = true
}
// 按钮正下方居中显示 tooltip（标题栏图标等场景）：跟随按钮位置，不被窗口钳制到同一处
function showTooltipBelow(el, text) {
    els.tooltip.textContent = text
    els.tooltip.classList.remove('hidden')
    els.tooltip.style.transform = 'translateX(-50%)'
    const r = el.getBoundingClientRect()
    const left = Math.max(12, Math.min(r.left + r.width / 2, window.innerWidth - 12))
    const top = Math.max(4, r.bottom + 6)
    els.tooltip.style.left = left + 'px'
    els.tooltip.style.top = top + 'px'
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
    const i = state.activePane
    const f = state.currentFile
    if (!f || !f.path) return   // 空白标签没有可预览的内容
    const pane = state.panes[i]
    pane.viewMode = pane.viewMode === 'preview' ? 'edit' : 'preview'
    state.viewMode = pane.viewMode   // 同步全局（状态栏 / 会话）
    updateViewModeBtn(i)
    if (pane.viewMode === 'preview') showPanePreview(i)
    else showPaneEditorInput(i)
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
// 查找 / 替换（Ctrl+F）：基于 f.content 统一计算匹配，
// 文本框模式 → 选区导航；所见即所得模式 → 滚动定位到对应块
// ================================================================

const findState = {
    query: '',
    caseSensitive: false,
    matches: [],   // [{ start, end, line }]（0-based 行）
    index: -1,
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 打开 / 聚焦查找条；打开前把活动面板文本框内容同步为 f.content
function openFindBar() {
    if (!state.currentFile) return
    if (els.editorPane.classList.contains('hidden')) return   // 编辑器不可见（Git/AI/图谱面板）时不打开，避免焦点投到隐藏元素
    els.findBar.classList.remove('hidden')
    curPaneEls().editor.value = state.currentFile.content   // 同步（实时编辑模式下文本框可能过期）
    els.findInput.focus()
    els.findInput.select()
    runFind()
}

function closeFindBar() {
    els.findBar.classList.add('hidden')
    els.findInput.blur()
    findState.matches = []
    findState.index = -1
    els.findCount.textContent = '0/0'
}

// 重新计算匹配并定位到第一个
function runFind() {
    const f = state.currentFile
    findState.query = els.findInput.value
    findState.matches = []
    findState.index = -1
    if (!f || !findState.query) {
        els.findCount.textContent = '0/0'
        return
    }
    const hay = f.content
    const q = findState.query
    const hayLower = findState.caseSensitive ? hay : hay.toLowerCase()
    const qLower = findState.caseSensitive ? q : q.toLowerCase()
    let from = 0
    while (from <= hay.length) {
        const idx = hayLower.indexOf(qLower, from)
        if (idx === -1) break
        const line = hay.slice(0, idx).split('\n').length - 1
        findState.matches.push({ start: idx, end: idx + q.length, line })
        from = idx + q.length
    }
    navigateMatch(0)
}

// 跳到第 delta 个匹配（0 表示第一个；-1 表示最后一个）
function navigateMatch(delta) {
    const n = findState.matches.length
    if (n === 0) {
        els.findCount.textContent = '0/0'
        return
    }
    if (delta === 0) findState.index = 0
    else findState.index = (findState.index + delta + n) % n
    const m = findState.matches[findState.index]
    els.findCount.textContent = (findState.index + 1) + '/' + n
    const f = state.currentFile
    if (!f) return
    const P = curPaneEls()
    // 所见即所得模式：滚动到包含该行的渲染块
    if (isMarkdown(f.name) && !P.liveEditor.classList.contains('hidden')) {
        const blk = [...P.liveEditor.querySelectorAll('.blk[data-s]')]
            .find((b) => parseInt(b.dataset.s, 10) <= m.line && parseInt(b.dataset.e, 10) >= m.line)
        if (blk) {
            blk.scrollIntoView({ block: 'center' })
            blk.classList.add('flash')
            setTimeout(() => blk.classList.remove('flash'), 900)
        }
        return
    }
    // 文本框模式：选区 + 滚动
    P.editor.setSelectionRange(m.start, m.end)
    const caretLine = m.line
    P.editor.scrollTop = Math.max(0, (caretLine - 3) * 21)
    P.editor.focus()
    state.cursorLine = caretLine + 1
    state.cursorCol = m.start - (f.content.lastIndexOf('\n', m.start - 1) + 1) + 1
    updateStatusBar()
}

// 替换当前匹配
function replaceCurrent() {
    const f = state.currentFile
    if (!f || findState.index < 0 || findState.index >= findState.matches.length) return
    const m = findState.matches[findState.index]
    const rep = els.replaceInput.value
    f.content = f.content.slice(0, m.start) + rep + f.content.slice(m.end)
    syncContentViews()
    runFind()
    navigateMatch(1)   // 跳到下一处
}

// 全部替换
function replaceAll() {
    const f = state.currentFile
    if (!f || !findState.query) return
    const flags = findState.caseSensitive ? 'g' : 'gi'
    const re = new RegExp(escapeRegExp(findState.query), flags)
    f.content = f.content.replace(re, els.replaceInput.value)
    syncContentViews()
    runFind()
}

// 替换后同步各视图（活动面板文本框值 / 实时编辑器重渲染 + 脏状态）
function syncContentViews() {
    const f = state.currentFile
    if (!f) return
    const P = curPaneEls()
    P.editor.value = f.content
    if (!P.liveEditor.classList.contains('hidden')) renderLiveEditor(state.activePane)
    updateSaveStatus(state.activePane)
    renderTabs()
}

els.findInput.addEventListener('input', runFind)
els.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigateMatch(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindBar() }
})
els.replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceCurrent() }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindBar() }
})
els.findNext.addEventListener('click', () => navigateMatch(1))
els.findPrev.addEventListener('click', () => navigateMatch(-1))
els.findCase.addEventListener('click', () => {
    findState.caseSensitive = !findState.caseSensitive
    els.findCase.classList.toggle('active', findState.caseSensitive)
    runFind()
})
els.replaceOne.addEventListener('click', replaceCurrent)
els.replaceAll.addEventListener('click', replaceAll)
els.findClose.addEventListener('click', closeFindBar)

// ================================================================
// 批量重命名（#15）：批量选择模式 + 序号 / 正则重命名
// ================================================================

// 进入批量选择模式：点击树行 = 选择/取消，不再打开文件
function enterBatchMode() {
    if (!state.rootPath) return
    state.batchMode = true
    state.batchSelection = []
    els.batchBar.classList.remove('hidden')
    updateBatchBar()
}

// 退出批量选择模式
function exitBatchMode() {
    state.batchMode = false
    state.batchSelection = []
    els.batchBar.classList.add('hidden')
    document.querySelectorAll('.tree-row.batch-selected').forEach((r) => r.classList.remove('batch-selected'))
}

// 批量模式下点击行：切换选中
function toggleBatchSelect(item, row) {
    const idx = state.batchSelection.indexOf(item.path)
    if (idx === -1) state.batchSelection.push(item.path)
    else state.batchSelection.splice(idx, 1)
    row.classList.toggle('batch-selected', idx === -1)
    updateBatchBar()
}

function updateBatchBar() {
    els.batchCount.textContent = state.batchSelection.length
    els.batchRenameBtn.disabled = state.batchSelection.length === 0
}

// 打开重命名对话框（预览 + 校验）
function openBatchRenameDialog() {
    if (state.batchSelection.length === 0) return
    els.batchDialogOverlay.classList.remove('hidden')
    buildRenamePlan()
}

// 依据当前输入计算重命名计划，渲染预览并校验（非法时禁用执行按钮）
function buildRenamePlan() {
    const mode = document.querySelector('input[name="brMode"]:checked').value
    const files = state.batchSelection.map((p) => ({ oldPath: p, dir: parentDir(p), name: basename(p) }))
    const plan = files.map((f, i) => {
        const dot = f.name.lastIndexOf('.')
        const ext = dot === -1 ? '' : f.name.slice(dot + 1)
        const base = dot === -1 ? f.name : f.name.slice(0, dot)
        let newBase = ''
        if (mode === 'seq') {
            const tpl = els.brTemplate.value
            const n = parseInt(els.brStart.value || '1', 10) + i
            const digits = Math.max(1, parseInt(els.brDigits.value || '1', 10))
            newBase = tpl.replace(/\{n\}/g, String(n).padStart(digits, '0')).replace(/\{name\}/g, base)
        } else {
            try {
                newBase = base.replace(new RegExp(els.brFind.value), els.brReplace.value)
            } catch { newBase = '' }
        }
        if (!newBase || !newBase.trim()) return null
        // 扩展名自动保留；模板已带相同扩展名则不重复追加
        const newName = ext && !newBase.toLowerCase().endsWith('.' + ext.toLowerCase())
            ? newBase + '.' + ext
            : newBase
        return { oldPath: f.oldPath, dir: f.dir, oldName: f.name, newName, newPath: joinPath(f.dir, newName) }
    }).filter(Boolean)

    // 校验：非法字符 / 新名与原名相同 / 批次内重名
    const errors = []
    const seen = new Map()
    for (const p of plan) {
        if (!validName(p.newName)) errors.push('「' + p.oldName + '」→「' + p.newName + '」名称含非法字符')
        else if (p.newPath === p.oldPath) errors.push('「' + p.oldName + '」新名与原名相同')
        else if (seen.has(p.newPath)) errors.push('「' + p.oldName + '」与「' + seen.get(p.newPath) + '」重名')
        else seen.set(p.newPath, p.oldName)
    }

    els.brPreview.innerHTML = plan.length
        ? plan.map((p) => '<div class="brRow-old">' + escapeHtml(p.oldName) + '</div><div class="brRow-new">→ ' + escapeHtml(p.newName) + '</div>').join('')
        : '<div class="brRow-bad">（没有有效结果，请检查输入）</div>'
    els.brErr.textContent = errors.slice(0, 3).join('；')
    els.brOk.disabled = errors.length > 0 || plan.length === 0
    return plan
}

// 执行重命名（按顺序逐个 rename，失败即停）
async function doBatchRename() {
    if (els.brOk.disabled) return
    const plan = buildRenamePlan()
    if (!plan || plan.length === 0) return
    const ok = await window.confirm('确定重命名 ' + plan.length + ' 个文件？')
    if (!ok) return
    for (const p of plan) {
        const res = await window.electronAPI.rename(p.oldPath, p.newPath)
        if (!res.ok) {
            alert('重命名「' + p.oldName + '」失败：' + res.error)
            break
        }
    }
    els.batchDialogOverlay.classList.add('hidden')
    exitBatchMode()
    await loadRoot()   // 重建目录树（徽章/标签随之刷新）
}

els.batchDoneBtn.addEventListener('click', exitBatchMode)
els.batchRenameBtn.addEventListener('click', openBatchRenameDialog)
document.querySelectorAll('input[name="brMode"]').forEach((r) => r.addEventListener('change', () => {
    els.brSeqPanel.classList.toggle('hidden', r.value !== 'seq')
    els.brRePanel.classList.toggle('hidden', r.value !== 're')
    buildRenamePlan()
}))
;[els.brTemplate, els.brStart, els.brDigits, els.brFind, els.brReplace].forEach((el) => el.addEventListener('input', buildRenamePlan))
els.brCancel.addEventListener('click', () => els.batchDialogOverlay.classList.add('hidden'))
els.brOk.addEventListener('click', doBatchRename)
els.batchDialogOverlay.addEventListener('click', (e) => {
    if (e.target === els.batchDialogOverlay) els.batchDialogOverlay.classList.add('hidden')
})

// ================================================================
// AI 助手（#12，BYO-Key）：配置（safeStorage 加密）+ 流式对话
// ================================================================

// 预置供应商：baseUrl + 常用模型列表（以各供应商官方当前在售模型为准，2025 年末核校）
const AI_PRESETS = {
    deepseek: {
        label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat',
        // 官方 API 仅 deepseek-chat（DeepSeek-V3 系列）与 deepseek-reasoner（R1），并无 v4
        models: ['deepseek-chat', 'deepseek-reasoner'],
        hint: 'DeepSeek 官方 API（OpenAI 兼容）。官方模型为 deepseek-chat（V3 系列）与 deepseek-reasoner（R1），无 v4。Key 将加密保存。',
    },
    openai: {
        label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o3'],
        hint: 'OpenAI 官方 API（OpenAI 兼容）。Key 将用系统安全存储加密后落盘，不会明文保存。',
    },
    anthropic: {
        label: 'Claude（Anthropic）', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-5',
        models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
        hint: 'Claude 使用 Anthropic Messages API（x-api-key 鉴权，应用内已适配）。Key 将加密保存。',
    },
    gemini: {
        label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
        hint: 'Gemini 的 OpenAI 兼容端点。Key 将用系统安全存储加密后落盘，不会明文保存。',
    },
    moonshot: {
        label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k2-turbo-preview',
        models: ['kimi-k2-turbo-preview', 'kimi-k2-0711-preview', 'moonshot-v1-32k', 'moonshot-v1-8k', 'moonshot-v1-128k'],
        hint: 'Kimi 官方 API（OpenAI 兼容），含 kimi-k2 系列与 moonshot-v1 系列。Key 将加密保存。',
    },
    zhipu: {
        label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6',
        models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash', 'glm-4-plus'],
        hint: '智谱 AI 开放平台（OpenAI 兼容），当前为 GLM-4.6 / GLM-4.5 系列。Key 将加密保存。',
    },
    qwen: {
        label: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3-plus',
        models: ['qwen3-max', 'qwen3-plus', 'qwen3-flash', 'qwen-long', 'qwen-plus'],
        hint: '阿里云百炼 DashScope 的 OpenAI 兼容端点，当前为 Qwen3 系列。Key 将加密保存。',
    },
    groq: {
        label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
        hint: 'Groq 极速推理（OpenAI 兼容）。Key 将用系统安全存储加密后落盘，不会明文保存。',
    },
    ollama: {
        label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', defaultModel: '',
        models: [],
        hint: '本地 Ollama 通常无需 Key（留空即可），模型名需已 pull，如 qwen2.5。',
    },
    custom: {
        label: '自定义', baseUrl: '', defaultModel: '',
        models: [],
        hint: '任意 OpenAI 兼容端点：填入完整 baseUrl 与模型名。',
    },
}

// 对话模式：选择后注入对应系统提示词（主流的网页版 agent 交互）
const AI_MODE_META = {
    chat: { label: '普通对话', icon: '💬' },
    quiz: { label: '出题目', icon: '📝' },
    viz: { label: '可视化制作', icon: '📊' },
    research: { label: '研究', icon: '🔬' },
}
const AI_MODE_PROMPTS = {
    chat: null,
    quiz: '你现在是「出题助手」，根据用户给出的主题或笔记内容出一组练习题。\n'
        + '输出要求（严格遵守）：\n'
        + '1) 第一行先输出标记 <<<QUIZ>>>\n'
        + '2) 紧接着输出一个 JSON 数组（不要 Markdown 代码围栏，不要其它文字），每个题目对象格式：\n'
        + '   {"q":"题目","options":["选项A","选项B","选项C","选项D"],"answer":0,"explain":"答案解析"}\n'
        + '   其中 answer 为正确选项的索引（从 0 开始）。\n'
        + '3) 出 4~6 题，覆盖核心概念，难度循序渐进；题目语言与用户一致（默认中文）。',
    viz: '你现在是「数据可视化制作助手」，根据用户的需求生成 SVG 图表或示意图。\n'
        + '输出要求（严格遵守）：\n'
        + '1) 第一行先输出标记 <<<SVG>>>\n'
        + '2) 紧接着输出完整、可独立渲染的 SVG 代码（<svg> 到 </svg>，不要 Markdown 代码围栏，不要其它文字）。\n'
        + '3) 使用以翡翠绿 #10b981 为主的协调配色、清晰的标题与坐标轴、合适的 viewBox，尺寸建议 800×480。\n'
        + '4) 不要包含任何脚本、外部引用或 foreignObject。',
    research: '你现在是「研究分析助手」，针对用户的问题做结构化研究分析。\n'
        + '输出要求：\n'
        + '1) 用 Markdown 结构输出：## 概述 → ## 关键发现（要点列表）→ ## 详细分析 → ## 结论与建议。\n'
        + '2) 区分「已知事实」与「推测」，不确定之处明确标注；涉及数据时给出大致范围而非编造精确数字。\n'
        + '3) 语言与用户一致（默认中文）。',
}

let aiConversation = []   // [{ role, content }]（当前会话的消息）
let aiStreaming = false
let aiCtxOn = true        // 默认自动附上当前文件作为上下文
let aiMode = 'chat'       // 当前对话模式（chat / quiz / viz / research）
let aiSel = null          // 文本框模式捕获的选区 { start, end }（偏移基于 \n 归一化内容）
let aiSelText = null      // 所见即所得模式捕获的渲染选中文本（无源偏移，直接用文本）
let aiCurrent = { provider: 'deepseek', baseUrl: '', model: '' }   // 当前生效的供应商 / 模型（模型切换按钮用）
let aiKeySetMap = {}      // 各供应商是否已保存 Key（{ provider: true }）
let aiConvos = []         // 会话列表元信息 [{ id, title, updatedAt, count }]
let aiConvoId = null      // 当前会话 id
let aiConvoSaveTimer = null   // 会话防抖保存

// 捕获当前选中：必须在隐藏编辑器之前调用（display:none 会清空两者）。
// 所见即所得模式优先读渲染 DOM 选区；文本框模式读 textarea 选区。
function captureAiSelection() {
    const f = state.currentFile
    const P = curPaneEls()
    aiSel = null
    aiSelText = null
    if (!f || !f.path) return
    // 所见即所得模式：渲染视图中的 DOM 选区（用户拖选可见文字）
    if (P.liveEditor && !P.liveEditor.classList.contains('hidden')) {
        const sel = window.getSelection()
        if (sel && sel.toString().trim() && sel.anchorNode && P.liveEditor.contains(sel.anchorNode)) {
            aiSelText = sel.toString()
        }
        return
    }
    // 文本框模式：textarea 选区（其 value 只做换行归一化 \r\n→\n，Chromium 保留末尾换行）
    const ed = P.editor
    if (ed) {
        const normContent = f.content.replace(/\r\n/g, '\n')
        if (ed.value === normContent) {
            const s = ed.selectionStart
            const e = ed.selectionEnd
            if (e > s) aiSel = { start: s, end: e }
        }
    }
}

function openAiPanel(skipCapture) {
    if (skipCapture !== true) captureAiSelection()   // 面板打开会隐藏编辑器，先捕获选中（注意：事件对象不能当 true）
    hideAllStates()
    els.aiPanel.classList.remove('hidden')
    updateAiCtxStatus()
    loadAiCurrent()
    loadAiConvos()
    els.aiInput.focus()
}

function closeAiPanel() {
    if (aiStreaming) window.electronAPI.aiAbort()
    flushAiConvoSave()   // 关闭面板前落盘当前会话
    els.aiPanel.classList.add('hidden')
    renderActiveFile()   // 恢复之前的视图（编辑器 / 空状态）
}

// ================================================================
// 会话记忆：多会话持久化（主进程 userData 落盘）+ 左侧会话栏管理
// ================================================================

// 欢迎消息（仅 UI 提示，不写入会话）
function aiWelcomeEl() {
    const w = document.createElement('div')
    w.className = 'ai-msg ai-msg-assistant ai-msg-welcome'
    const t = document.createElement('div')
    t.className = 'ai-msg-text'
    t.textContent = '你好！我是你的 Emerald AI 助手 💎。点右上角 ⚙ 配置 API Key（DeepSeek / OpenAI / Claude / 通义千问 等均可），或直接用下方按钮切换模型。当前打开的笔记内容会自动作为提问上下文（选中文本时优先用选中内容），直接提问即可。'
    w.appendChild(t)
    return w
}

// 加载会话列表 + 活动会话内容（打开面板 / 启动时调用）
async function loadAiConvos() {
    try {
        const r = await window.electronAPI.aiConvosList()
        aiConvos = r.conversations || []
        // 无会话 → 自动建一个
        if (!aiConvoId || !aiConvos.some((c) => c.id === aiConvoId)) {
            if (r.activeId && aiConvos.some((c) => c.id === r.activeId)) aiConvoId = r.activeId
            else if (aiConvos.length) aiConvoId = aiConvos[aiConvos.length - 1].id
            else {
                const c = await window.electronAPI.aiConvoCreate()
                if (c.ok) {
                    aiConvoId = c.id
                    const list = await window.electronAPI.aiConvosList()
                    aiConvos = list.conversations || []
                }
            }
        }
        renderAiSessionList()
        if (aiConvoId) {
            const loaded = await window.electronAPI.aiConvoLoad(aiConvoId)
            aiConversation = loaded.messages || []
        } else {
            aiConversation = []
        }
        renderAiMessages()
    } catch { /* 忽略 */ }
}

function renderAiSessionList() {
    if (!els.aiSessionList) return
    els.aiSessionList.innerHTML = ''
    if (!aiConvos.length) {
        els.aiSessionList.innerHTML = '<div class="ai-session-empty">还没有会话<br>点右上角「＋」新建</div>'
        return
    }
    for (const c of aiConvos) {
        const item = document.createElement('div')
        item.className = 'ai-session-item' + (c.id === aiConvoId ? ' active' : '')
        const title = document.createElement('span')
        title.className = 'ai-session-title'
        title.textContent = c.title || '新会话'
        title.title = c.title || '新会话'
        const del = document.createElement('button')
        del.className = 'ai-session-del'
        del.textContent = '✕'
        del.title = '删除会话'
        del.addEventListener('click', (e) => {
            e.stopPropagation()
            deleteAiConvo(c.id)
        })
        item.append(title, del)
        item.addEventListener('click', () => switchAiConvo(c.id))
        els.aiSessionList.appendChild(item)
    }
}

// 渲染当前会话的消息（空会话显示欢迎语）
function renderAiMessages() {
    els.aiMessages.innerHTML = ''
    if (!aiConversation.length) {
        els.aiMessages.appendChild(aiWelcomeEl())
        return
    }
    for (const m of aiConversation) {
        const msg = aiAppendMessage(m.role, m.content, false)
        if (m.role === 'assistant') renderAiRichContent(msg.el, msg.textEl, m.content)
    }
    els.aiMessages.scrollTop = els.aiMessages.scrollHeight
}

// 切换到另一会话（先保存当前，再加载目标）
async function switchAiConvo(id) {
    if (id === aiConvoId) return
    flushAiConvoSave()
    aiConvoId = id
    const r = await window.electronAPI.aiConvoLoad(id)
    aiConversation = r.messages || []
    renderAiSessionList()
    renderAiMessages()
}

// 新建会话
async function newAiConvo() {
    flushAiConvoSave()
    const r = await window.electronAPI.aiConvoCreate()
    if (!r.ok) return
    aiConvoId = r.id
    const list = await window.electronAPI.aiConvosList()
    aiConvos = list.conversations || []
    aiConversation = []
    renderAiSessionList()
    renderAiMessages()
    els.aiInput.focus()
}

// 删除会话（确认后删除；若删除的是当前会话，切到最后一个）
async function deleteAiConvo(id) {
    const ok = await window.confirm('删除该会话？其中的对话记录将无法恢复。')
    if (!ok) return
    const r = await window.electronAPI.aiConvoDelete(id)
    const list = await window.electronAPI.aiConvosList()
    aiConvos = list.conversations || []
    if (id === aiConvoId) {
        aiConvoId = r.activeId
        if (aiConvoId) {
            const loaded = await window.electronAPI.aiConvoLoad(aiConvoId)
            aiConversation = loaded.messages || []
        } else {
            aiConversation = []
        }
    }
    renderAiSessionList()
    renderAiMessages()
}

// 防抖保存当前会话（捕获 id 与消息快照，避免切换后串台）
function scheduleAiConvoSave() {
    const id = aiConvoId
    const snapshot = [...aiConversation]
    clearTimeout(aiConvoSaveTimer)
    aiConvoSaveTimer = setTimeout(() => saveAiConvo(id, snapshot), 400)
}

// 立即保存（切换 / 关闭面板 / 删除前调用）
function flushAiConvoSave() {
    clearTimeout(aiConvoSaveTimer)
    if (aiConvoId) saveAiConvo(aiConvoId, [...aiConversation])
}

async function saveAiConvo(id, messages) {
    if (!id) return
    const msgs = Array.isArray(messages) ? messages : aiConversation
    const firstUser = msgs.find((m) => m.role === 'user')
    const rawTitle = firstUser ? String(firstUser.content || '').replace(/\s+/g, ' ').trim() : ''
    const title = rawTitle ? (rawTitle.length > 16 ? rawTitle.slice(0, 16) + '…' : rawTitle) : '新会话'
    const res = await window.electronAPI.aiConvoSave(id, msgs, title)
    if (res.ok) {
        const item = aiConvos.find((c) => c.id === id)
        if (item) { item.title = title; item.updatedAt = Date.now(); item.count = msgs.length }
        renderAiSessionList()
    }
}

// 构建上下文 system 消息：优先用捕获的选中文本，否则用完整文件内容（截断）
// 选区偏移基于归一化内容（\n），发送前统一归一化
function buildAiContext() {
    const f = state.currentFile
    if (!f || !f.path) return null
    const normalized = f.content.replace(/\r\n/g, '\n')
    let source = normalized
    let mode = '完整内容'
    if (aiSelText) {
        source = aiSelText
        mode = '选中内容'
    } else if (aiSel && aiSel.end > aiSel.start) {
        source = normalized.slice(aiSel.start, aiSel.end)
        mode = '选中内容'
    }
    const MAX = 12000
    const body = source.length > MAX ? source.slice(0, MAX) + '\n…（内容过长已截断）' : source
    return '以下是用户当前打开的文件内容，回答时可参考（文件名：' + f.name
        + '，路径：' + relativeOf(f.path) + '，' + mode + '）：\n\n' + body
}

// 上下文状态条：显示当前会附带的文件 / 关闭状态
function updateAiCtxStatus() {
    if (!els.aiCtxStatus) return
    const f = state.currentFile
    if (!aiCtxOn) {
        els.aiCtxStatus.textContent = '📎 上下文：未附带（点"📎 上下文"开启）'
        els.aiCtxStatus.classList.add('off')
        return
    }
    if (!f || !f.path) {
        els.aiCtxStatus.textContent = '📎 上下文：当前未打开文件，将仅凭问题回答'
        els.aiCtxStatus.classList.add('off')
        return
    }
    const mode = aiSelText
        ? '选中内容（' + aiSelText.length + ' 字符）'
        : (aiSel && aiSel.end > aiSel.start ? '选中内容（' + (aiSel.end - aiSel.start) + ' 字符）' : '完整内容')
    els.aiCtxStatus.textContent = '📎 上下文：' + f.name + '（' + mode + '）'
    els.aiCtxStatus.classList.remove('off')
}

// 渲染一条消息（流式时增量更新文本）
function aiAppendMessage(role, text, streaming) {
    const msg = document.createElement('div')
    msg.className = 'ai-msg ai-msg-' + role + (streaming ? ' streaming' : '')
    const t = document.createElement('div')
    t.className = 'ai-msg-text'
    t.textContent = text
    msg.appendChild(t)
    els.aiMessages.appendChild(msg)
    els.aiMessages.scrollTop = els.aiMessages.scrollHeight
    return { el: msg, textEl: t }
}

// 发送对话：自动附带当前文件上下文（选区优先）+ 对话模式提示词，主进程流式请求
async function aiSend() {
    const text = els.aiInput.value.trim()
    if (!text || aiStreaming) return
    els.aiInput.value = ''
    aiConversation.push({ role: 'user', content: text })
    scheduleAiConvoSave()   // 用户消息即持久化（会话记忆）
    const welcome = els.aiMessages.querySelector('.ai-msg-welcome')
    if (welcome) welcome.remove()   // 首条消息发出后移除欢迎语
    aiAppendMessage('user', text, false)

    const messages = []
    const modePrompt = aiMode !== 'chat' ? AI_MODE_PROMPTS[aiMode] : null
    if (modePrompt) messages.push({ role: 'system', content: modePrompt })
    const ctx = aiCtxOn ? buildAiContext() : null
    if (ctx) messages.push({ role: 'system', content: ctx })
    messages.push(...aiConversation)
    updateAiCtxStatus()

    aiStreaming = true
    els.aiSendBtn.disabled = true
    els.aiAbortBtn.classList.remove('hidden')
    const resp = aiAppendMessage('assistant', '', true)

    const res = await window.electronAPI.aiChat(messages)
    if (!res.ok) {
        resp.el.classList.remove('streaming')
        resp.el.classList.add('ai-msg-error')
        resp.textEl.textContent = '⚠ ' + (res.error || '请求失败')
        aiStreaming = false
        els.aiSendBtn.disabled = false
        els.aiAbortBtn.classList.add('hidden')
        return
    }
}

// 流式回传
window.electronAPI.onAiChunk(({ text }) => {
    const last = els.aiMessages.lastElementChild
    if (last && last.classList.contains('ai-msg-assistant')) {
        const t = last.querySelector('.ai-msg-text')
        t.textContent += text
        els.aiMessages.scrollTop = els.aiMessages.scrollHeight
    }
})

window.electronAPI.onAiDone((d) => {
    aiStreaming = false
    els.aiSendBtn.disabled = false
    els.aiAbortBtn.classList.add('hidden')
    const last = els.aiMessages.lastElementChild
    if (last) last.classList.remove('streaming')
    if (!d || !d.ok) {
        if (last) last.classList.add('ai-msg-error')
    }
    // 把完整回答记入对话（从 DOM 取回，保留原始标记文本）
    if (last) {
        const t = last.querySelector('.ai-msg-text')
        const raw = t.textContent
        aiConversation.push({ role: 'assistant', content: raw })
        scheduleAiConvoSave()   // 会话记忆持久化
        // 富内容渲染：<<<QUIZ>>> 题目卡片 / <<<SVG>>> 内联渲染
        renderAiRichContent(last, t, raw)
    }
})

// ================================================================
// 富内容渲染：出题目（<<<QUIZ>>> + JSON）→ 交互式题目卡片；可视化（<<<SVG>>>）→ 内联 SVG
// ================================================================

// 从消息文本中提取 <<<QUIZ>>> 后的 JSON 数组
function parseQuizJson(text) {
    const idx = String(text || '').indexOf('<<<QUIZ>>>')
    if (idx < 0) return null
    const rest = text.slice(idx + 10)
    const start = rest.indexOf('[')
    if (start < 0) return null
    let depth = 0
    let end = -1
    for (let i = start; i < rest.length; i++) {
        const c = rest[i]
        if (c === '[') depth++
        else if (c === ']') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end < 0) return null
    try {
        const arr = JSON.parse(rest.slice(start, end))
        return Array.isArray(arr) && arr.length ? arr : null
    } catch { return null }
}

// 渲染一道题目卡片（点击选项显示对错与解析）
function renderQuizCard(q, i) {
    const card = document.createElement('div')
    card.className = 'ai-quiz'
    const qEl = document.createElement('div')
    qEl.className = 'ai-quiz-q'
    qEl.textContent = (i + 1) + '. ' + String(q.q || '').trim()
    card.appendChild(qEl)
    const opts = document.createElement('div')
    opts.className = 'ai-quiz-opts'
    const answer = Number(q.answer)
    ;(Array.isArray(q.options) ? q.options : []).forEach((opt, oi) => {
        const row = document.createElement('div')
        row.className = 'ai-quiz-opt'
        row.dataset.idx = oi
        const letter = document.createElement('span')
        letter.className = 'ai-quiz-opt-letter'
        letter.textContent = String.fromCharCode(65 + oi)
        const text = document.createElement('span')
        text.className = 'ai-quiz-opt-text'
        text.textContent = opt
        row.append(letter, text)
        row.addEventListener('click', () => {
            opts.querySelectorAll('.ai-quiz-opt').forEach((r) => {
                const idx = Number(r.dataset.idx)
                r.classList.remove('picked')
                if (idx === answer) r.classList.add('correct')
                else if (idx === oi) r.classList.add('wrong', 'picked')
            })
            reveal.classList.remove('hidden')
            card.classList.add('answered')
        })
        opts.appendChild(row)
    })
    card.appendChild(opts)
    const reveal = document.createElement('div')
    reveal.className = 'ai-quiz-answer hidden'
    const ansLetter = String.fromCharCode(65 + (answer >= 0 ? answer : 0))
    reveal.textContent = (q.explain ? '解析：' + q.explain : '答案：' + ansLetter)
    card.appendChild(reveal)
    return card
}

// 从消息文本中提取 <<<SVG>>> 后的 SVG 源码
function extractSvgCode(text) {
    const s = String(text || '')
    const idx = s.indexOf('<<<SVG>>>')
    if (idx < 0) return null
    let code = s.slice(idx + 9).trim()
    // 截到下一个标记或代码围栏结束
    const nextMarker = code.search(/<<<[A-Z]+>>>/)
    if (nextMarker > 0) code = code.slice(0, nextMarker)
    code = code.replace(/^```svg\s*/i, '').replace(/```\s*$/, '').trim()
    return code || null
}

// 安全渲染 SVG（DOMParser 解析 + 剥离脚本 / 事件属性）
function renderSvgBlock(code) {
    const wrap = document.createElement('div')
    wrap.className = 'ai-svg'
    try {
        const doc = new DOMParser().parseFromString(code, 'image/svg+xml')
        const svg = doc.documentElement
        if (svg && svg.tagName.toLowerCase() === 'svg' && !doc.querySelector('parsererror')) {
            svg.querySelectorAll('script, foreignObject, style').forEach((n) => n.remove())
            ;[...svg.querySelectorAll('*')].forEach((n) => {
                for (const a of [...n.attributes]) {
                    if (/^on/i.test(a.name) || /^(href|xlink:href)$/i.test(a.name)) n.removeAttribute(a.name)
                }
            })
            if (!svg.getAttribute('viewBox') && svg.getAttribute('width') && svg.getAttribute('height')) {
                svg.setAttribute('viewBox', '0 0 ' + svg.getAttribute('width') + ' ' + svg.getAttribute('height'))
            }
            svg.setAttribute('width', '100%')
            svg.setAttribute('height', 'auto')
            wrap.appendChild(svg)
            const bar = document.createElement('div')
            bar.className = 'ai-svg-bar'
            const hint = document.createElement('span')
            hint.textContent = '🖼 已渲染 SVG'
            const copy = document.createElement('button')
            copy.type = 'button'
            copy.className = 'ai-svg-copy'
            copy.textContent = '复制源码'
            copy.addEventListener('click', () => {
                navigator.clipboard.writeText(code).then(() => { copy.textContent = '✓ 已复制' })
                setTimeout(() => { copy.textContent = '复制源码' }, 1500)
            })
            bar.append(hint, copy)
            wrap.insertBefore(bar, svg)
            return wrap
        }
    } catch { /* 解析失败 → 显示源码 */ }
    const pre = document.createElement('pre')
    pre.className = 'ai-svg-code'
    pre.textContent = code
    wrap.appendChild(pre)
    return wrap
}

// 消息富内容后处理：题目卡片 / SVG / 纯文本
function renderAiRichContent(msgEl, textEl, raw) {
    const quiz = parseQuizJson(raw)
    if (quiz) {
        textEl.textContent = raw.slice(0, raw.indexOf('<<<QUIZ>>>')).trim() || ''
        quiz.forEach((q, i) => msgEl.appendChild(renderQuizCard(q, i)))
        return
    }
    const svgCode = extractSvgCode(raw)
    if (svgCode) {
        textEl.textContent = raw.slice(0, raw.indexOf('<<<SVG>>>')).trim() || ''
        msgEl.classList.add('ai-msg-wide')   // SVG 消息突破气泡宽度，占满面板
        msgEl.appendChild(renderSvgBlock(svgCode))
        return
    }
    textEl.textContent = raw
}

// ================================================================
// 模型切换（对话框下方 💎 按钮）：同供应商换模型 / 跨供应商切换
// ================================================================

// 读取当前生效配置 → 刷新模型按钮
async function loadAiCurrent() {
    try {
        const r = await window.electronAPI.aiGetConfig()
        const cfg = r.config || {}
        aiCurrent = {
            provider: cfg.provider || 'deepseek',
            baseUrl: cfg.baseUrl || (AI_PRESETS[cfg.provider] ? AI_PRESETS[cfg.provider].baseUrl : ''),
            model: cfg.model || '',
        }
        aiKeySetMap = cfg.keySetMap || {}
    } catch { /* 忽略 */ }
    refreshAiModelBtn()
}

function refreshAiModelBtn() {
    if (!els.aiModelLabel) return
    const p = AI_PRESETS[aiCurrent.provider]
    els.aiModelLabel.textContent = aiCurrent.model || '未设置'
    els.aiModelBtn.title = (p ? p.label + ' · ' : '') + (aiCurrent.model || '未设置') + '（点击切换模型）'
    if (els.aiModelMenu) {
        els.aiModelMenu.querySelectorAll('.mm-item').forEach((it) => {
            it.classList.toggle('active', it.dataset.model === aiCurrent.model && it.dataset.provider === aiCurrent.provider)
        })
    }
}

// 构建分组模型菜单（按供应商分组，跨供应商可切换）
function buildAiModelMenu() {
    if (!els.aiModelMenu) return
    els.aiModelMenu.innerHTML = ''
    for (const key of Object.keys(AI_PRESETS)) {
        const p = AI_PRESETS[key]
        if (!p.models || !p.models.length) continue
        const group = document.createElement('div')
        group.className = 'mm-provider'
        group.textContent = p.label
        els.aiModelMenu.appendChild(group)
        for (const m of p.models) {
            const item = document.createElement('div')
            item.className = 'mm-item'
            item.dataset.provider = key
            item.dataset.model = m
            item.textContent = m
            item.addEventListener('click', () => switchAiModel(key, m))
            els.aiModelMenu.appendChild(item)
        }
    }
    refreshAiModelBtn()
}

// 切换模型：更新当前配置（各供应商 Key 独立保存，互不覆盖）
async function switchAiModel(provider, model) {
    const p = AI_PRESETS[provider]
    if (!p) return
    els.aiModelMenu.classList.add('hidden')
    const prev = aiCurrent.provider
    aiCurrent = { provider, baseUrl: p.baseUrl, model }
    refreshAiModelBtn()
    const res = await window.electronAPI.aiSaveConfig({ provider, baseUrl: p.baseUrl, model, key: '' })
    if (res.ok) {
        if (prev !== provider && !aiKeySetMap[provider]) {
            aiAppendMessage('assistant', '已切换到 ' + p.label + ' · ' + model + '（该供应商尚未配置 Key，请在 ⚙ 设置中填写）', false)
        } else {
            aiAppendMessage('assistant', '已切换到 ' + p.label + ' · ' + model, false)
        }
    } else {
        aiAppendMessage('assistant', '⚠ 切换模型失败：' + (res.error || ''), false)
    }
}

// 构建对话模式菜单（普通对话 / 出题目 / 可视化制作 / 研究）
function buildAiModeMenu() {
    if (!els.aiModeMenu) return
    els.aiModeMenu.innerHTML = ''
    for (const key of Object.keys(AI_MODE_META)) {
        const meta = AI_MODE_META[key]
        const item = document.createElement('div')
        item.className = 'mm-item mode-item'
        item.dataset.mode = key
        item.innerHTML = '<span class="mode-icon">' + meta.icon + '</span><span class="mode-label">' + meta.label + '</span>'
        item.addEventListener('click', () => switchAiMode(key))
        els.aiModeMenu.appendChild(item)
    }
    refreshAiModeBtn()
}

function refreshAiModeBtn() {
    if (!els.aiModeLabel) return
    const meta = AI_MODE_META[aiMode] || AI_MODE_META.chat
    els.aiModeLabel.textContent = meta.label
    els.aiModeBtn.innerHTML = meta.icon + ' <span id="aiModeLabel">' + meta.label + '</span> <span class="aiCaret">▾</span>'
    if (els.aiModeMenu) {
        els.aiModeMenu.querySelectorAll('.mode-item').forEach((it) => {
            it.classList.toggle('active', it.dataset.mode === aiMode)
        })
    }
}

function switchAiMode(mode) {
    if (!AI_MODE_META[mode]) return
    aiMode = mode
    els.aiModeMenu.classList.add('hidden')
    refreshAiModeBtn()
    const meta = AI_MODE_META[mode]
    const desc = {
        chat: '日常问答，不注入额外提示词。',
        quiz: 'AI 会生成练习题，并在对话中渲染为可交互的题目卡片。',
        viz: 'AI 会生成 SVG 代码，并在对话中直接渲染图表。',
        research: 'AI 会按「概述 / 关键发现 / 分析 / 结论」做结构化研究。',
    }[mode]
    aiAppendMessage('assistant', '已切换到「' + meta.icon + ' ' + meta.label + '」模式：' + desc, false)
}

// 设置对话框：供应商模型候选 chips（点击直接选用）
function renderAiModelChips() {
    if (!els.aiModelChips) return
    const p = AI_PRESETS[els.aiProvider.value]
    els.aiModelChips.innerHTML = ''
    ;(p.models || []).forEach((m) => {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'aiModelChip' + (els.aiModel.value === m ? ' active' : '')
        chip.textContent = m
        chip.title = '选择模型 ' + m
        chip.addEventListener('click', () => {
            els.aiModel.value = m
            renderAiModelChips()
        })
        els.aiModelChips.appendChild(chip)
    })
}

// 设置对话框：读取 / 填写 / 保存
async function openAiSettings() {
    const r = await window.electronAPI.aiGetConfig()
    const cfg = r.config || {}
    els.aiProvider.value = cfg.provider || 'deepseek'
    els.aiBaseUrl.value = cfg.baseUrl || ''
    els.aiModel.value = cfg.model || ''
    aiKeySetMap = cfg.keySetMap || {}
    // Key 只存在于主进程：已配置时显示占位符（留空 = 保存时保留旧 Key）
    els.aiKey.value = ''
    refreshAiKeyPlaceholder()
    if (cfg.keyInvalid) els.aiCfgErr.textContent = '系统安全存储不可用，旧 Key 无法解密，请重新输入'
    else els.aiCfgErr.textContent = ''
    applyAiPreset()
    els.aiSettingsOverlay.classList.remove('hidden')
    // 同步模型切换按钮
    aiCurrent = { provider: cfg.provider || 'deepseek', baseUrl: cfg.baseUrl || '', model: cfg.model || '' }
    refreshAiModelBtn()
}

function refreshAiKeyPlaceholder() {
    if (!els.aiKey) return
    const keySet = !!(aiKeySetMap && aiKeySetMap[els.aiProvider.value])
    els.aiKey.placeholder = keySet ? '已保存（sk-••••••••，留空则不修改）' : 'sk-...（safeStorage 加密保存）'
}

function applyAiPreset() {
    const p = AI_PRESETS[els.aiProvider.value]
    if (!p) return
    // 当前值若仍为空、或是某个预置供应商的默认值（即用户没自定义过）→ 覆盖为新供应商默认
    const anyPresetDefaultUrl = Object.values(AI_PRESETS).some((x) => x.baseUrl && x.baseUrl === els.aiBaseUrl.value)
    const anyPresetDefaultModel = Object.values(AI_PRESETS).some((x) => x.defaultModel && x.defaultModel === els.aiModel.value)
    if (!els.aiBaseUrl.value || anyPresetDefaultUrl) els.aiBaseUrl.value = p.baseUrl
    if (!els.aiModel.value || anyPresetDefaultModel) els.aiModel.value = p.defaultModel || (p.models && p.models[0]) || ''
    els.aiProviderHint.textContent = p.hint
    refreshAiKeyPlaceholder()
    // 模型候选（datalist + chips）
    if (els.aiModelList) {
        els.aiModelList.innerHTML = ''
        ;(p.models || []).forEach((m) => {
            const opt = document.createElement('option')
            opt.value = m
            els.aiModelList.appendChild(opt)
        })
    }
    renderAiModelChips()
}

async function saveAiSettings() {
    const cfg = {
        provider: els.aiProvider.value,
        baseUrl: els.aiBaseUrl.value.trim(),
        model: els.aiModel.value.trim(),
        key: els.aiKey.value.trim(),
    }
    if (!cfg.baseUrl || !cfg.model) {
        els.aiCfgErr.textContent = '接口地址与模型名不能为空'
        return
    }
    const res = await window.electronAPI.aiSaveConfig(cfg)
    if (!res.ok) {
        els.aiCfgErr.textContent = res.error || '保存失败'
        return
    }
    els.aiSettingsOverlay.classList.add('hidden')
    aiCurrent = { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model }
    if (cfg.key) aiKeySetMap[cfg.provider] = true
    refreshAiModelBtn()
    const p = AI_PRESETS[cfg.provider]
    aiAppendMessage('assistant', '✓ 配置已保存（' + (p ? p.label : cfg.provider) + ' · ' + cfg.model + '）', false)
}

// 用 mousedown 捕获选区：点击按钮的默认行为会先清空 DOM 选区（live 模式），
// 等 click 再捕获就只剩"完整内容"了。mousedown 时选区还在，click 直接打开面板。
els.aiBtn.addEventListener('mousedown', () => captureAiSelection())
els.aiBtn.addEventListener('click', () => openAiPanel(true))
els.aiCloseBtn.addEventListener('click', closeAiPanel)
els.aiSettingsBtn.addEventListener('click', openAiSettings)
els.aiCfgCancel.addEventListener('click', () => els.aiSettingsOverlay.classList.add('hidden'))
els.aiCfgOk.addEventListener('click', saveAiSettings)
els.aiProvider.addEventListener('change', applyAiPreset)
els.aiSettingsOverlay.addEventListener('click', (e) => {
    if (e.target === els.aiSettingsOverlay) els.aiSettingsOverlay.classList.add('hidden')
})
// Key 显示 / 隐藏切换
els.aiKeyToggle.addEventListener('click', () => {
    const show = els.aiKey.type === 'password'
    els.aiKey.type = show ? 'text' : 'password'
    els.aiKeyToggle.textContent = show ? '🙈' : '👁'
})
// 模型切换按钮 / 菜单
buildAiModelMenu()
els.aiModelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    els.aiModelMenu.classList.toggle('hidden')
    els.aiModeMenu.classList.add('hidden')
})
document.addEventListener('click', (e) => {
    if (els.aiModelMenu && !els.aiModelMenu.classList.contains('hidden')
        && !els.aiModelMenu.contains(e.target) && e.target !== els.aiModelBtn && !els.aiModelBtn.contains(e.target)) {
        els.aiModelMenu.classList.add('hidden')
    }
    if (els.aiModeMenu && !els.aiModeMenu.classList.contains('hidden')
        && !els.aiModeMenu.contains(e.target) && e.target !== els.aiModeBtn && !els.aiModeBtn.contains(e.target)) {
        els.aiModeMenu.classList.add('hidden')
    }
})
// 对话模式切换
buildAiModeMenu()
els.aiModeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    els.aiModeMenu.classList.toggle('hidden')
    els.aiModelMenu.classList.add('hidden')
})
els.aiSendBtn.addEventListener('click', aiSend)
els.aiAbortBtn.addEventListener('click', () => window.electronAPI.aiAbort())
els.aiSessionNew.addEventListener('click', newAiConvo)
els.aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend() }
})
els.aiCtxBtn.addEventListener('click', () => {
    aiCtxOn = !aiCtxOn
    els.aiCtxBtn.classList.toggle('on', aiCtxOn)
    updateAiCtxStatus()
    if (aiCtxOn && !state.currentFile) {
        aiAppendMessage('assistant', '当前没有打开的文件，打开笔记后提问会自动附带其内容。', false)
    }
})

// ================================================================
// 文件拖放打开（E）：从资源管理器拖文件 / 文件夹进窗口
// ================================================================

let dragDepth = 0   // dragenter/leave 成对计数，避免子元素抖动
let splitHintDepth = 0   // 渲染区分屏阴影的 enter/leave 计数（拖回目录栏时正确收起）

// -webkit-app-region: drag 的区域（顶栏 / 标签栏 / 启动屏顶部拖动条）会被 OS 层拦截拖放：
// 文件悬停其上时 Web 的 dragover 不触发 → 显示禁止符号且无法 drop。
// 修复：拖拽文件期间临时切成 no-drag，结束恢复 drag（窗口仍可拖动）。
// 启动屏主体（launchScreen）已不在 drag 区域（index.html），保证拖入畅通。
const DRAG_REGION_SELECTOR = '.labelNav, .topNav, .launchDragBar'
function setDragRegions(enabled) {
    document.querySelectorAll(DRAG_REGION_SELECTOR).forEach((el) => {
        el.style.webkitAppRegion = enabled ? 'drag' : 'no-drag'
    })
}

// 判断拖入内容是否可能是文件（Files 或 text/uri-list，如从压缩包管理器拖出）
function dropHasFiles(dt) {
    if (!dt) return false
    const types = [...dt.types]
    return types.includes('Files') || types.includes('text/uri-list')
}

document.addEventListener('dragenter', (e) => {
    if (!dropHasFiles(e.dataTransfer)) return
    dragDepth++
    setDragRegions(false)   // 文件拖入窗口：临时放开 drag region，让全窗口可放置
    els.dropOverlay.classList.add('show')
})
document.addEventListener('dragover', (e) => {
    // 无条件 preventDefault（只要有任何拖拽数据）：
    // 否则 Electron 可能把窗口导航到被拖的文件（尤其 types 为 text/uri-list 时）
    if (e.dataTransfer) e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})
document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) {
        setDragRegions(true)   // 拖拽完全离开窗口：恢复窗口拖动能力
        els.dropOverlay.classList.remove('show')
        els.splitDropHint.classList.add('hidden')   // 拖拽完全离开窗口时也收起分屏阴影
    }
})
document.addEventListener('drop', async (e) => {
    e.preventDefault()
    dragDepth = 0
    splitHintDepth = 0
    setDragRegions(true)   // 释放后恢复窗口拖动能力
    els.dropOverlay.classList.remove('show')
    els.splitDropHint.classList.add('hidden')   // 在窗口任意位置（含目录栏）释放都收起阴影
    const dt = e.dataTransfer
    if (!dt) return
    // 1) 优先 dataTransfer.files（真实文件拖放）
    if (dt.files && dt.files.length) {
        for (const file of dt.files) {
            let p = ''
            try { p = window.electronAPI.getPathForFile(file) } catch { p = '' }
            if (p) await openDroppedPath(p)
        }
        return
    }
    // 2) 兜底：text/uri-list / text/plain 里的 file:// URL（某些应用拖出时没有 File 对象）
    const uriText = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
    for (const uri of uriText.split('\n').map((s) => s.trim()).filter((s) => s && /^file:/i.test(s))) {
        const p = fileUrlToPath(uri)
        if (p) await openDroppedPath(p)   // 单条解析失败跳过，不影响其余 URI
    }
})

// 打开拖入的路径：文件夹 → 作为工作区；文件 → 按类型打开
async function openDroppedPath(p) {
    const d = await window.electronAPI.isDir(p)
    if (!d.ok) { alert('无法访问：' + p); return }
    if (d.isDir) {
        await enterDirectory(p)
        els.launchScreen.classList.add('hidden')   // 从启动界面拖入文件夹时隐藏它
        return
    }
    const name = basename(p)
    if (isImageFile(name)) { showImage({ path: p, name }); return }
    if (isPdfFile(name)) { showPdf({ path: p, name }); return }
    if (isTextFile(name)) { await openFileByPath(p); return }
    showUntextable({ path: p, name })
}

// ================================================================
// 设置面板（D）：主题 / 默认排序 / 清理数据
// ================================================================

function openSettings() {
    els.setThemeMode.value = state.themeMode || 'light'
    els.setSortMode.value = state.sortMode || 'name'
    els.settingsOverlay.classList.remove('hidden')
}

function closeSettings() {
    els.settingsOverlay.classList.add('hidden')
}

els.settingsBtn.addEventListener('click', openSettings)
els.setOk.addEventListener('click', closeSettings)
els.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === els.settingsOverlay) closeSettings()
})

// 主题档位切换：立即生效并记住
els.setThemeMode.addEventListener('change', () => {
    applyTheme(els.setThemeMode.value)
    localStorage.setItem(THEME_MODE_KEY, state.themeMode)
})

// 默认排序：立即重排并记住
els.setSortMode.addEventListener('change', () => {
    state.sortMode = els.setSortMode.value
    localStorage.setItem('emerald-sort-mode', state.sortMode)
    if (state.rootPath) resortTree()
})

// 清理数据
els.setClearRecentFolders.addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY)
    renderRecentFolders()
    alert('已清空最近文件夹')
})
els.setClearRecentFiles.addEventListener('click', () => {
    localStorage.removeItem(RECENT_FILES_KEY)
    renderRecentFiles()
    alert('已清空最近文件')
})
els.setClearFavorites.addEventListener('click', () => {
    localStorage.removeItem(FAV_KEY)
    renderFavorites()
    alert('已清空收藏')
})
els.setClearTags.addEventListener('click', async () => {
    if (!state.rootPath) { alert('当前没有打开的工作区'); return }
    state.tags = {}
    await saveTags()
    renderTags()
    updateTreeBadges()
    alert('已清空当前工作区标签')
})

// H：导出工作区备份（.emerald 索引 + 文件清单）
els.setExportWorkspace.addEventListener('click', async () => {
    if (!state.rootPath) { alert('当前没有打开的工作区'); return }
    const pick = await window.electronAPI.selectFolder()
    if (!pick.ok || pick.canceled) return
    const destDir = joinPath(pick.path, basename(state.rootPath) + '-backup')
    const exp = await window.electronAPI.exportWorkspace(state.rootPath, destDir)
    if (!exp.ok) { alert('导出失败：' + (exp.error || '')); return }
    alert('✅ 已导出 ' + exp.count + ' 个文件到：\n' + exp.dest + (exp.hasIndex ? '\n（含标签索引）' : ''))
})

// ================================================================
// 侧边栏宽度拖拽（F）
// ================================================================

const SIDEBAR_W_KEY = 'emerald-sidebar-w'
let sidebarDrag = null   // { startX, startW }

function applySidebarWidth(w) {
    const el = document.querySelector('.catalogueContainer')
    if (!el) return
    el.style.flex = 'none'
    el.style.width = w + 'px'
}

els.sidebarResizer.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const el = document.querySelector('.catalogueContainer')
    sidebarDrag = { startX: e.clientX, startW: el.getBoundingClientRect().width }
    els.sidebarResizer.classList.add('dragging')
})
document.addEventListener('mousemove', (e) => {
    if (!sidebarDrag) return
    const w = Math.max(220, Math.min(560, sidebarDrag.startW + (e.clientX - sidebarDrag.startX)))
    applySidebarWidth(w)
})
document.addEventListener('mouseup', () => {
    if (!sidebarDrag) return
    const w = Math.round(document.querySelector('.catalogueContainer').getBoundingClientRect().width)
    localStorage.setItem(SIDEBAR_W_KEY, String(w))
    sidebarDrag = null
    els.sidebarResizer.classList.remove('dragging')
})

// 初始化：应用保存过的宽度
;(function () {
    const savedW = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || '', 10)
    if (savedW) applySidebarWidth(savedW)
})()

// ================================================================
// 大纲侧边栏（G）：当前 Markdown 的标题列表，点击跳转
// ================================================================

function extractOutline(mdText) {
    return String(mdText || '').split('\n').map((line, i) => {
        const m = /^(#{1,3})\s+(.+)$/.exec(line)
        if (!m) return null
        return { level: m[1].length, text: m[2].trim().replace(/[ \t]+#+$/, ''), line: i }
    }).filter(Boolean)
}

function renderOutline() {
    if (!els.outlineSection) return
    const f = state.currentFile
    const items = (f && f.path && isMarkdown(f.name)) ? extractOutline(f.content) : []
    els.outlineSection.innerHTML = ''
    if (!items.length) {
        els.outlineSection.classList.add('hidden')
        return
    }
    els.outlineSection.classList.remove('hidden')
    const title = document.createElement('div')
    title.className = 'fav-title'
    title.textContent = '📑 大纲'
    els.outlineSection.appendChild(title)
    items.forEach((it) => {
        const item = document.createElement('div')
        item.className = 'outline-item l' + it.level
        item.textContent = it.text
        item.title = '第 ' + (it.line + 1) + ' 行'
        item.addEventListener('click', () => {
            revealLine(it.line + 1)   // 实时模式滚动+闪烁；文本框模式选区定位
        })
        els.outlineSection.appendChild(item)
    })
}

// ================================================================
// FIX2：从目录树拖文件到渲染区 → 分屏预览（右侧绿色阴影）+ 分屏打开
// ================================================================

const mainRenderEl = document.querySelector('.mainRender')

mainRenderEl.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('application/x-emerald-path')) return
    e.preventDefault()
    splitHintDepth++
    els.splitDropHint.classList.remove('hidden')
})
mainRenderEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('application/x-emerald-path')) return
    e.preventDefault()
    els.splitDropHint.classList.remove('hidden')
})
mainRenderEl.addEventListener('dragleave', () => {
    // 计数法：enter/leave 成对，离开最后一个子元素时才真正离开渲染区（不再依赖 e.target 判断）
    splitHintDepth = Math.max(0, splitHintDepth - 1)
    if (splitHintDepth === 0) els.splitDropHint.classList.add('hidden')
})
mainRenderEl.addEventListener('drop', (e) => {
    const p = e.dataTransfer && e.dataTransfer.getData('application/x-emerald-path')
    splitHintDepth = 0
    els.splitDropHint.classList.add('hidden')
    if (!p) return
    e.preventDefault()
    e.stopPropagation()   // 不冒泡到 document 的文件拖放处理
    splitPane()           // 新面板成为活动面板（右侧）
    openFileByPath(p)     // 文件打开在新分屏面板
})

// ================================================================
// 知识图谱（#13）：wikilink 力导向布局 + 孤岛检测，Canvas 渲染
// ================================================================

let graphData = null            // { nodes: [{rel,name}], links: [{from,to}] }
let graphPos = null             // Float64Array 节点世界坐标 [x0,y0,x1,y1,...]
let graphVel = null             // Float64Array 速度
let graphDeg = null             // Int32Array 节点度（入+出）
let graphFixed = new Set()      // 被用户拖住固定的节点下标
let graphSimSteps = 0           // 已迭代步数
let graphSimDone = false        // 布局收敛 / 达上限
let graphView = { scale: 1, tx: 0, ty: 0 }   // 屏幕变换：screen = world * scale + t
let graphRAF = null
let graphLoadToken = 0   // 加载令牌：扫描期间关闭/重扫时使在途 loadGraph 失效（防止 rAF 空转泄漏）
let graphDrag = null            // { idx, moved, lastX, lastY }
let graphPan = null             // 空白处拖动平移 { lastX, lastY }
let graphHover = -1             // 悬停节点（高亮）

// 图谱物理参数（Obsidian 式松弛感：邻居柔和跟随、收敛平滑）
const GRAPH_MAX_STEPS = 800
const GRAPH_REST = 170          // 弹簧目标距离（px，拉开间距，线更长更舒展）
const GRAPH_K_SPRING = 0.06     // 弹簧刚度（拖拽时临时增强，邻居跟随明显但柔和）
const GRAPH_K_REP = 4200        // 斥力强度（拉开节点间距）
const GRAPH_K_CENTER = 0.01     // 向心力（弱一点，允许图自然扩散）
const GRAPH_DAMP = 0.85         // 速度阻尼（更高 → 运动更平滑、无抖动）
const GRAPH_STEPS_FRAME = 4     // 常态每帧物理步数
const GRAPH_STEPS_FRAME_DRAG = 8    // 拖拽时每帧物理步数（柔和跟随）

function openGraph() {
    if (!state.rootPath) { alert('请先打开一个工作区'); return }
    hideAllStates()
    els.graphPanel.classList.remove('hidden')
    loadGraph()
}

function closeGraph() {
    graphLoadToken++   // 使在途 loadGraph 失效：不再启动模拟/重绘
    if (graphRAF) { cancelAnimationFrame(graphRAF); graphRAF = null }
    graphDrag = null
    graphPan = null
    graphData = null
    els.graphPanel.classList.add('hidden')
}

// 重新扫描：从主进程拿节点/边，构建模拟数据并启动布局
async function loadGraph() {
    const token = ++graphLoadToken
    els.graphLoading.classList.remove('hidden')
    els.graphEmpty.classList.add('hidden')
    els.graphStats.textContent = ''
    const res = await window.electronAPI.scanLinks(state.rootPath)
    if (token !== graphLoadToken) return   // 扫描期间图谱被关闭 / 重新扫描
    els.graphLoading.classList.add('hidden')
    if (!res.ok) {
        els.graphEmpty.textContent = '扫描失败：' + (res.error || '未知错误')
        els.graphEmpty.classList.remove('hidden')
        return
    }
    const nodes = res.nodes || []
    if (!nodes.length) {
        els.graphEmpty.textContent = '当前工作区没有 Markdown 笔记，写几篇并用 [[双向链接]] 连接它们吧'
        els.graphEmpty.classList.remove('hidden')
        return
    }
    // 边去重（一对文件只算一条边）
    const seen = new Set()
    const links = (res.links || []).filter((l) => {
        const k = l.from < l.to ? l.from + '\u0000' + l.to : l.to + '\u0000' + l.from
        if (seen.has(k)) return false
        seen.add(k)
        return true
    })
    graphData = { nodes, links, truncated: !!res.truncated }
    const n = nodes.length
    graphPos = new Float64Array(n * 2)
    graphVel = new Float64Array(n * 2)
    graphDeg = new Int32Array(n)
    graphFixed = new Set()
    graphSimSteps = 0
    graphSimDone = false
    graphView = { scale: 1, tx: 0, ty: 0 }
    // 初始位置：环形展开（比随机更稳定），再叠加小扰动
    const cx = 0, cy = 0
    const R = Math.max(120, n * 9)
    nodes.forEach((nd, i) => {
        const ang = (i / Math.max(1, n)) * Math.PI * 2
        graphPos[i * 2] = cx + Math.cos(ang) * R + (Math.random() - 0.5) * 30
        graphPos[i * 2 + 1] = cy + Math.sin(ang) * R + (Math.random() - 0.5) * 30
    })
    // 度统计
    links.forEach((l) => {
        const a = idxOfRel(l.from)
        const b = idxOfRel(l.to)
        if (a >= 0 && b >= 0) { graphDeg[a]++; graphDeg[b]++ }
    })
    // 统计文本
    const isolated = nodes.filter((_, i) => graphDeg[i] === 0).length
    els.graphStats.textContent = nodes.length + ' 笔记 · ' + links.length + ' 链接'
        + (isolated ? ' · 孤立 ' + isolated : '') + (res.truncated ? '（超 400 笔记已截断）' : '')
    els.graphEmpty.classList.add('hidden')
    startGraphSim()
}

function idxOfRel(rel) {
    if (!graphData) return -1
    for (let i = 0; i < graphData.nodes.length; i++) {
        if (graphData.nodes[i].rel === rel) return i
    }
    return -1
}

// 启动力导向模拟（rAF 驱动，收敛后停止；拖拽节点时继续）
function startGraphSim() {
    if (graphRAF) cancelAnimationFrame(graphRAF)
    const tick = () => {
        if (!graphSimDone) {
            const steps = graphDrag ? GRAPH_STEPS_FRAME_DRAG : GRAPH_STEPS_FRAME
            for (let k = 0; k < steps; k++) stepGraphSim()   // 拖拽时更多步，邻居跟随更快
            drawGraph()
        } else {
            drawGraph()   // 收敛后仍重绘（缩放/平移/拖拽时）
        }
        graphRAF = requestAnimationFrame(tick)
    }
    graphRAF = requestAnimationFrame(tick)
}

// 物理一步：斥力（O(n²)）+ 弹簧 + 向心 + 阻尼
function stepGraphSim() {
    const n = graphData.nodes.length
    const pos = graphPos, vel = graphVel
    // 斥力：所有节点对
    for (let i = 0; i < n; i++) {
        const xi = pos[i * 2], yi = pos[i * 2 + 1]
        for (let j = i + 1; j < n; j++) {
            let dx = xi - pos[j * 2]
            let dy = yi - pos[j * 2 + 1]
            let d2 = dx * dx + dy * dy
            if (d2 < 1) { d2 = 1 }
            const d = Math.sqrt(d2)
            const f = GRAPH_K_REP / d2
            const fx = (dx / d) * f
            const fy = (dy / d) * f
            vel[i * 2] += fx; vel[i * 2 + 1] += fy
            vel[j * 2] -= fx; vel[j * 2 + 1] -= fy
        }
    }
    // 弹簧（有边）+ 向心力；拖拽节点时弹簧刚度临时增强，让邻居明显跟随
    for (let i = 0; i < n; i++) {
        const xi = pos[i * 2], yi = pos[i * 2 + 1]
        vel[i * 2] += -xi * GRAPH_K_CENTER
        vel[i * 2 + 1] += -yi * GRAPH_K_CENTER
    }
    const springK = graphDrag ? GRAPH_K_SPRING * 2 : GRAPH_K_SPRING
    for (const l of graphData.links) {
        const a = idxOfRel(l.from)
        const b = idxOfRel(l.to)
        if (a < 0 || b < 0) continue
        const dx = pos[b * 2] - pos[a * 2]
        const dy = pos[b * 2 + 1] - pos[a * 2 + 1]
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = (d - GRAPH_REST) * springK
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        vel[a * 2] += fx; vel[a * 2 + 1] += fy
        vel[b * 2] -= fx; vel[b * 2 + 1] -= fy
    }
    // 积分 + 阻尼（固定节点不动）
    let energy = 0
    for (let i = 0; i < n; i++) {
        if (graphFixed.has(i)) { vel[i * 2] = 0; vel[i * 2 + 1] = 0; continue }
        vel[i * 2] *= GRAPH_DAMP
        vel[i * 2 + 1] *= GRAPH_DAMP
        pos[i * 2] += vel[i * 2]
        pos[i * 2 + 1] += vel[i * 2 + 1]
        energy += Math.abs(vel[i * 2]) + Math.abs(vel[i * 2 + 1])
    }
    graphSimSteps++
    if (graphSimSteps >= GRAPH_MAX_STEPS || energy < n * 0.02) {
        graphSimDone = true
    }
}

// 画布与主题色（每次绘制读取，主题切换后自动适配）
function graphColors() {
    const css = getComputedStyle(document.documentElement)
    const acc = (css.getPropertyValue('--accent') || '#10b981').trim()
    const fg = (css.getPropertyValue('--text') || '#1f2937').trim()
    const mut = (css.getPropertyValue('--text-muted') || '#6b7280').trim()
    const bd = (css.getPropertyValue('--border') || '#e5e7eb').trim()
    return { acc, fg, mut, bd }
}

function drawGraph() {
    const canvas = els.graphCanvas
    const ctx = canvas.getContext('2d')
    const body = els.graphPanel.querySelector('.graphBody')
    const W = body.clientWidth, H = body.clientHeight
    if (!W || !H || !graphData) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr
        canvas.height = H * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const col = graphColors()
    const n = graphData.nodes.length
    const { scale, tx, ty } = graphView
    // 视口中心：把世界原点投到画布中心
    const ox = W / 2 - tx, oy = H / 2 - ty
    const sx = (i) => pos(i, 0) * scale + ox
    const sy = (i) => pos(i, 1) * scale + oy
    const pos = (i, axis) => graphPos[i * 2 + axis]
    // 焦点节点（拖拽或悬停）：Obsidian 式聚焦——它的连线清晰，其余连线大幅变淡
    const focusIdx = graphDrag ? graphDrag.idx : (graphHover >= 0 ? graphHover : -1)
    const focusNeighbors = new Set()
    if (focusIdx >= 0) {
        for (const l of graphData.links) {
            const a = idxOfRel(l.from), b = idxOfRel(l.to)
            if (a === focusIdx) focusNeighbors.add(b)
            if (b === focusIdx) focusNeighbors.add(a)
        }
    }
    // 边：细线（0.6–1.1px）+ accent 半透明（在背景上凸显）；焦点连线清晰，其余变淡
    ctx.lineWidth = 1
    for (const l of graphData.links) {
        const a = idxOfRel(l.from), b = idxOfRel(l.to)
        if (a < 0 || b < 0) continue
        const linked = focusIdx >= 0 && (a === focusIdx || b === focusIdx)
        const w = Math.min(1.1, 0.6 + (graphDeg[a] + graphDeg[b]) * 0.05)
        ctx.strokeStyle = col.acc
        ctx.globalAlpha = linked ? 0.9 : (focusIdx >= 0 ? 0.07 : 0.32)
        ctx.lineWidth = linked ? Math.min(1.4, w * 1.3) : w
        ctx.beginPath()
        ctx.moveTo(sx(a), sy(a))
        ctx.lineTo(sx(b), sy(b))
        ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    // 节点：焦点节点放大 + 光晕；其邻居保持醒目；无关节点变暗
    const current = state.currentFile ? state.currentFile.path : ''
    for (let i = 0; i < n; i++) {
        const x = sx(i), y = sy(i)
        const deg = graphDeg[i]
        const r = Math.max(4, Math.min(11, 4.5 + Math.sqrt(deg) * 1.8))
        const isolated = deg === 0
        const isCurrent = current.endsWith(graphData.nodes[i].rel.replace(/\//g, '\\')) || current === graphData.nodes[i].rel
        const focused = i === focusIdx
        const isNeighbor = focusIdx >= 0 && focusNeighbors.has(i)
        // 透明度分层：焦点 1.0（+光晕）> 邻居/当前文件 1.0 > 常态 0.9 > 无关节点 0.35
        let alpha = 0.9
        if (focused || isNeighbor || isCurrent) alpha = 1
        else if (focusIdx >= 0) alpha = 0.35
        const rr = focused ? r * 1.35 : r
        ctx.beginPath()
        ctx.arc(x, y, rr, 0, Math.PI * 2)
        if (focused) {
            ctx.shadowColor = col.acc
            ctx.shadowBlur = 14
        }
        if (isCurrent) {
            ctx.fillStyle = col.acc
        } else if (isolated) {
            ctx.fillStyle = col.mut
        } else {
            ctx.fillStyle = col.acc
        }
        ctx.globalAlpha = alpha
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.shadowBlur = 0
        if (focused || i === graphHover || isCurrent) {
            ctx.strokeStyle = focused ? '#fff' : col.fg
            ctx.lineWidth = focused ? 2 : 1.5
            ctx.stroke()
            ctx.lineWidth = 1
        }
        // 标签：Obsidian 式——字号随缩放动态变小（缩小不覆盖相邻节点），
        // 接近隐藏阈值时透明度渐隐过渡（scale 0.9 → 全显，0.55 → 完全透明）
        const labelFade = Math.min(1, Math.max(0, (scale - 0.55) / 0.35))
        if (labelFade > 0.02) {
            const fontSize = Math.max(6.5, Math.min(12, 9.5 * scale))   // 更小的字，随缩放动态
            const label = graphData.nodes[i].name.replace(/\.md$/i, '')
            ctx.fillStyle = isolated ? col.mut : col.fg
            let la = 0.9
            if (focusIdx >= 0 && !focused && !isNeighbor) la = 0.4
            else if (alpha < 0.5) la = 0.4
            ctx.globalAlpha = la * labelFade
            ctx.font = (focused ? 'bold ' : '') + fontSize + 'px "Segoe UI", sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText(label, x, y + rr + fontSize + 4)
            ctx.globalAlpha = 1
        }
    }
}

// —— 交互：拖拽节点 / 平移视图 / 缩放 / 点击打开 / 悬停 ——

function graphHitNode(px, py) {
    const { scale } = graphView
    const body = els.graphPanel.querySelector('.graphBody')
    const W = body.clientWidth, H = body.clientHeight
    const ox = W / 2 - graphView.tx, oy = H / 2 - graphView.ty
    for (let i = graphData.nodes.length - 1; i >= 0; i--) {
        const x = graphPos[i * 2] * scale + ox
        const y = graphPos[i * 2 + 1] * scale + oy
        const r = Math.max(5, Math.min(13, 5.5 + Math.sqrt(graphDeg[i]) * 2))
        if (Math.abs(px - x) <= r + 6 && Math.abs(py - y) <= r + 6) return i
    }
    return -1
}

els.graphCanvas.addEventListener('pointerdown', (e) => {
    if (!graphData) return
    e.preventDefault()
    try { els.graphCanvas.setPointerCapture(e.pointerId) } catch { /* 模拟事件无真实指针 */ }
    const rect = els.graphCanvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const idx = graphHitNode(px, py)
    if (idx >= 0) {
        graphDrag = { idx, moved: false, lastX: px, lastY: py }
        graphFixed.add(idx)
    } else {
        graphPan = { lastX: px, lastY: py }
    }
})

els.graphCanvas.addEventListener('pointermove', (e) => {
    const rect = els.graphCanvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    if (graphDrag) {
        const d = Math.abs(px - graphDrag.lastX) + Math.abs(py - graphDrag.lastY)
        if (d > 3) graphDrag.moved = true
        graphDrag.lastX = px; graphDrag.lastY = py
        const { scale } = graphView
        const body = els.graphPanel.querySelector('.graphBody')
        const ox = body.clientWidth / 2 - graphView.tx, oy = body.clientHeight / 2 - graphView.ty
        graphPos[graphDrag.idx * 2] = (px - ox) / scale
        graphPos[graphDrag.idx * 2 + 1] = (py - oy) / scale
        graphSimDone = false   // 拖拽期间继续模拟（其它节点重新排布）
        graphSimSteps = 0
        if (!graphRAF) startGraphSim()
    } else if (graphPan) {
        // 反向：手指/鼠标向右滑 → 内容向右移（符合触摸屏直觉）
        graphView.tx -= px - graphPan.lastX
        graphView.ty -= py - graphPan.lastY
        graphPan.lastX = px; graphPan.lastY = py
    } else if (graphData) {
        const idx = graphHitNode(px, py)
        if (idx !== graphHover) { graphHover = idx; drawGraph() }
    }
})

els.graphCanvas.addEventListener('pointerup', (e) => {
    const wasDrag = graphDrag
    const wasPan = graphPan
    graphDrag = null
    graphPan = null
    if (wasDrag && !wasDrag.moved) {
        // 点击节点 → 关闭图谱并打开对应笔记（直接看到内容）
        const nd = graphData.nodes[wasDrag.idx]
        const target = joinPath(state.rootPath, nd.rel.split('/').join('\\'))
        closeGraph()
        openFileByPath(target)
    }
    if (wasDrag) graphFixed.delete(wasDrag.idx)
    if (wasPan) { /* 平移结束 */ }
})

els.graphCanvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = els.graphCanvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const ns = Math.max(0.25, Math.min(4, graphView.scale * factor))
    const k = ns / graphView.scale
    // 以鼠标为锚点缩放
    const body = els.graphPanel.querySelector('.graphBody')
    const ox = body.clientWidth / 2 - graphView.tx, oy = body.clientHeight / 2 - graphView.ty
    graphView.tx = (graphView.tx - px) * k + px
    graphView.ty = (graphView.ty - py) * k + py
    graphView.scale = ns
    drawGraph()
})

els.graphCanvas.addEventListener('dblclick', (e) => {
    // 空白双击复位视图；节点双击也复位（不打开两次）
    graphView = { scale: 1, tx: 0, ty: 0 }
    drawGraph()
})

els.graphRefreshBtn.addEventListener('click', loadGraph)
els.graphCloseBtn.addEventListener('click', () => { closeGraph(); renderActiveFile() })   // 关闭后恢复之前视图（与 Git 面板一致）
els.graphBtn.addEventListener('click', () => (els.graphPanel.classList.contains('hidden') ? openGraph() : closeGraph()))
// 打开工作区 / 刷新时若图谱开着则重扫（数据可能已变）
window.addEventListener('resize', () => { if (!els.graphPanel.classList.contains('hidden')) drawGraph() })

// ================================================================
// 事件绑定
// ================================================================

els.openFolderBtn.addEventListener('click', chooseFolder)
// 标题栏图标悬停提示：原生 title 在无边框窗口显示不可靠，改用应用内 tooltip（按钮正下方）
document.querySelectorAll('.topNav .rightContainer .icon').forEach((icon) => {
    const tip = icon.getAttribute('title')
    if (!tip) return
    icon.addEventListener('mouseenter', () => showTooltipBelow(icon, tip))
    icon.addEventListener('mouseleave', hideTooltip)
})
// 编辑器头部 🧩 按钮：弹出插件命令菜单（#14 商店）
els.pluginBtn.addEventListener('click', (e) => showPluginMenu(e.clientX, e.clientY))
// 设置面板：重新加载插件（#14）
els.setReloadPlugins.addEventListener('click', () => {
    PluginManager.load(state.rootPath || null)
    showNotice('插件已重新加载')
})
// 设置面板：打开插件商店
els.setOpenStore.addEventListener('click', () => window.PluginStore.open())
// 使用帮助（新手引导 / 快捷键 / 功能导览）
function openHelp() {
    els.helpOverlay.classList.remove('hidden')
}
function closeHelp() {
    els.helpOverlay.classList.add('hidden')
}
els.helpBtn.addEventListener('click', openHelp)
els.helpClose.addEventListener('click', closeHelp)
if (els.launchHelpBtn) els.launchHelpBtn.addEventListener('click', openHelp)
els.helpOverlay.addEventListener('click', (e) => { if (e.target === els.helpOverlay) closeHelp() })
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
els.backBtn.addEventListener('click', goBack)
els.forwardBtn.addEventListener('click', goForward)
els.toggleSidebarBtn.addEventListener('click', toggleSidebar)
els.expandSidebarBtn.addEventListener('click', toggleSidebar)
// 标题栏右侧：主题切换（日月图标）
els.themeSunBtn.addEventListener('click', toggleTheme)
els.themeMoonBtn.addEventListener('click', toggleTheme)
// 分屏 / 取消分屏（#11）
els.splitBtn.addEventListener('click', (e) => {
    e.stopPropagation()   // 阻止冒泡触发面板激活监听（点分屏后新面板保持活动）
    if (state.panes.length >= 2) unsplitPane()
    else splitPane()
})
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
    if (liveEdit) commitLineEdit()   // 先把未提交的行编辑落进 content
    if (anyDirty()) {
        const ok = await window.confirm('有文件未保存，确定退出吗？')
        if (!ok) return
    }
    flushAiConvoSave()          // 退出前落盘 AI 会话
    saveSession()               // 退出前保存会话
    window.electronAPI.doClose()
})
window.addEventListener('beforeunload', () => {
    flushAiConvoSave()
    saveSession()               // 兜底：系统方式关闭也保存
})

// 全局按键：点击别处 / 按 Esc 关闭右键菜单
document.addEventListener('click', hideContextMenu)
// 输入框提供标准编辑右键菜单（剪切/复制/粘贴/全选）；其余区域仍禁用原生菜单
document.addEventListener('contextmenu', (e) => {
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.selectionStart !== undefined) {
        e.preventDefault()
        const hasSel = t.selectionEnd > t.selectionStart
        const items = []
        if (hasSel) items.push({ label: '✂️ 剪切', action: () => { t.focus(); document.execCommand('cut') } })
        if (hasSel) items.push({ label: '⧉ 复制', action: () => { t.focus(); document.execCommand('copy') } })
        items.push({ label: '📋 粘贴', action: () => { t.focus(); document.execCommand('paste') } })
        items.push({ label: '☑ 全选', action: () => { t.focus(); t.select() } })
        if (items.length) showContextMenu(e.clientX, e.clientY, items)
        return
    }
    e.preventDefault() // 全局禁用浏览器原生菜单
})
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

// 快捷键（capture 阶段：块编辑 textarea 会 stopPropagation，冒泡监听收不到 Ctrl+Shift+P 等）
document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    // 弹层打开时全局快捷键不干预（避免 Ctrl+W 嵌套 confirm 挂起、Ctrl+P 在模态框背后开浮层）
    const modalOpen = !!document.getElementById('modalOverlay') && !document.getElementById('modalOverlay').classList.contains('hidden')
        || !!(els.settingsOverlay && !els.settingsOverlay.classList.contains('hidden'))
        || !!(els.aiSettingsOverlay && !els.aiSettingsOverlay.classList.contains('hidden'))
        || !!(els.batchDialogOverlay && !els.batchDialogOverlay.classList.contains('hidden'))
        || !!document.getElementById('pluginStore') && !document.getElementById('pluginStore').classList.contains('hidden')
    if (modalOpen) return
    // 行编辑未提交时，Ctrl+S / Ctrl+W 先把行内容提交进 content，避免写旧版本或静默丢编辑
    if (mod && liveEdit && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'w')) {
        commitLineEdit()
    }
    // 切换器 / 命令面板 / Git 面板输入框聚焦时，除 Esc 与 Ctrl+P / Ctrl+Shift+P 外全局键不生效
    const t = e.target
    const inFloating = t && t.closest && t.closest('#quickSwitcher, #commandPalette, #gitPanel')
    if (inFloating && !(mod && e.key.toLowerCase() === 'p')) return
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
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()          // Ctrl+Z：撤销上次行编辑（提交 / 移动 / 回车换行前）
        undoLineEdit()
        return
    }
    if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()          // Ctrl+F：查找 / 替换
        if (els.findBar.classList.contains('hidden')) openFindBar()
        else { els.findInput.focus(); els.findInput.select() }
        return
    }
    if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()          // Ctrl+W：关闭当前标签
        if (state.currentFile) closeTab(state.currentFile)
        return
    }
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()          // Ctrl+Tab / Ctrl+Shift+Tab：循环切换标签
        if (state.tabs.length > 1) {
            const cur = state.tabs.findIndex((t) => t.id === state.activeTabId)
            const n = state.tabs.length
            const next = e.shiftKey ? (cur - 1 + n) % n : (cur + 1) % n
            activateTab(state.tabs[next].id)
        }
        return
    }
    if (mod && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'k')) {
        e.preventDefault()          // Ctrl+P/K：快速切换器
        if (!els.quickSwitcher.classList.contains('hidden')) closeQuickSwitcher()
        else openQuickSwitcher()
    }
}, true)

// A：双击标签栏空白处新建空白标签（点中标签本身则忽略）
els.tabBar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tab')) return
    addBlankTab()
})

// ================================================================
// 启动初始化
// ================================================================

applyTheme(state.themeMode)
// #11：初始单个面板为活动面板 + 点击面板 0 内任意处激活它（面板 1 在 createPaneDom 里绑定）
const p0 = document.getElementById('pane0')
if (p0) {
    p0.classList.add('pane-active')
    p0.addEventListener('click', () => setActivePane(0))
}
renderTabs()
updateStatusBar()
updateNavBtns()
renderRecentFolders()
renderSessionRestore()
renderFavorites()
renderRecentFiles()
renderTags()
// 启动即加载用户级插件（无工作区也能用全局插件）；工作区插件由 loadRoot 加载
loadPluginsForWorkspace()
// 自动恢复上次会话：存在快照则直接进入主界面，否则停在启动界面
restoreSession()
