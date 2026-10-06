using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Selectors come from this user's Weixin 4.1.13.65 UIA report. Operations stay within one verified chat.
internal static class WeChatBridge
{
    private static bool invoked;
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr state);

    [STAThread]
    private static int Main()
    {
        WeChatMouse.UsePhysicalPixels();
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer();
        Dictionary<string, object> result;
        try
        {
            string input = Console.In.ReadToEnd();
            if (input.Length > 12000) throw new Exception("微信请求过长");
            var request = serializer.Deserialize<Dictionary<string, object>>(input);
            string action = Field(request, "action"), recipient = Field(request, "recipient").Trim(), text = Field(request, "text");
            Validate(action, recipient, text);
            result = Run(action, recipient, text);
        }
        catch (Exception error)
        {
            string message = error is ElementNotAvailableException ? "微信界面已变化，请重新打开目标聊天后再试" : error.Message;
            if (invoked) message = "发送状态未确认，可能已经发送，请查看微信；本请求不会自动重发。";
            result = Item("ok", false, "error", message, "uncertain", invoked);
        }
        Console.WriteLine(serializer.Serialize(result)); return 0;
    }
    private static string Field(Dictionary<string, object> request, string key)
    {
        if (request == null) throw new Exception("微信请求格式无效");
        object value; return request.TryGetValue(key, out value) && value is string ? (string)value : "";
    }
    internal static void Validate(string action, string recipient, string text)
    {
        if (!new[] { "connection", "status", "read", "send" }.Contains(action)) throw new Exception("未知微信操作");
        if (action != "status" && action != "connection" && (String.IsNullOrWhiteSpace(recipient) || recipient.Length > 80 || recipient.Any(Char.IsControl))) throw new Exception("请指定完整微信聊天名称，最多80字符");
        if (action == "send" && (String.IsNullOrWhiteSpace(text) || text.Length > 2000 || text.IndexOf('\0') >= 0)) throw new Exception("发送内容应为1–2000字符");
    }
    private static Dictionary<string, object> Item(params object[] values)
    {
        var result = new Dictionary<string, object>(); for (int i = 0; i < values.Length; i += 2) result[(string)values[i]] = values[i + 1]; return result;
    }
    private static AutomationElement Unique(AutomationElement root, AutomationProperty property, object value, string description)
    {
        return Unique(root, new PropertyCondition(property, value), description);
    }
    private static AutomationElement Unique(AutomationElement root, Condition condition, string description)
    {
        var matches = root.FindAll(TreeScope.Descendants, condition);
        var visible = matches.Cast<AutomationElement>().Where(item => !item.Current.IsOffscreen).ToArray();
        if (visible.Length != 1) throw new Exception("无法唯一识别" + description + "，请打开并选中目标聊天");
        return visible[0];
    }
    private static AutomationElement Window()
    {
        var ids = new HashSet<int>();
        foreach (string name in new[] { "Weixin", "WeChat" }) foreach (var process in Process.GetProcessesByName(name)) using (process) ids.Add(process.Id);
        if (ids.Count == 0) throw new Exception("请先打开并登录电脑微信");
        var matches = new List<AutomationElement>();
        // EnumWindows includes a window hidden to tray, unlike a visible-only UIA root scan.
        EnumWindows(delegate(IntPtr hwnd, IntPtr state)
        {
            uint id; GetWindowThreadProcessId(hwnd, out id); if (!ids.Contains((int)id)) return true;
            try { var element = AutomationElement.FromHandle(hwnd); if (element.Current.ClassName == "mmui::MainWindow") matches.Add(element); } catch { }
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) throw new Exception("未找到唯一的微信主窗口，请打开微信主界面；多个微信窗口时先关闭额外窗口");
        return matches[0];
    }
    private static AutomationElement Header(AutomationElement window)
    {
        return Unique(window, AutomationElement.ClassNameProperty, "mmui::ChatTitleBarChatSingleView", "聊天标题");
    }
    private static string[] HeaderNames(AutomationElement window)
    {
        var header = Header(window);
        var names = header.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text))
            .Cast<AutomationElement>().Where(item => !item.Current.IsOffscreen).Select(item => item.Current.Name.Trim())
            .Where(name => name.Length > 0 && name.Length <= 80).Distinct().ToArray();
        if (names.Length == 0) throw new Exception("未能读取聊天标题，操作已停止");
        return names;
    }
    private static void AssertChat(AutomationElement window, string recipient)
    {
        if (!HeaderNames(window).Contains(recipient, StringComparer.Ordinal)) throw new Exception("当前聊天不是“" + recipient + "”。请先在微信中打开该聊天，再执行指令");
    }
    private static AutomationElement Input(AutomationElement window)
    {
        return Unique(window, AutomationElement.AutomationIdProperty, "chat_input_field", "聊天输入框");
    }
    private static ValuePattern InputValue(AutomationElement input)
    {
        object pattern; if (!input.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) throw new Exception("微信输入框不允许自动填入文字");
        return (ValuePattern)pattern;
    }
    private static AutomationElement SendButton(AutomationElement window)
    {
        var inputView = Unique(window, AutomationElement.ClassNameProperty, "mmui::ChatInputView", "输入区域");
        // A Text child is also named "发送"; select the actual button only.
        return Unique(inputView, new AndCondition(new PropertyCondition(AutomationElement.NameProperty, "发送"), new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::XOutlineButton"), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)), "发送按钮");
    }
    private static AutomationElement MessageList(AutomationElement window)
    {
        var view = Unique(window, AutomationElement.ClassNameProperty, "mmui::MessageView", "消息区域");
        var list = Unique(view, AutomationElement.ClassNameProperty, "mmui::RecyclerListView", "消息列表");
        if (list.Current.Name != "消息") throw new Exception("消息列表标识已改变，操作已停止");
        return list;
    }
    private static AutomationElement[] Bubbles(AutomationElement window)
    {
        return MessageList(window).FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::ChatBubbleItemView"))
            .Cast<AutomationElement>().Where(item => !item.Current.IsOffscreen).ToArray();
    }
    private static string BubbleText(AutomationElement bubble)
    {
        object pattern; string value = "";
        if (bubble.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = ((ValuePattern)pattern).Current.Value;
        if (String.IsNullOrWhiteSpace(value)) value = bubble.Current.Name;
        if (String.IsNullOrWhiteSpace(value))
        {
            var children = bubble.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
            value = String.Join("\n", children.Cast<AutomationElement>().Select(item => item.Current.Name).Where(name => !String.IsNullOrWhiteSpace(name)).Take(20));
        }
        return value ?? "";
    }
    private static string Identity(AutomationElement element) { return String.Join("/", element.GetRuntimeId()); }
    internal static bool NewMessage(string[] before, string identity, string body, string expected)
    {
        return !before.Contains(identity) && body.Replace("\r\n", "\n").Split('\n').Any(line => line == expected.Replace("\r\n", "\n"))
            || !before.Contains(identity) && body.Replace("\r\n", "\n") == expected.Replace("\r\n", "\n");
    }
    private static Dictionary<string, object> Run(string action, string recipient, string text)
    {
        // Passive detection must never restore, activate or select a WeChat window.
        if (action == "connection")
        {
            bool running = false;
            foreach (string name in new[] { "Weixin", "WeChat" }) foreach (var process in Process.GetProcessesByName(name)) using (process) running = true;
            if (!running) return Item("ok", true, "running", false, "connected", false);
            try { var detected = Window(); return Item("ok", true, "running", true, "connected", true, "visible", IsWindowVisible(new IntPtr(detected.Current.NativeWindowHandle))); }
            catch { return Item("ok", true, "running", true, "connected", false); }
        }
        var window = Window(); var hwnd = new IntPtr(window.Current.NativeWindowHandle);
        bool hidden = !IsWindowVisible(hwnd), minimized = IsIconic(hwnd);
        var previousForeground = WeChatMouse.ForegroundWindow();
        try
        {
            if (hidden || minimized) { ShowWindow(hwnd, 4); Thread.Sleep(400); }
            if (action == "send" && minimized) { ShowWindow(hwnd, 9); Thread.Sleep(200); }
            if (action == "status")
            {
                var names = HeaderNames(window); var input = Input(window); MessageList(window);
                object inputPattern, buttonPattern;
                bool writable = input.TryGetCurrentPattern(ValuePattern.Pattern, out inputPattern) && !((ValuePattern)inputPattern).Current.IsReadOnly;
                bool hasDraft = inputPattern != null && !String.IsNullOrEmpty(((ValuePattern)inputPattern).Current.Value);
                var sendButton = SendButton(window);
                bool canInvokeSend = sendButton.TryGetCurrentPattern(InvokePattern.Pattern, out buttonPattern);
                bool canClickSend = !sendButton.Current.IsOffscreen && !sendButton.Current.BoundingRectangle.IsEmpty;
                string details = "；输入框" + (hasDraft ? "已有草稿，请先处理草稿" : "为空") + (writable && canClickSend ? "；已找到发送控件，实际发送需等待消息确认" : "；发送控件不可用，请重新打开聊天");
                return Item("ok", true, "recipient", names[0], "inputWritable", writable, "hasDraft", hasDraft, "canInvokeSend", canInvokeSend, "canClickSend", canClickSend, "sendButtonEnabled", sendButton.Current.IsEnabled, "sendMethod", "verified-mouse-click", "text", "微信界面已连接，当前聊天：" + names[0] + details);
            }
            AssertChat(window, recipient);
            if (action == "read")
            {
                var messages = new List<string>(); int remaining = 8000;
                foreach (var bubble in Bubbles(window).Reverse().Take(20).Reverse()) {
                    string body = BubbleText(bubble); if (String.IsNullOrWhiteSpace(body)) continue;
                    int length = Math.Min(Math.Min(body.Length, 1000), remaining); if (length <= 0) break;
                    messages.Add(body.Substring(0, length)); remaining -= length;
                }
                AssertChat(window, recipient);
                return Item("ok", true, "recipient", recipient, "messages", messages, "text", "“" + recipient + "”当前已显示的消息：\n" + (messages.Count == 0 ? "暂无可读取的文字消息" : String.Join("\n", messages)), "scope", "visible-chat");
            }
            var composer = Input(window); var valuePattern = InputValue(composer);
            if (!String.IsNullOrEmpty(valuePattern.Current.Value)) throw new Exception("微信输入框已有草稿，请先处理草稿，李维斯不会覆盖它");
            WeChatMouse.FocusComposer(window, hwnd, delegate { return Input(window); }, delegate {
                AssertChat(window, recipient);
                if (!String.IsNullOrEmpty(InputValue(Input(window)).Current.Value)) throw new Exception("微信输入框出现草稿，已停止操作");
            });
            var before = Bubbles(window).Select(Identity).ToArray();
            AssertChat(window, recipient);
            valuePattern.SetValue(text); Thread.Sleep(250);
            AssertChat(window, recipient);
            if (InputValue(Input(window)).Current.Value != text) throw new Exception("微信未正确接收输入文字，已停止，未点击发送");
            var button = SendButton(window);
            // Re-query while Qt updates the composer/button; never reuse the pre-fill UIA button state.
            for (int attempt = 0; !button.Current.IsEnabled && attempt < 20; attempt++) { Thread.Sleep(100); AssertChat(window, recipient); button = SendButton(window); }
            if (!button.Current.IsEnabled) throw new Exception("发送按钮未启用，已停止，文字留在输入框");
            WeChatMouse.Click(window, button, hwnd, true, delegate {
                AssertChat(window, recipient);
                if (InputValue(Input(window)).Current.Value != text) throw new Exception("微信输入文字已变化，已停止发送");
            }, delegate { invoked = true; });
            for (int attempt = 0; attempt < 40; attempt++)
            {
                Thread.Sleep(250); AssertChat(window, recipient);
                if (!String.IsNullOrEmpty(InputValue(Input(window)).Current.Value)) continue;
                var bubbles = Bubbles(window); if (bubbles.Length == 0) continue;
                var last = bubbles[bubbles.Length - 1];
                if (NewMessage(before, Identity(last), BubbleText(last), text))
                    return Item("ok", true, "sent", true, "recipient", recipient, "sendMethod", "verified-mouse-click", "text", "微信已显示新消息，发送给“" + recipient + "”：" + text);
            }
            throw new Exception("未确认新消息");
        }
        finally {
            if (action == "send") WeChatMouse.RestoreForeground(previousForeground, hwnd);
            if (hidden) ShowWindow(hwnd, 0); else if (minimized) ShowWindow(hwnd, 7);
        }
    }
}
