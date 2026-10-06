const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  openGestureStudio: (id) => ipcRenderer.invoke("lewis:open-gestures", id),
  closeGestureStudio: () => ipcRenderer.send("lewis:close-gestures"),
  setAppearance: (theme) => ipcRenderer.send("lewis:appearance", theme),
  setPetStyle: (style) => ipcRenderer.invoke("lewis:pet-style", style),
  update: (action, value) => ipcRenderer.invoke("lewis:update", action, value),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("lewis:update", listener);
    return () => ipcRenderer.removeListener("lewis:update", listener);
  },
  credentialsGet: () => ipcRenderer.invoke("lewis:credentials-get"),
  credentialsSet: (value) => ipcRenderer.invoke("lewis:credentials-set", value),
  captureDesktop: () => ipcRenderer.invoke("lewis:capture-screen"),
  openMain: () => ipcRenderer.send("lewis:open-main"),
  hidePet: () => ipcRenderer.send("lewis:hide-pet"),
  showPet: () => ipcRenderer.send("lewis:show-pet"),
  webOpen: (url) => ipcRenderer.invoke("lewis:web-open", url),
  webLayout: (data) => ipcRenderer.send("lewis:web-layout", data),
  webControl: (action) => ipcRenderer.invoke("lewis:web-control", action),
  onWebState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("lewis:web-state", listener);
    return () => ipcRenderer.removeListener("lewis:web-state", listener);
  },
  voiceReady: () => ipcRenderer.invoke("lewis:voice-ready"),
  voiceStatus: (data) => ipcRenderer.send("lewis:voice-status", data),
  petHitRegions: (data) => ipcRenderer.send("lewis:pet-hit-regions", data),
  petDragging: (dragging) => ipcRenderer.send("lewis:pet-dragging", dragging),
  petMenu: () => ipcRenderer.send("lewis:pet-menu"),
  hide: () => ipcRenderer.send("lewis:hide-pet"),
  movePet: (delta) => ipcRenderer.send("lewis:move-pet", delta),
  publish: (data) => ipcRenderer.send("lewis:message", data),
  onMessage: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("lewis:message", listener);
    return () => ipcRenderer.removeListener("lewis:message", listener);
  },
});
