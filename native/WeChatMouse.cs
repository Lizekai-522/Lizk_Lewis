using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

// Real clicks are limited to UIA-identified controls inside the verified Weixin window.
// No coordinates, arbitrary keys or executable names are accepted from a user/model request.
internal static class WeChatMouse
{
    [StructLayout(LayoutKind.Sequential)] internal struct NativePoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)] internal struct InputData
    {
        [FieldOffset(0)] public MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct NativeInput { public uint Type; public InputData Data; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, NativeInput[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    internal static void UsePhysicalPixels()
    {
        // UIA bounding rectangles are screen pixels. Prevent Windows DPI virtualization of point APIs.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
    }
    private static IntPtr Root(IntPtr hwnd) { return hwnd == IntPtr.Zero ? hwnd : GetAncestor(hwnd, 2); }
    private static bool IsForeground(IntPtr hwnd) { return Root(GetForegroundWindow()) == hwnd; }
    internal static IntPtr ForegroundWindow() { return GetForegroundWindow(); }
    internal static void RestoreForeground(IntPtr previous, IntPtr wechat)
    {
        if (previous != IntPtr.Zero && Root(previous) != wechat && IsForeground(wechat)) SetForegroundWindow(previous);
    }
    private static bool ContainsElement(AutomationElement target, Point point)
    {
        var expected = target.GetRuntimeId(); var hit = AutomationElement.FromPoint(point);
        for (int depth = 0; hit != null && depth < 40; depth++, hit = TreeWalker.RawViewWalker.GetParent(hit))
        {
            var actual = hit.GetRuntimeId();
            if (actual.Length != expected.Length) continue;
            bool same = true;
            for (int i = 0; i < actual.Length; i++) if (actual[i] != expected[i]) { same = false; break; }
            if (same) return true;
        }
        return false;
    }
    internal static void ValidateClickTarget(Rect control, Rect window, Point point, bool ownWindow, bool hitsControl, bool foreground, bool requireForeground)
    {
        if (control.IsEmpty || window.IsEmpty || control.Width <= 0 || control.Height <= 0
            || Double.IsNaN(point.X) || Double.IsNaN(point.Y) || Double.IsInfinity(point.X) || Double.IsInfinity(point.Y)
            || !control.Contains(point) || !window.Contains(point)) throw new Exception("微信控件位置不可用，已停止点击");
        if (!ownWindow || !hitsControl) throw new Exception("微信控件被其他窗口遮挡或位置已变化，已停止点击");
        if (requireForeground && !foreground) throw new Exception("微信没有取得前台焦点，已停止发送，请打开微信后再试");
    }
    internal static NativeInput[] ButtonEvents()
    {
        return new[] {
            new NativeInput { Type = 0, Data = new InputData { Mouse = new MouseInput { Flags = 0x0002 } } },
            new NativeInput { Type = 0, Data = new InputData { Mouse = new MouseInput { Flags = 0x0004 } } },
        };
    }
    private static void NoHeldKeys()
    {
        foreach (int key in new[] { 1, 2, 16, 17, 18, 91, 92 })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new Exception("检测到鼠标或修饰键正被按住，已停止点击，请松开后再执行");
    }
    internal static void Click(AutomationElement window, AutomationElement target, IntPtr hwnd, bool requireForeground, Action recheck, Action beforeInput)
    {
        var bounds = target.Current.BoundingRectangle;
        Point point = new Point(Math.Round(bounds.X + bounds.Width / 2), Math.Round(bounds.Y + bounds.Height / 2));
        var nativePoint = new NativePoint { X = (int)point.X, Y = (int)point.Y };
        ValidateClickTarget(bounds, window.Current.BoundingRectangle, point, Root(WindowFromPoint(nativePoint)) == hwnd, ContainsElement(target, point), IsForeground(hwnd), requireForeground);
        if (!target.Current.IsEnabled || target.Current.IsOffscreen) throw new Exception("微信控件当前不可点击，已停止操作");
        NoHeldKeys();
        NativePoint original;
        if (!GetCursorPos(out original)) throw new Exception("无法读取鼠标位置，已停止点击");
        try
        {
            if (!SetCursorPos(nativePoint.X, nativePoint.Y)) throw new Exception("无法定位微信控件，已停止点击");
            Thread.Sleep(50);
            NativePoint actual;
            if (!GetCursorPos(out actual) || actual.X != nativePoint.X || actual.Y != nativePoint.Y) throw new Exception("鼠标位置被改变，已停止点击");
            ValidateClickTarget(target.Current.BoundingRectangle, window.Current.BoundingRectangle, point, Root(WindowFromPoint(actual)) == hwnd, ContainsElement(target, point), IsForeground(hwnd), requireForeground);
            recheck(); NoHeldKeys();
            if (requireForeground && !IsForeground(hwnd)) throw new Exception("微信焦点已改变，已停止发送");
            beforeInput(); // Mark uncertain only immediately before the actual send click, never on guard failures.
            var events = ButtonEvents(); uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(NativeInput)));
            if (sent != events.Length)
            {
                // If only button-down was injected, release it without retrying a click.
                if (sent == 1) SendInput(1, new[] { events[1] }, Marshal.SizeOf(typeof(NativeInput)));
                throw new Exception("Windows 未完成微信按钮点击，已停止操作");
            }
        }
        finally
        {
            NativePoint current;
            if (GetCursorPos(out current) && current.X == nativePoint.X && current.Y == nativePoint.Y) SetCursorPos(original.X, original.Y);
        }
    }
    internal static void FocusComposer(AutomationElement window, IntPtr hwnd, Func<AutomationElement> composer, Action recheck)
    {
        SetForegroundWindow(hwnd); Thread.Sleep(150); recheck();
        if (!IsForeground(hwnd))
        {
            // A verified click in the empty composer activates Weixin if Windows declines foreground activation.
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x0013); Thread.Sleep(100);
        }
        // Actual focus click avoids relying on Qt's optional UIA SetFocus implementation.
        Click(window, composer(), hwnd, false, recheck, delegate { }); Thread.Sleep(100);
        if (!IsForeground(hwnd)) throw new Exception("微信未取得前台焦点，已停止操作，请打开微信后再试");
        recheck();
    }
}
