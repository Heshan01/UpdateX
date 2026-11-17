const { contextBridge, ipcRenderer } = require("electron");

// Only fixed window and agent controls cross into the renderer. No
// filesystem, process, arbitrary command, or unrestricted IPC is exposed.
contextBridge.exposeInMainWorld("updatePilotDesktop", Object.freeze({
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  getAgentStatus: () => ipcRenderer.invoke("agent:status"),
  restartAgent: () => ipcRenderer.invoke("agent:restart"),
  openMicrosoftStore: () => ipcRenderer.invoke("store:open-updates"),
  openMicrosoftStoreProduct: packageFamilyName => ipcRenderer.invoke("store:open-product", packageFamilyName),
  activateLicense: licenseKey => ipcRenderer.invoke("license:activate", licenseKey),
  getLicenseStatus: () => ipcRenderer.invoke("license:status"),
  changeLicense: licenseKey => ipcRenderer.invoke("license:change", licenseKey),
  deactivateLicense: () => ipcRenderer.invoke("license:deactivate"),
}));
