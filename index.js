const { BrowserWindow, app, ipcMain, dialog, shell, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileP = promisify(execFile)

let mainWin
let allowClose = false   // 用户确认关闭后置 true，放行第二次 close（配合 close 拦截）
let pageLoaded = false   // 页面加载完成前放行关闭，避免 close 拦截卡死启动过程

function createMainWindow() {
    mainWin = new BrowserWindow({
        width: 1000,
        height: 800,
        resizable: true,
        frame: false,
        icon: path.join(__dirname, 'icon.png'),   // 应用 Logo（窗口/任务栏）
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    })
    mainWin.webContents.on('did-finish-load', () => { pageLoaded = true })

    // 安全网（B1）：任何让应用窗口离开本应用的导航都拦下来。
    // 只放行本应用自身页面（file:// 且路径在 __dirname 下）；
    // http/https/mailto → 系统浏览器打开；其它（file:/data: 等任意本地文件）一律阻止，
    // 防止窗口被导航到任意本地 HTML 而让该页面持有完整 electronAPI。
    mainWin.webContents.on('will-navigate', (e, url) => {
        if (/^file:/i.test(url)) {
            const filePath = decodeURIComponent(url.replace(/^file:\/\/\//i, '').split('?')[0]).split('/').join('\\')
            if (path.resolve(filePath).startsWith(path.resolve(__dirname) + '\\')) return   // 应用自身页面放行
            e.preventDefault()
            return
        }
        if (/^(https?:|mailto:)/i.test(url)) { e.preventDefault(); shell.openExternal(url); return }
        e.preventDefault()
    })
    // 新窗口请求（target=_blank 等）一律拒绝，外链转系统浏览器
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url)
        return { action: 'deny' }
    })

    // 关闭拦截（B2）：所有关闭途径（关闭按钮 / Alt+F4 / 任务栏）统一先通知渲染进程，
    // 由渲染进程检查未保存修改并弹自研确认框；确认后走 app:do-close 放行
    mainWin.on('close', (e) => {
        if (allowClose || !pageLoaded) return
        e.preventDefault()
        mainWin.webContents.send('app:confirm-close')
    })

    mainWin.loadFile('./index.html')
}

// 渲染进程确认可以关闭后调用（B2）
ipcMain.on('app:do-close', () => {
    allowClose = true
    mainWin.close()
})

/* ================================================================
 * 窗口控制（一次性注册，顶层平级）
 * ipcRenderer.send → ipcMain.on 是“通知型”通信，没有返回值
 * ================================================================ */
ipcMain.on('minimize', () => {
    if (!mainWin.isMinimized()) mainWin.minimize()
})

ipcMain.on('fullscreen', () => {
    if (!mainWin.isMaximized()) {
        mainWin.maximize()
    } else {
        mainWin.unmaximize()
    }
})

ipcMain.on('closeWindow', () => {
    mainWin.close()
})

/* ================================================================
 * 文件系统（请求/响应型通信）
 * ipcRenderer.invoke → ipcMain.handle，返回值会回到渲染进程
 * 统一返回 { ok, ... } 信封：ok=true 成功，ok=false 时带 error 说明
 * ================================================================ */

// 启动界面：弹出系统文件夹选择框，返回选中的路径
ipcMain.handle('dialog:selectFolder', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWin, {
            title: '选择工作区文件夹',
            properties: ['openDirectory'], // 只允许选文件夹
        })
        if (result.canceled || result.filePaths.length === 0) {
            return { ok: false, canceled: true }
        }
        return { ok: true, path: result.filePaths[0] }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 读取一个目录，返回排序好的条目（文件夹在前，再按名称排序）
ipcMain.handle('fs:readDir', async (_event, dirPath) => {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })
        const items = entries
            .filter((e) => !e.name.startsWith('.')) // 过滤 .git、.env 等隐藏项
            .map((e) => ({
                name: e.name,
                path: path.join(dirPath, e.name),
                isDir: e.isDirectory(),
                isFile: e.isFile(),
            }))
        items.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1 // 文件夹在前
            return a.name.localeCompare(b.name, 'zh')          // 中文友好的排序
        })
        return { ok: true, items }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 读取文本文件内容（UTF-8）


