using System;
using System.Runtime.InteropServices;
using System.Windows;
internal static class WechatBridgeTests
{
    private static int Main()
    {
        if (WeChatBridge.NewMessage(new[] { "old" }, "old", "你好", "你好")) return 1;
        if (WeChatBridge.NewMessage(new[] { "old" }, "new", "你好呀", "你好")) return 2;
        if (!WeChatBridge.NewMessage(new[] { "old" }, "new", "张三\n你好", "你好")) return 3;
        if (!WeChatBridge.NewMessage(new[] { "old" }, "new", "第一行\r\n第二行", "第一行\n第二行")) return 4;
        try { WeChatBridge.Validate("send", "", "你好"); return 5; } catch { }
        try { WeChatBridge.Validate("send", "张三", ""); return 6; } catch { }
        try { WeChatBridge.Validate("send", "张三", new String('a', 2001)); return 7; } catch { }
        WeChatBridge.Validate("send", "文件传输助手", "你好，🙂");
        // Native INPUT must have the correct x64 union alignment; click emits exactly one down/up pair.
        if (Marshal.SizeOf(typeof(WeChatMouse.NativeInput)) != 40) return 8;
        var events = WeChatMouse.ButtonEvents();
        if (events.Length != 2 || events[0].Type != 0 || events[0].Data.Mouse.Flags != 2 || events[1].Data.Mouse.Flags != 4) return 9;
        var button = new Rect(450, 600, 80, 30); var window = new Rect(0, 0, 800, 700); var center = new Point(490, 615);
        WeChatMouse.ValidateClickTarget(button, window, center, true, true, true, true);
        // A screen on the left uses negative physical coordinates; no single-monitor assumptions.
        WeChatMouse.ValidateClickTarget(new Rect(-1200, 300, 80, 30), new Rect(-1600, 0, 1200, 900), new Point(-1160, 315), true, true, true, true);
        Action[] unsafeClicks = {
            delegate { WeChatMouse.ValidateClickTarget(button, window, center, false, true, true, true); },
            delegate { WeChatMouse.ValidateClickTarget(button, window, center, true, false, true, true); },
            delegate { WeChatMouse.ValidateClickTarget(button, window, center, true, true, false, true); },
            delegate { WeChatMouse.ValidateClickTarget(button, window, new Point(400, 615), true, true, true, true); },
            delegate { WeChatMouse.ValidateClickTarget(Rect.Empty, window, center, true, true, true, true); },
            delegate { WeChatMouse.ValidateClickTarget(button, new Rect(0, 0, 100, 100), center, true, true, true, true); },
            delegate { WeChatMouse.ValidateClickTarget(button, window, new Point(Double.NaN, 615), true, true, true, true); },
        };
        foreach (var click in unsafeClicks) { bool rejected = false; try { click(); } catch { rejected = true; } if (!rejected) return 10; }
        Console.WriteLine("PASS: native message confirmation, send validation, single-click ABI, occlusion/focus/geometry guards and multi-monitor pixels.");
        return 0;
    }
}
