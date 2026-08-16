const { app, BrowserWindow } = require("electron")
const path = require("path")
const os = require("os")
const fs = require("fs")
const stamp = Date.now()
const OUT = path.join(os.tmpdir(), "emerald-edge-" + stamp + ".json")
app.setPath("userData", path.join(os.tmpdir(), "emerald-edge-ud-" + stamp))
app.on("window-all-closed", () => {})
process.on("uncaughtException", (err) => { app.exit(2) })
require("./index.js")
app.whenReady().then(async () => {
  setTimeout(() => app.exit(9), 30000)
  try {
    await new Promise((r) => setTimeout(r, 2000))
    const win = BrowserWindow.getAllWindows()[0]
    const FIXTURE = path.join(__dirname, "_fixture")
    const session = { rootPath: FIXTURE, tabs: [{ path: path.join(FIXTURE, "code.js"), name: "code.js" }], activeTabId: path.join(FIXTURE, "code.js"), cursorLine: 1, cursorCol: 1, viewMode: "edit", sidebarCollapsed: false, sortMode: "name" }
    await win.webContents.executeJavaScript('localStorage.setItem("emerald-session", ' + JSON.stringify(JSON.stringify(session)) + ')')
    win.webContents.reload()
    await new Promise((r) => setTimeout(r, 3000))
    const r = await win.webContents.executeJavaScript(`(async () => {
      const out = {}
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      // 非 md 文件：textarea 模式（非 liveEditor）
      const P = curPaneEls()
      out.nonMdTextareaVisible = P.editor && !P.editor.classList.contains('hidden')
      out.nonMdLiveHidden = P.liveEditor.classList.contains('hidden')
      // 语法高亮在非 md？
      out.editorHasCode = P.editor.value.includes('console.log')
      // 图谱：无 md 文件 → 空态
      openGraph()
      await wait(2000)
      out.graphEmptyShown = !els.graphEmpty.classList.contains('hidden')
      out.graphDataNull = graphData === null
      closeGraph()
      // 高亮器（悬浮预览）
      const hp = document.createElement('div')
      hp.className = 'hoverPreview'
      hp.innerHTML = '<div class="md-body">' + window.SyntaxHighlighter.highlight('const a = 1', 'js') + '</div>'
      out.highlighterWorks = hp.innerHTML.includes('tok-keyword') || hp.innerHTML.includes('<span')
      // 空工作区按钮
      out.emptyBtnExists = !!els.emptyOpenFolderBtn
      return out
    })()`)
    fs.writeFileSync(OUT, JSON.stringify(r, null, 2))
    app.exit(0)
  } catch (e) {
    fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }))
    app.exit(1)
  }
})
