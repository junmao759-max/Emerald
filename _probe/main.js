const { app, BrowserWindow } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 900, height: 1400, show: false,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    })
    await win.loadFile(path.join(__dirname, 'edit-probe.html'))
    // wait a tick so layout settles
    await new Promise((r) => setTimeout(r, 300))
    const result = await win.webContents.executeJavaScript('window.__PROBE_DONE__ ? document.getElementById("out").textContent : "NOT READY"')
    console.log(result)
    app.exit(0)
})
