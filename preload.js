const { contextBridge, ipcRenderer } = require('electron')

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

    // ---------- 外链 / 外部打开（B1） ----------
    // 用系统浏览器打开 http/https/mailto 链接
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
})
