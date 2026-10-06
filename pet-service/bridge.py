"""MIT upstream desktop pet, adapted to reuse Lewis tasks and its protected model settings.
No API key is copied into this process or its configuration. JSON lines use private process pipes.
"""
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import threading

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "vendor" / "dafeiyu-pet" / "桌宠.py"
spec = importlib.util.spec_from_file_location("dafeiyu_upstream", SOURCE)
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QPixmap, QRegion
from PySide6.QtWidgets import QApplication, QWidget, QMenu

DATA = Path(os.environ.get("LEWIS_PET_DATA", str(Path(__file__).parent / "data")))
DATA.mkdir(parents=True, exist_ok=True)
upstream.CONFIG_PATH = str(DATA / "appearance.json")
upstream.SIZE_LEVELS = {"迷你": 0.35, "小": 0.45, "中": 0.55}
if not Path(upstream.CONFIG_PATH).exists():
    Path(upstream.CONFIG_PATH).write_text(json.dumps({"mode":"still","size":0.35,"topmost":True,"passthrough":False,"autostart":False,"x":None,"y":None,"city":"Shanghai"}), encoding="utf-8")
commands = queue.Queue(maxsize=64)

def emit(kind, **payload):
    print("LEWIS_PET " + json.dumps({"type":kind, **payload}, ensure_ascii=False), flush=True)

def listen():
    try:
        for line in sys.stdin:
            if len(line)>16000: continue
            try:
                data=json.loads(line)
                commands.put(data, timeout=1)
            except (ValueError, queue.Full): pass
    finally:
        commands.put({"type":"shutdown"})

class LewisPet(upstream.PetWindow):
    def show(self):
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        super().show()
    def hide(self):
        for name in ("chat_dialog", "function_panel", "food_panel"):
            panel = getattr(self, name, None)
            if panel: panel.hide()
        super().hide()
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Lewis · 大肥鱼桌宠")
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.tray.hide()  # Lewis owns the single tray and lifetime.
        self.pipe_timer=QTimer(self); self.pipe_timer.timeout.connect(self.receive); self.pipe_timer.start(100)
        self.mask_timer=QTimer(self); self.mask_timer.timeout.connect(self.refresh_mask); self.mask_timer.start(200)
        self.refresh_mask()
        emit("ready", width=self.width(), height=self.height())
    def _call_ds(self, text):
        if not text.strip(): return
        emit("task", text=text[:2000])
        self.say("交给 Lewis 处理…")
    def _show_chat_dialog(self):
        self.chat_dialog.popup_at(self.x()+self.width()/2, self.y()+upstream.BUBBLE_H)
    def _get_weather(self):
        self._call_ds("查询"+self.cfg.get("city", "Shanghai")+"天气")
    def _build_menu(self):
        menu=QMenu(self)
        menu.addAction("打开 Lewis", lambda:emit("open-main"))
        modes=menu.addMenu("活动方式")
        for name, mode in [("原地待着","still"),("自由散步","wander"),("跟随鼠标","follow")]:
            action=modes.addAction(name); action.setCheckable(True);action.setChecked(self.mode==mode)
            action.triggered.connect(lambda checked=False,m=mode:self.set_mode(m))
        sizes=menu.addMenu("大小")
        for name, size in upstream.SIZE_LEVELS.items(): sizes.addAction(name, lambda checked=False,s=size:self.set_size(s))
        menu.addAction("喂食",lambda:self.food_panel.popup_at(self.x()+self.width()/2,self.y()+upstream.BUBBLE_H))
        menu.addAction("回到屏幕内", self.snap_into_screen)
        menu.addAction("隐藏桌宠", self.hide)
        return menu
    def receive(self):
        for _ in range(20):
            try: data=commands.get_nowait()
            except queue.Empty: break
            kind=data.get("type")
            if kind=="show": self.show();self.snap_into_screen()
            elif kind=="hide": self.hide();self.chat_dialog.hide();self.function_panel.hide();self.food_panel.hide()
            elif kind=="say": self.say(str(data.get("text", ""))[:80])
            elif kind=="topmost": self.set_topmost(bool(data.get("value")))
            elif kind=="state": self.chat_paused=data.get("state") in ("thinking","speaking")
            elif kind=="shutdown": self.quit_app()
    def refresh_mask(self):
        # Use painted alpha, including a visible bubble. Transparent padding never blocks desktop icons.
        pix=QPixmap(self.size());pix.fill(Qt.GlobalColor.transparent)
        self.render(pix, renderFlags=QWidget.RenderFlag.DrawWindowBackground | QWidget.RenderFlag.DrawChildren | QWidget.RenderFlag.IgnoreMask)
        region=QRegion(pix.mask())
        if not region.isEmpty(): self.setMask(region)
    def quit_app(self):
        self.cfg.pop("ds_api_key",None)
        self.cfg["x"],self.cfg["y"]=self.x(),self.y()
        Path(upstream.CONFIG_PATH).write_text(json.dumps(self.cfg,ensure_ascii=False),encoding="utf-8")
        self.tray.hide();QApplication.quit()

if __name__=="__main__":
    app=QApplication(sys.argv);app.setQuitOnLastWindowClosed(False)
    pet=LewisPet();threading.Thread(target=listen,daemon=True).start()
    sys.exit(app.exec())