ipcMain.handle('fs:readFile', async (_event, filePath) => {
    try {
        const content = await fs.readFile(filePath, 'utf-8')
        return { ok: true, content: content.replace(/^\uFEFF/, '') }   // 剥离 UTF-8 BOM（Windows 编辑器常见）
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 把内容写回磁盘（覆盖写入；父目录不存在时自动创建，兼容插件写备份目录等场景）
ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, content, 'utf-8')
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 获取文件信息（大小、修改时间），用于编辑器头部展示
ipcMain.handle('fs:stat', async (_event, filePath) => {
    try {
        const s = await fs.stat(filePath)
        return { ok: true, size: s.size, mtimeMs: s.mtimeMs }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 判断路径是否为文件夹（拖放打开时区分文件/文件夹）
ipcMain.handle('fs:isDir', async (_event, targetPath) => {
    try {
        const s = await fs.stat(targetPath)
        return { ok: true, isDir: s.isDirectory() }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 导出工作区备份（H）：复制 .emerald 标签索引 + 生成文件清单 manifest.json
ipcMain.handle('fs:exportWorkspace', async (_event, rootPath, destDir) => {
    if (!rootPath || !destDir) return { ok: false, error: '参数不完整' }
    try {
        await fs.mkdir(destDir, { recursive: true })
        // 1) 标签索引
        let hasIndex = false
        try {
            const idxSrc = path.join(rootPath, '.emerald', 'index.json')
            const st = await fs.stat(idxSrc)
            if (st.isFile()) {
                await fs.mkdir(path.join(destDir, '.emerald'), { recursive: true })
                await fs.copyFile(idxSrc, path.join(destDir, '.emerald', 'index.json'))
                hasIndex = true
            }
        } catch { /* 无索引文件则跳过 */ }
        // 2) 文件清单（跳过隐藏项与 node_modules；destDir 若在工作区内则跳过自身，防止备份被计入清单）
        const files = []
        const walk = async (dir) => {
            let entries
            try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name === 'node_modules') continue
                const full = path.join(dir, e.name)
                // 跳过目标备份目录本身（及工作区外目标）
                if (path.resolve(full) === path.resolve(destDir)) continue
                if (e.isDirectory()) await walk(full)
                else if (e.isFile()) files.push(path.relative(rootPath, full).split('\\').join('/'))
            }
        }
        await walk(rootPath)
        const manifest = {
            app: 'Emerald',
            exportedAt: new Date().toISOString(),
            rootName: path.basename(rootPath),
            fileCount: files.length,
            hasTagIndex: hasIndex,
            files,
        }
        await fs.writeFile(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
        return { ok: true, count: files.length, dest: destDir, hasIndex }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 新建文件夹（mkdir 带 recursive，可一次建多层）
ipcMain.handle('fs:mkdir', async (_event, dirPath) => {
    try {
        await fs.mkdir(dirPath, { recursive: true })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 新建空文件
ipcMain.handle('fs:createFile', async (_event, filePath) => {
    try {
        await fs.writeFile(filePath, '', 'utf-8')
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 重命名 / 移动
ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    try {
        await fs.rename(oldPath, newPath)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 删除（B4）：优先移入系统回收站（可恢复）；回收站不可用时（网络盘等）退回永久删除
ipcMain.handle('fs:delete', async (_event, targetPath) => {
    try {
        await shell.trashItem(targetPath)
        return { ok: true }
    } catch (err) {
        try {
            await fs.rm(targetPath, { recursive: true, force: true })
            return { ok: true }
        } catch (err2) {
            return { ok: false, error: err2.message }
        }
    }
})

// 复制（fs.cp 同时支持单文件与整个文件夹，recursive 递归拷贝）
ipcMain.handle('fs:copy', async (_event, srcPath, destPath) => {
    try {
        // 环路检测：禁止把文件夹复制进它自己的子目录（否则 fs.cp 递归复制到路径爆炸）
        const rel = path.relative(srcPath, destPath)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            return { ok: false, error: '不能把文件夹复制到它自己的子目录中' }
        }
        await fs.cp(srcPath, destPath, { recursive: true })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 在系统文件管理器中定位显示（Windows 资源管理器）
ipcMain.handle('fs:showInFolder', async (_event, targetPath) => {
    try {
        shell.showItemInFolder(targetPath)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 用系统默认程序打开文件（PDF 内置预览渲染失败时的兜底出口）
ipcMain.handle('fs:openPath', async (_event, targetPath) => {
    try {
        const errMsg = await shell.openPath(targetPath)
        return errMsg ? { ok: false, error: errMsg } : { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 用系统默认浏览器打开外链（B1，只放行 http/https/mailto，防止任意协议注入）
ipcMain.handle('shell:openExternal', async (_event, url) => {
    try {
        const u = String(url || '')
        if (!/^(https?:|mailto:)/i.test(u)) return { ok: false, error: '不支持的链接协议' }
        await shell.openExternal(u)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

/* ================================================================
 * Git 集成（#10）：child_process 调 git，cwd 限定在工作区根目录，
 * 参数一律走数组（execFile 不做 shell 解析，天然防注入）
 * ================================================================ */

// 安全执行 git；仅 diff 类命令"有差异"时退出码为 1（opts.allowExit1），视为正常结果
// 其余命令退出码非 0 一律按失败处理（如 git pull 合并冲突时退出码 1 且冲突输出在 stdout，不能误报成功）
// opts.timeout 可选：推送/拉取等网络操作给超时上限，防止无限挂起
async function runGit(rootPath, args, opts) {
    const options = { cwd: rootPath, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    if (opts && opts.timeout) options.timeout = opts.timeout
    try {
        const { stdout } = await execFileP('git', args, options)
        return { ok: true, stdout }
    } catch (err) {
        if (opts && opts.allowExit1 && err.code === 1 && err.stdout) return { ok: true, stdout: err.stdout }
        return { ok: false, error: (err.stderr || err.message || '').trim().slice(0, 300) }
    }
}

// 相对路径合法性：拒绝绝对路径与 .. 逃逸
function safeRelPath(p) {
    if (typeof p !== 'string' || !p) return null
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split(/[\\/]/).includes('..')) return null
    return p.split('\\').join('/')
}

// 工作区 git 状态：git status --porcelain=v1 -z → [{ rel, xy, code, badge }]
ipcMain.handle('git:status', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const r = await runGit(rootPath, ['status', '--porcelain=v1', '-z'])
    if (!r.ok) return r
    const entries = []
    const parts = r.stdout.split('\0')
    for (const p of parts) {
        if (!p) continue
        const xy = p.slice(0, 2)
        let rel = p.slice(3)
        const arrow = rel.indexOf(' -> ')
        if (arrow !== -1) rel = rel.slice(arrow + 4)   // 重命名取新路径
        if (rel.endsWith('/')) rel = rel.slice(0, -1)  // 未跟踪目录去掉尾部斜杠
        const code = xy.trim() === '' ? '??' : xy.trim()
        let badge = '?'
        if (code === '??') badge = 'U'
        else if (code.includes('D')) badge = 'D'
        else if (code.includes('R')) badge = 'R'
        else if (code.includes('C')) badge = 'C'
        else if (code.includes('A')) badge = 'A'
        else if (code.includes('M')) badge = 'M'
        entries.push({ rel, xy, code, badge })
    }
    return { ok: true, entries }
})

// 当前分支名
ipcMain.handle('git:branch', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const r = await runGit(rootPath, ['branch', '--show-current'])
    if (!r.ok) return r
    return { ok: true, branch: r.stdout.trim() || 'HEAD' }
})

/* ---------------- 远程仓库（GitHub 等） ---------------- */

// 远程仓库列表：git remote -v → [{ name, url, push }]
ipcMain.handle('git:remote', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const r = await runGit(rootPath, ['remote', '-v'])
    if (!r.ok) return r
    const remotes = []
    for (const line of r.stdout.split('\n')) {
        const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
        if (!m) continue
        let entry = remotes.find((x) => x.name === m[1])
        if (!entry) { entry = { name: m[1], url: '', push: '' }; remotes.push(entry) }
        if (m[3] === 'fetch') entry.url = m[2]
        else entry.push = m[2]
    }
    return { ok: true, remotes }
})

// 链接 / 更换远程仓库（origin 不存在则 add，已存在则 set-url）
ipcMain.handle('git:setRemote', async (_event, rootPath, name, url) => {
    const n = String(name || 'origin').trim()
    const u = String(url || '').trim()
    if (!n || !u) return { ok: false, error: '远程名或地址为空' }
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(u)) return { ok: false, error: '地址看起来不像 git 仓库地址（如 https://github.com/用户名/仓库.git）' }
    const list = await runGit(rootPath, ['remote'])
    if (!list.ok) return list
    const exists = list.stdout.split('\n').map((s) => s.trim()).includes(n)
    if (exists) return runGit(rootPath, ['remote', 'set-url', n, u])
    return runGit(rootPath, ['remote', 'add', n, u])
})

// 推送当前分支到远程（首次自动设置上游；网络操作给 3 分钟超时）
ipcMain.handle('git:push', async (_event, rootPath, branch) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const b = String(branch || '').trim() || 'HEAD'
    return runGit(rootPath, ['push', '-u', 'origin', b], { timeout: 180000 })
})

// 从远程拉取（使用已设置的上游分支；2 分钟超时）
ipcMain.handle('git:pull', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    return runGit(rootPath, ['pull'], { timeout: 120000 })
})

// 单文件差异（相对工作区根，包含已暂存 + 未暂存 vs HEAD）
ipcMain.handle('git:diff', async (_event, rootPath, relPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const rel = safeRelPath(relPath)
    if (!rel) return { ok: false, error: '非法路径' }
    const r = await runGit(rootPath, ['diff', 'HEAD', '--', rel], { allowExit1: true })
    if (!r.ok) return r
    return { ok: true, diff: r.stdout }
})

// 暂存 / 取消暂存单个文件
ipcMain.handle('git:stage', async (_event, rootPath, relPath) => {
    const rel = safeRelPath(relPath)
    if (!rel) return { ok: false, error: '非法路径' }
    return runGit(rootPath, ['add', '--', rel])
})
ipcMain.handle('git:unstage', async (_event, rootPath, relPath) => {
    const rel = safeRelPath(relPath)
    if (!rel) return { ok: false, error: '非法路径' }
    return runGit(rootPath, ['restore', '--staged', '--', rel])
})

// 暂存全部变更（未勾选任何文件时，提交前自动调用）
ipcMain.handle('git:stageAll', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    return runGit(rootPath, ['add', '-A'])
})

// 提交（只提交已暂存内容）
ipcMain.handle('git:commit', async (_event, rootPath, message) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    const msg = String(message || '').trim()
    if (!msg) return { ok: false, error: '提交说明不能为空' }
    if (msg.length > 200) return { ok: false, error: '提交说明过长（≤200 字）' }
    return runGit(rootPath, ['commit', '-m', msg])
})

// 初始化仓库
ipcMain.handle('git:init', async (_event, rootPath) => {
    if (!rootPath) return { ok: false, error: '无工作区' }
    return runGit(rootPath, ['init'])
})

/* ================================================================
 * AI 助手（#12，BYO-Key 框架）：API Key 用 safeStorage 加密落盘，
 * 请求在主进程发起（Key 不进渲染进程），SSE 流式回传渲染进程
 * ================================================================ */

const AI_CONFIG_FILE = 'emerald-ai.json'

function aiConfigPath() {
    return path.join(app.getPath('userData'), AI_CONFIG_FILE)
}

// 读取 AI 配置；keys（按供应商）与旧 key 字段用 safeStorage 加密，其余明文
async function readAiConfig() {
    const def = {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        key: '',
        keys: {},
    }
    try {
        const raw = await fs.readFile(aiConfigPath(), 'utf-8')
        const cfg = JSON.parse(raw)
        if (cfg.keys && typeof cfg.keys === 'object') {
            // 新版：keys[provider] 逐供应商保存
            for (const k of Object.keys(cfg.keys)) {
                if (!cfg.keys[k]) { delete cfg.keys[k]; continue }
                if (safeStorage.isEncryptionAvailable()) {
                    try { cfg.keys[k] = safeStorage.decryptString(Buffer.from(cfg.keys[k], 'base64')) }
                    catch { delete cfg.keys[k] }
                } else {
                    delete cfg.keys[k]
                    cfg.keyInvalid = true
                }
            }
        } else if (cfg.key) {
            // 旧版单 Key：迁移到 keys[provider]
            if (safeStorage.isEncryptionAvailable()) {
                try {
                    cfg.keys = { [cfg.provider || def.provider]: safeStorage.decryptString(Buffer.from(cfg.key, 'base64')) }
                } catch {
                    cfg.keys = {}
                    cfg.keyInvalid = true
                }
            } else {
                cfg.keys = {}
                cfg.keyInvalid = true
            }
        } else {
            cfg.keys = {}
        }
        return { ...def, ...cfg }
    } catch {
        return def
    }
}

async function writeAiConfig(cfg) {
    const out = { ...cfg }
    // 逐供应商加密 keys 映射；旧 key 字段不再写入
    if (out.keys && typeof out.keys === 'object') {
        for (const k of Object.keys(out.keys)) {
            if (!out.keys[k]) continue
            if (safeStorage.isEncryptionAvailable()) {
                out.keys[k] = safeStorage.encryptString(out.keys[k]).toString('base64')
            } else {
                return { ok: false, error: '系统安全存储不可用，无法安全保存 API Key' }
            }
        }
    }
    delete out.key
    await fs.writeFile(aiConfigPath(), JSON.stringify(out, null, 2), 'utf-8')
    return { ok: true }
}

// 读取配置给渲染进程：绝不返回明文 Key，只给 keySet 标志（Key 只存在于主进程）
ipcMain.handle('ai:getConfig', async () => {
    const cfg = await readAiConfig()
    const keySetMap = {}
    for (const k of Object.keys(cfg.keys || {})) {
        if (cfg.keys[k]) keySetMap[k] = true
    }
    return {
        ok: true,
        config: {
            provider: cfg.provider,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            keySet: !!keySetMap[cfg.provider],
            keySetMap,
            keyInvalid: !!cfg.keyInvalid,
        },
    }
})

ipcMain.handle('ai:saveConfig', async (_e, cfg) => {
    try {
        if (!cfg || typeof cfg !== 'object') return { ok: false, error: '配置无效' }
        const prev = await readAiConfig()
        const provider = cfg.provider || prev.provider
        const keys = { ...(prev.keys || {}) }
        // 渲染进程传空 key = 保留该供应商旧 Key；传新 key 才替换
        if (typeof cfg.key === 'string' && cfg.key.trim()) keys[provider] = cfg.key.trim()
        const next = {
            provider,
            baseUrl: cfg.baseUrl || prev.baseUrl,
            model: cfg.model || prev.model,
            keys,
        }
        return await writeAiConfig(next)
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 当前 AI 请求的控制器（支持取消）
let aiAbort = null

// 供应商展示名（错误提示用）
const AI_PROVIDER_LABELS = {
    deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Claude', gemini: 'Google Gemini',
    moonshot: 'Kimi', zhipu: '智谱 GLM', qwen: '通义千问', groq: 'Groq', ollama: 'Ollama', custom: '自定义',
}

// 流式对话：从配置读取 Key，主进程 fetch（OpenAI 兼容 /chat/completions 或 Anthropic Messages API）
ipcMain.handle('ai:chat', async (event, messages) => {
    const cfg = await readAiConfig()
    const provider = cfg.provider || 'deepseek'
    const key = (cfg.keys && cfg.keys[provider]) || ''
    if (!key) {
        return { ok: false, error: '未配置 ' + (AI_PROVIDER_LABELS[provider] || provider) + ' 的 API Key（点 AI 面板 ⚙ 设置，或用下方 💎 按钮切换模型后配置）' }
    }
    if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: '消息为空' }

    const ctrl = new AbortController()
    aiAbort = ctrl
    // 整体超时：SSE 中途挂起（收到 headers 后不再吐数据）时 120s 强制结束，避免 invoke 永久 pending
    const hardTimer = setTimeout(() => ctrl.abort(), 120000)
    const isAnthropic = provider === 'anthropic'
    const base = (cfg.baseUrl || '').replace(/\/+$/, '')
    const url = base + (isAnthropic ? '/messages' : '/chat/completions')
    try {
        let resp
        if (isAnthropic) {
            // Anthropic Messages API：system 走顶层字段（多条 system 合并），鉴权用 x-api-key
            const sysTexts = messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean)
            const body = {
                model: cfg.model || 'claude-sonnet-4-5',
                messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
                max_tokens: 8192,
                stream: true,
            }
            if (sysTexts.length) body.system = sysTexts.join('\n\n')
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            })
        } else {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                },
                body: JSON.stringify({
                    model: cfg.model || 'deepseek-chat',
                    messages,
                    stream: true,
                }),
                signal: ctrl.signal,
            })
        }
        if (!resp.ok) {
            const text = await resp.text().catch(() => '')
            return { ok: false, error: 'AI 服务错误 ' + resp.status + '：' + text.slice(0, 200) }
        }
        // 解析 SSE 流：OpenAI 兼容用 choices[0].delta.content；Anthropic 用 content_block_delta.text
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop()   // 最后一段可能不完整
            for (const line of lines) {
                const t = line.trim()
                if (!t.startsWith('data:')) continue
                const data = t.slice(5).trim()
                if (data === '[DONE]') continue
                try {
                    const json = JSON.parse(data)
                    if (isAnthropic) {
                        if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
                            event.sender.send('ai:chunk', { text: json.delta.text })
                        }
                    } else {
                        const delta = json.choices && json.choices[0] && json.choices[0].delta
                        if (delta && delta.content) {
                            event.sender.send('ai:chunk', { text: delta.content })
                        }
                    }
                } catch { /* 忽略无法解析的片段 */ }
            }
        }
        event.sender.send('ai:done', { ok: true })
        return { ok: true }
    } catch (err) {
        if (err.name === 'AbortError') {
            event.sender.send('ai:done', { ok: true, aborted: true })
            return { ok: true, aborted: true }
        }
        event.sender.send('ai:done', { ok: false, error: (err.message || '').slice(0, 200) })
        return { ok: false, error: err.message }
    } finally {
        clearTimeout(hardTimer)   // 清理整体超时
        aiAbort = null
    }
})

// 取消当前流式请求
ipcMain.handle('ai:abort', async () => {
    if (aiAbort) aiAbort.abort()
    return { ok: true }
})

// 递归搜索文件名，最多 200 条结果；遍历文件数上限 20000，防止超大目录全盘扫描卡主进程。
// 跳过隐藏项和 node_modules（噪音大），无法读取的目录静默跳过。
ipcMain.handle('fs:search', async (_event, rootPath, query) => {
    try {
        const q = String(query || '').toLowerCase()
        if (!q) return { ok: true, results: [] }
        const results = []
        const MAX = 200
        let visited = 0
        const MAX_VISITED = 20000
        const walk = async (dir) => {
            if (visited >= MAX_VISITED) return
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return // 无权限的目录直接跳过
            }
            for (const e of entries) {
                if (results.length >= MAX || visited >= MAX_VISITED) return
                if (e.name.startsWith('.')) continue
                if (e.name === 'node_modules') continue
                visited++
                const full = path.join(dir, e.name)
                if (e.name.toLowerCase().includes(q)) {
                    results.push({
                        name: e.name,
                        path: full,
                        isDir: e.isDirectory(),
                        isFile: e.isFile(),
                    })
                    if (results.length >= MAX) return
                }
                if (e.isDirectory()) await walk(full)
            }
        }
        await walk(rootPath)
        return { ok: true, results }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 全文内容搜索：递归读取文本文件，逐行匹配关键字，返回命中行。
// 与 fs:search 不同：fs:search 只匹配文件名，这里匹配文件内容（用于"记不清文件名只记得内容"的场景）。
// 保护性限制：最多遍历 2000 个文件、单文件 ≤ 512KB、跳过二进制；最多 50 个文件、每文件最多 5 条命中。
ipcMain.handle('fs:searchContent', async (_event, rootPath, query) => {
    try {
        const q = String(query || '').toLowerCase()
        if (!q) return { ok: true, results: [] }
        const results = []
        const MAX_FILES = 2000
        const MAX_RESULT_FILES = 50
        const MAX_MATCHES_PER_FILE = 5
        let visited = 0

        const walk = async (dir) => {
            if (results.length >= MAX_RESULT_FILES) return
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return // 无权限的目录直接跳过
            }
            for (const e of entries) {
                if (results.length >= MAX_RESULT_FILES || visited >= MAX_FILES) return
                if (e.name.startsWith('.')) continue
                if (e.name === 'node_modules') continue
                const full = path.join(dir, e.name)
                if (e.isDirectory()) {
                    await walk(full)
                    continue
                }
                if (!e.isFile()) continue
                visited++
                let content
                try {
                    const s = await fs.stat(full)
                    if (s.size > 512 * 1024) continue // 跳过超大文件
                    content = await fs.readFile(full, 'utf-8')
                } catch {
                    continue // 读不了（二进制/无权限）直接跳过
                }
                if (content.indexOf('\x00') !== -1) continue // 含空字符视为二进制
                const matches = []
                const lines = content.split('\n')
                for (let li = 0; li < lines.length && matches.length < MAX_MATCHES_PER_FILE; li++) {
                    if (lines[li].toLowerCase().includes(q)) {
                        matches.push({
                            lineNum: li + 1, // 1-based 行号
                            text: lines[li].trim().slice(0, 200), // 截断避免撑爆结果面板
                        })
                    }
                }
                if (matches.length) {
                    results.push({ path: full, name: e.name, matches })
                }
            }
        }
        await walk(rootPath)
        return { ok: true, results }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 知识图谱（#13）：扫描工作区全部 Markdown，解析 [[wikilink]]，返回节点与边。
// 节点 = 每个 .md 文件（rel 为 posix 相对路径）；边 = 文件 A 中 [[目标]] 指向文件 B。
// 保护性限制：最多遍历 400 个 md（布局为 O(n²)，超限截断）、单文件 ≤ 512KB、跳过二进制。
ipcMain.handle('fs:scanLinks', async (_event, rootPath) => {
    try {
        const nodes = []            // { rel, name }
        const links = []            // { from: rel, to: rel }
        const nameIndex = new Map() // 小写 basename(去.md) → [rel, ...]（同名多文件）
        const pathIndex = new Map() // 小写 rel(去.md) → rel（支持 [[子目录/笔记]]）
        const MAX_NODES = 400
        let visited = 0

        const walk = async (dir) => {
            if (nodes.length >= MAX_NODES) return
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }
            for (const e of entries) {
                if (nodes.length >= MAX_NODES) return
                if (e.name.startsWith('.')) continue
                if (e.name === 'node_modules') continue
                const full = path.join(dir, e.name)
                if (e.isDirectory()) {
                    await walk(full)
                    continue
                }
                if (!e.isFile() || !/\.md$/i.test(e.name)) continue
                if (++visited > 2000) return
                const rel = path.relative(rootPath, full).split(path.sep).join('/')
                nodes.push({ rel, name: e.name })
                const lowerName = e.name.replace(/\.md$/i, '').toLowerCase()
                if (!nameIndex.has(lowerName)) nameIndex.set(lowerName, [])
                nameIndex.get(lowerName).push(rel)
                pathIndex.set(rel.replace(/\.md$/i, '').toLowerCase(), rel)
            }
        }
        await walk(rootPath)

        // [[目标]] 解析：优先精确路径（含 /），否则按 basename 匹配（取同名第一个）
        const resolveTarget = (raw) => {
            const t = String(raw || '').trim()
            if (!t) return null
            const clean = t.replace(/\.md$/i, '')
            if (clean.includes('/')) {
                const hit = pathIndex.get(clean.toLowerCase())
                if (hit) return hit
            }
            const arr = nameIndex.get(clean.toLowerCase())
            return arr && arr.length ? arr[0] : null
        }

        for (const n of nodes) {
            const abs = path.join(rootPath, n.rel.split('/').join(path.sep))
            let content
            try {
                const s = await fs.stat(abs)
                if (s.size > 512 * 1024) continue
                content = await fs.readFile(abs, 'utf-8')
            } catch {
                continue
            }
            if (content.indexOf('\x00') !== -1) continue
            // [[目标]] / [[目标#锚点]] / [[目标|显示名]] / [[目标.md]]
            const re = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g
            let m
            while ((m = re.exec(content)) !== null) {
                const to = resolveTarget(m[1])
                if (to && to !== n.rel) links.push({ from: n.rel, to })
            }
        }
        return { ok: true, nodes, links, truncated: nodes.length >= MAX_NODES }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 插件系统（#14）：加载用户脚本。
// 来源：用户数据目录 plugins/（全局）+ 工作区 .emerald/plugins/（项目内）。
// 返回每个 .js 文件的源码，渲染进程在 iframe 沙箱里执行（隔离）。
// 保护边界：最多 50 个插件、单文件 ≤ 256KB（先 stat 跳过超大文件，防止整读大文件经 IPC 全量下发）。
ipcMain.handle('fs:loadPlugins', async (_event, rootPath) => {
    try {
        const dirs = []
        dirs.push({ dir: path.join(app.getPath('userData'), 'plugins'), scope: 'user' })
        if (rootPath) dirs.push({ dir: path.join(rootPath, '.emerald', 'plugins'), scope: 'workspace' })
        const plugins = []
        const MAX_PLUGINS = 50
        const MAX_SIZE = 256 * 1024
        for (const { dir, scope } of dirs) {
            if (plugins.length >= MAX_PLUGINS) break
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                continue // 目录不存在则跳过
            }
            for (const e of entries) {
                if (plugins.length >= MAX_PLUGINS) break
                if (!e.isFile() || !/\.js$/i.test(e.name)) continue
                const full = path.join(dir, e.name)
                try {
                    const s = await fs.stat(full)
                    if (s.size > MAX_SIZE) continue   // 超大文件跳过（可能是误放的资源）
                    const content = await fs.readFile(full, 'utf-8')
                    plugins.push({ name: e.name, path: full, content, scope })
                } catch {
                    // 读不了的插件跳过
                }
            }
        }
        return { ok: true, plugins }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 插件商店：安装（写文件到用户数据目录 plugins/）+ 卸载（删除文件）
ipcMain.handle('fs:installPlugin', async (_event, fileName, content) => {
    try {
        const safe = String(fileName || '').replace(/[^a-zA-Z0-9._-]/g, '_')
        if (!/\.js$/i.test(safe)) return { ok: false, error: '文件名必须以 .js 结尾' }
        if (String(content || '').length > 1024 * 1024) return { ok: false, error: '插件内容超过 1MB 限制' }
        const dir = path.join(app.getPath('userData'), 'plugins')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, safe), String(content), 'utf-8')
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

ipcMain.handle('fs:uninstallPlugin', async (_event, fileName) => {
    try {
        const safe = String(fileName || '').replace(/[^a-zA-Z0-9._-]/g, '_')
        if (!/\.js$/i.test(safe)) return { ok: false, error: '文件名必须以 .js 结尾' }   // 与 installPlugin 一致
        const full = path.join(app.getPath('userData'), 'plugins', safe)
        await fs.rm(full, { force: true })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

app.whenReady().then(() => {
    createMainWindow()
})
