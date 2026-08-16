const { contextBridge, ipcRenderer, webUtils } = require('electron')

/* ================================================================
 * preload 是渲染进程与主进程之间的“安全桥”。
 * contextIsolation:true 时，渲染进程拿不到 Node 能力，
 * 只能调用这里用 contextBridge 显式暴露的方法。
 *
 * - 窗口控制：send → on（通知型）
 * - 文件系统：invoke → handle（请求/响应型，await 拿结果）
 * ================================================================ */
contextBridge.exposeInMainWorld('electronAPI', {
    // ---------- 窗口控制 ----------
    minimize: () => ipcRenderer.send('minimize'),
    fullscreen: () => ipcRenderer.send('fullscreen'),
    closeWindow: () => ipcRenderer.send('closeWindow'),
    // 主进程请求确认关闭（B2）：渲染进程检查未保存修改后，调用 doClose 放行
    onConfirmClose: (cb) => ipcRenderer.on('app:confirm-close', () => cb()),
    doClose: () => ipcRenderer.send('app:do-close'),

    // ---------- 文件系统（读写） ----------
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    getFileInfo: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    isDir: (targetPath) => ipcRenderer.invoke('fs:isDir', targetPath),
    // H：导出工作区备份（.emerald 索引 + 文件清单）到指定目录
    exportWorkspace: (rootPath, destDir) => ipcRenderer.invoke('fs:exportWorkspace', rootPath, destDir),
    // 拖放：把 File 对象解析为绝对路径（Electron 32+ 已移除 File.path，改用 webUtils）
    getPathForFile: (file) => webUtils.getPathForFile(file),

    // ---------- 文件系统（管理） ----------
    createDir: (dirPath) => ipcRenderer.invoke('fs:mkdir', dirPath),
    createFile: (filePath) => ipcRenderer.invoke('fs:createFile', filePath),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    remove: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),
    copy: (srcPath, destPath) => ipcRenderer.invoke('fs:copy', srcPath, destPath),
    showInFolder: (targetPath) => ipcRenderer.invoke('fs:showInFolder', targetPath),
    openPath: (targetPath) => ipcRenderer.invoke('fs:openPath', targetPath),

    // ---------- 文件搜索 ----------
    search: (rootPath, query) => ipcRenderer.invoke('fs:search', rootPath, query),
    // 全文内容搜索：返回 { ok, results: [{ path, name, matches: [{ lineNum, text }] }] }
    searchContent: (rootPath, query) => ipcRenderer.invoke('fs:searchContent', rootPath, query),
    // 知识图谱（#13）：扫描全部 Markdown 解析 [[wikilink]]
    // 返回 { ok, nodes: [{ rel, name }], links: [{ from, to }], truncated }
    scanLinks: (rootPath) => ipcRenderer.invoke('fs:scanLinks', rootPath),
    // 插件系统（#14）：加载用户脚本源码
    // 返回 { ok, plugins: [{ name, path, content, scope }] }
    loadPlugins: (rootPath) => ipcRenderer.invoke('fs:loadPlugins', rootPath),
    // 插件商店：安装（写入用户数据目录 plugins/）/ 卸载（删除）
    installPlugin: (fileName, content) => ipcRenderer.invoke('fs:installPlugin', fileName, content),
    uninstallPlugin: (fileName) => ipcRenderer.invoke('fs:uninstallPlugin', fileName),

    // ---------- 外链 / 外部打开（B1） ----------
    // 用系统浏览器打开 http/https/mailto 链接
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    // ---------- Git 集成（#10） ----------
    // 工作区 git 状态：{ ok, entries: [{ rel, xy, code, badge }] }（badge: M/A/U/D/R/C）
    gitStatus: (rootPath) => ipcRenderer.invoke('git:status', rootPath),
    gitBranch: (rootPath) => ipcRenderer.invoke('git:branch', rootPath),
    gitDiff: (rootPath, relPath) => ipcRenderer.invoke('git:diff', rootPath, relPath),
    gitStage: (rootPath, relPath) => ipcRenderer.invoke('git:stage', rootPath, relPath),
    gitUnstage: (rootPath, relPath) => ipcRenderer.invoke('git:unstage', rootPath, relPath),
    gitStageAll: (rootPath) => ipcRenderer.invoke('git:stageAll', rootPath),
    gitCommit: (rootPath, message) => ipcRenderer.invoke('git:commit', rootPath, message),
    gitInit: (rootPath) => ipcRenderer.invoke('git:init', rootPath),
    // 远程仓库（GitHub 等）
    gitRemote: (rootPath) => ipcRenderer.invoke('git:remote', rootPath),
    gitSetRemote: (rootPath, name, url) => ipcRenderer.invoke('git:setRemote', rootPath, name, url),
    gitPush: (rootPath, branch) => ipcRenderer.invoke('git:push', rootPath, branch),
    gitPull: (rootPath) => ipcRenderer.invoke('git:pull', rootPath),

    // ---------- AI 助手（#12，BYO-Key） ----------
    // 配置读写（Key 主进程用 safeStorage 加密落盘）；对话为主进程流式请求
    aiGetConfig: () => ipcRenderer.invoke('ai:getConfig'),
    aiSaveConfig: (cfg) => ipcRenderer.invoke('ai:saveConfig', cfg),
    aiChat: (messages) => ipcRenderer.invoke('ai:chat', messages),
    aiAbort: () => ipcRenderer.invoke('ai:abort'),
    // 流式回传：ai:chunk（增量文本）/ ai:done（结束）
    onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, d) => cb(d)),
    onAiDone: (cb) => ipcRenderer.on('ai:done', (_e, d) => cb(d)),
})
