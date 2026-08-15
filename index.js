const { BrowserWindow, app, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs/promises')

let mainWin
let allowClose = false   // 用户确认关闭后置 true，放行第二次 close（配合 close 拦截）
let pageLoaded = false   // 页面加载完成前放行关闭，避免 close 拦截卡死启动过程

function createMainWindow() {
    mainWin = new BrowserWindow({
        width: 1000,
        height: 800,
        resizable: true,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
    })
    mainWin.webContents.on('did-finish-load', () => { pageLoaded = true })

    // 安全网（B1）：任何让应用窗口离开本应用的导航都拦下来。
    // 预览里点普通 Markdown 链接（http/https/mailto）→ 系统浏览器打开，而不是把整个应用导航走
    mainWin.webContents.on('will-navigate', (e, url) => {
        if (!/^(https?:|mailto:)/i.test(url)) return   // file:// 内部页面放行
        e.preventDefault()
        shell.openExternal(url)
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
        return { ok: true, content }
    } catch (err) {
        return { ok: false, error: err.message }
    }
})

// 把内容写回磁盘（覆盖写入）
ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
    try {
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

// 递归搜索文件名，最多 200 条结果。
// 跳过隐藏项和 node_modules（噪音大），无法读取的目录静默跳过。
ipcMain.handle('fs:search', async (_event, rootPath, query) => {
    try {
        const q = String(query || '').toLowerCase()
        if (!q) return { ok: true, results: [] }
        const results = []
        const MAX = 200
        const walk = async (dir) => {
            let entries
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return // 无权限的目录直接跳过
            }
            for (const e of entries) {
                if (results.length >= MAX) return
                if (e.name.startsWith('.')) continue
                if (e.name === 'node_modules') continue
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

app.whenReady().then(() => {
    createMainWindow()
})
