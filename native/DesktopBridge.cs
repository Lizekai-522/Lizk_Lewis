using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Accessibility;

// Each request operates on one executable registered in the local application catalog.
// Fresh names, roles and rectangles are checked before any physical input is injected.
internal static class DesktopBridge {
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    delegate bool WindowCallback(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs,int size);
    [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint id,ref Guid guid,[MarshalAs(UnmanagedType.Interface)]out object obj);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible root,int start,int count,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)]object[] children,out int got);
    struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size;public Rect Monitor,Work;public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
    class Control { public string path,name,source; public int role,x,y,width,height; public IAccessible accessible; public object child; public AutomationElement uia; }
    static Bitmap Capture(IntPtr hwnd,Rect rect) {
        var bitmap=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top,PixelFormat.Format32bppArgb);
        using(var g=Graphics.FromImage(bitmap)){var dc=g.GetHdc();try{if(!PrintWindow(hwnd,dc,2))throw new Exception("暂时无法读取应用画面，请选中应用后重试");}finally{g.ReleaseHdc(dc);}}
        return bitmap;
    }
    static string RegionHash(Bitmap bitmap,int x,int y,int width,int height) {
        if(x<0||y<0||width<1||height<1||x+width>bitmap.Width||y+height>bitmap.Height)throw new Exception("应用位置已经失效，请重新读取");
        var bytes=new byte[width*height*3];int index=0;
        for(int row=y;row<y+height;row++)for(int col=x;col<x+width;col++){var p=bitmap.GetPixel(col,row);bytes[index++]=p.R;bytes[index++]=p.G;bytes[index++]=p.B;}
        using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    }
    static object[] PlayButtons(Bitmap bitmap,Rect window) {
        int cols=(bitmap.Width+1)/2,rows=(bitmap.Height+1)/2;var green=new bool[cols*rows];var used=new bool[green.Length];
        for(int y=0;y<rows;y++)for(int x=0;x<cols;x++){var c=bitmap.GetPixel(x*2,y*2);green[y*cols+x]=c.G>160&&c.R<95&&c.B<150;}
        var result=new List<object>();
        for(int i=0;i<green.Length;i++)if(green[i]&&!used[i]){
            var queue=new Queue<int>();queue.Enqueue(i);used[i]=true;int minX=cols,maxX=0,minY=rows,maxY=0,count=0;
            while(queue.Count>0){int n=queue.Dequeue(),x=n%cols,y=n/cols;minX=Math.Min(minX,x);maxX=Math.Max(maxX,x);minY=Math.Min(minY,y);maxY=Math.Max(maxY,y);count++;
                foreach(int next in new[]{x>0?n-1:-1,x+1<cols?n+1:-1,y>0?n-cols:-1,y+1<rows?n+cols:-1})if(next>=0&&green[next]&&!used[next]){used[next]=true;queue.Enqueue(next);}
            }
            int left=minX*2,top=minY*2,width=Math.Min(bitmap.Width-left,(maxX-minX+1)*2),height=Math.Min(bitmap.Height-top,(maxY-minY+1)*2);
            if(width<28||height<22||width>120||height>100||width>height*2||width<height*.7||count<100)continue;
            int white=0;for(int y=top+height/4;y<top+height*3/4;y++)for(int x=left+width/4;x<left+width*3/4;x++){var c=bitmap.GetPixel(x,y);if((c.R>180&&c.G>180&&c.B>180)||(c.R<75&&c.G<100&&c.B<75))white++;}
            if(white<8)continue;
            result.Add(Item("path","image/"+result.Count,"name","图像播放按钮","role",43,"x",window.Left+left,"y",window.Top+top,"width",width,"height",height,"source","ocr","hash",RegionHash(bitmap,left,top,width,height)));
        }
        return result.ToArray();
    }
    static Dictionary<string,object> Item(params object[] values) { var result=new Dictionary<string,object>(); for(int i=0;i<values.Length;i+=2)result[(string)values[i]]=values[i+1];return result; }
    static string Field(Dictionary<string,object> request,string key) { object v; return request.TryGetValue(key,out v)&&v is string?(string)v:""; }
    static int Number(Dictionary<string,object> request,string key) { object v; if(!request.TryGetValue(key,out v))throw new Exception("桌面操作参数不完整");return Convert.ToInt32(v); }
    static IntPtr FindWindow(string executable) {
        foreach(var process in Process.GetProcessesByName(System.IO.Path.GetFileNameWithoutExtension(executable))) using(process) {
            try { if(String.Equals(process.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase)&&process.MainWindowHandle!=IntPtr.Zero)return process.MainWindowHandle; }catch{}
        }
        IntPtr best=IntPtr.Zero;long area=0;
        EnumWindows(delegate(IntPtr hwnd,IntPtr state) {
            try { uint pid;GetWindowThreadProcessId(hwnd,out pid);using(var p=Process.GetProcessById((int)pid)) {
                if(!String.Equals(p.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase))return true;
                Rect r;GetWindowRect(hwnd,out r);long size=(long)(r.Right-r.Left)*(r.Bottom-r.Top);
                if((IsWindowVisible(hwnd)||IsIconic(hwnd))&&size>area){area=size;best=hwnd;}
            }}catch{}return true;
        },IntPtr.Zero);
        if(best==IntPtr.Zero)throw new Exception("应用窗口还没准备好，请稍后再试；若已退出请先打开应用");return best;
    }
    static void Foreground(IntPtr hwnd) {
        if(IsIconic(hwnd))ShowWindow(hwnd,9);SetForegroundWindow(hwnd);Thread.Sleep(150);
        if(GetForegroundWindow()!=hwnd){SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x0013);Thread.Sleep(100);}
    }
    static IAccessible Accessible(IntPtr hwnd) { Guid guid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");object value;if(AccessibleObjectFromWindow(hwnd,0xfffffffc,ref guid,out value)!=0)return null;return value as IAccessible; }
    static int visited;
    static void WalkAccessible(IAccessible root,object child,string path,int depth,Rect window,List<Control> controls) {
        if(depth>24||++visited>7000)return;
        try {
            string name=root.get_accName(child)??"";int role=Convert.ToInt32(root.get_accRole(child));int state=Convert.ToInt32(root.get_accState(child));int x,y,w,h;root.accLocation(out x,out y,out w,out h,child);
            if((state&0x18000)!=0)return;
            if((state&0x218001)==0&&w>2&&h>2&&x>=window.Left&&y>=window.Top&&x+w<=window.Right+3&&y+h<=window.Bottom+3&&(name.Length>0||role==42))
                controls.Add(new Control {path=path,name=name.Length>160?name.Substring(0,160):name,role=role,x=x,y=y,width=w,height=h,source="msaa",accessible=root,child=child});
            if(!child.Equals(0))return;
            int count=Math.Min(root.accChildCount,600);object[] children=new object[count];int got;AccessibleChildren(root,0,count,children,out got);
            for(int i=0;i<got;i++) { var nested=children[i] as IAccessible; if(nested!=null)WalkAccessible(nested,0,path+"/"+i,depth+1,window,controls);else if(children[i] is int)WalkAccessible(root,children[i],path+"/"+i,depth+1,window,controls); }
        }catch{}
    }
    static List<Control> Controls(IntPtr hwnd,Rect window) {
        var controls=new List<Control>();visited=0;var root=Accessible(hwnd);if(root!=null)WalkAccessible(root,0,"m",0,window,controls);
        try {
            var nodes=AutomationElement.FromHandle(hwnd).FindAll(TreeScope.Descendants,Condition.TrueCondition);
            for(int i=0;i<Math.Min(nodes.Count,1500);i++){var e=nodes[i];var c=e.Current;var r=c.BoundingRectangle;
                if(c.IsOffscreen||!c.IsEnabled||c.IsPassword||r.Width<3||r.Height<3||String.IsNullOrEmpty(c.Name))continue;
                if(controls.Any(t=>t.name==c.Name&&Math.Abs(t.x-r.X)<3&&Math.Abs(t.y-r.Y)<3))continue;
                controls.Add(new Control {path="u/"+String.Join("-",e.GetRuntimeId()),name=c.Name,role=c.ControlType==ControlType.Edit?42:43,x=(int)r.X,y=(int)r.Y,width=(int)r.Width,height=(int)r.Height,source="uia",uia=e});
            }
        }catch{}
        return controls;
    }
    static void Click(IntPtr hwnd,Control c,bool twice) {
        Foreground(hwnd);
        var point=new Point(c.x+c.width/2,c.y+c.height/2);
        if(GetAncestor(WindowFromPoint(point),2)!=hwnd)throw new Exception("应用控件被其他窗口遮挡，已停止点击");
        foreach(int key in new[]{1,2,16,17,18,91,92})if((GetAsyncKeyState(key)&0x8000)!=0)throw new Exception("请松开鼠标和修饰键后再操作应用");
        SetCursorPos(point.X,point.Y);
        Point actual; if(!GetCursorPos(out actual)||actual!=point){var error=new Exception("应用控件不在可点击的屏幕区域，请将应用窗口移回屏幕后再试");error.Data["target"]=point.ToString();error.Data["actual"]=actual.ToString();throw error;}
        if(GetAncestor(WindowFromPoint(point),2)!=hwnd)throw new Exception("应用位置变化，已停止点击");
        Thread.Sleep(80);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(60);mouse_event(4,0,0,0,UIntPtr.Zero);
        if(twice){Thread.Sleep(100);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}
    }
    static void Key(byte key) { keybd_event(key,0,0,UIntPtr.Zero);keybd_event(key,0,2,UIntPtr.Zero); }
    static bool HasFocus(IntPtr hwnd) {
        uint expected,actual;GetWindowThreadProcessId(hwnd,out expected);GetWindowThreadProcessId(GetForegroundWindow(),out actual);
        return expected!=0&&expected==actual;
    }
    static void Type(IntPtr hwnd,Control c,string text,bool enter) {
        if(c.role!=42)throw new Exception("这个位置不是输入框，请重新读取应用窗口");
        Click(hwnd,c,false);Thread.Sleep(80);
        if(!HasFocus(hwnd))throw new Exception("应用焦点变化，已停止输入");
        keybd_event(0x11,0,0,UIntPtr.Zero);Key(0x41);keybd_event(0x11,0,2,UIntPtr.Zero);
        foreach(char ch in text){if(!HasFocus(hwnd))throw new Exception("应用焦点变化，输入已停止");var input=new Input[2];input[0].type=input[1].type=1;input[0].data.keyboard.scan=input[1].data.keyboard.scan=ch;input[0].data.keyboard.flags=4;input[1].data.keyboard.flags=6;if(SendInput(2,input,Marshal.SizeOf(typeof(Input)))!=2)throw new Exception("系统没有接受输入，请检查应用权限");}
        if(enter){if(!HasFocus(hwnd))throw new Exception("应用焦点变化，已停止操作");Key(0x0d);}
    }
    [STAThread] static void Main() {
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){SetProcessDPIAware();}Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);var json=new JavaScriptSerializer();Dictionary<string,object> result;
        try {
            var request=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());string executable=Field(request,"executable"),action=Field(request,"action");
            executable=System.IO.Path.GetFullPath(executable);
            if(!System.IO.File.Exists(executable)||!executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new Exception("没有找到应用安装文件");
            var hwnd=FindWindow(executable);if(IsIconic(hwnd))ShowWindow(hwnd,9);Rect window;GetWindowRect(hwnd,out window);
            if(action=="read") {
                var info=new MonitorInfo {Size=Marshal.SizeOf(typeof(MonitorInfo))};
                bool monitor=GetMonitorInfo(MonitorFromWindow(hwnd,2),ref info);
                int visibleWidth=Math.Max(0,Math.Min(window.Right,info.Work.Right)-Math.Max(window.Left,info.Work.Left)),visibleHeight=Math.Max(0,Math.Min(window.Bottom,info.Work.Bottom)-Math.Max(window.Top,info.Work.Top));
                if(monitor&&(visibleWidth<Math.Min(window.Right-window.Left,info.Work.Right-info.Work.Left)/2||visibleHeight<Math.Min(window.Bottom-window.Top,info.Work.Bottom-info.Work.Top)/2)) {
                    int width=Math.Min(window.Right-window.Left,info.Work.Right-info.Work.Left),height=Math.Min(window.Bottom-window.Top,info.Work.Bottom-info.Work.Top);
                    SetWindowPos(hwnd,IntPtr.Zero,info.Work.Left,info.Work.Top,width,height,0x0014);Thread.Sleep(150);GetWindowRect(hwnd,out window);
                }
            }
            var controls=Controls(hwnd,window);
            if(action=="read") {
                result=Item("ok",true,"windowId",hwnd.ToInt64().ToString(),"left",window.Left,"top",window.Top,"width",window.Right-window.Left,"height",window.Bottom-window.Top,"controls",controls.Take(350).Select(c=>Item("path",c.path,"name",c.name,"role",c.role,"x",c.x,"y",c.y,"width",c.width,"height",c.height,"source",c.source)).ToArray());
                if(request.ContainsKey("capture")&&Convert.ToBoolean(request["capture"]))using(var bitmap=Capture(hwnd,window))using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);result["image"]=Convert.ToBase64String(stream.ToArray());if(System.IO.Path.GetFileName(executable).Equals("QQMusic.exe",StringComparison.OrdinalIgnoreCase))result["visualControls"]=PlayButtons(bitmap,window);}
            } else {
                if(!new[]{"click","double-click","type"}.Contains(action))throw new Exception("未知桌面操作");
                if(Field(request,"windowId")!=hwnd.ToInt64().ToString())throw new Exception("应用窗口已变化，请重新读取");
                var control=controls.FirstOrDefault(c=>c.path==Field(request,"path")&&c.name==Field(request,"name")&&c.role==Number(request,"role")&&c.x==Number(request,"x")&&c.y==Number(request,"y")&&c.width==Number(request,"width")&&c.height==Number(request,"height"));
                if(control==null&&Field(request,"source")!="ocr") {
                    var matches=controls.Where(c=>c.source==Field(request,"source")&&c.name==Field(request,"name")&&c.role==Number(request,"role")&&c.x==Number(request,"x")&&c.y==Number(request,"y")&&c.width==Number(request,"width")&&c.height==Number(request,"height")).ToArray();
                    if(matches.Length==1)control=matches[0];
                }
                if(Field(request,"source")=="ocr") {
                    var c=new Control {name=Field(request,"name"),role=Number(request,"role"),x=Number(request,"x"),y=Number(request,"y"),width=Number(request,"width"),height=Number(request,"height")};
                    using(var bitmap=Capture(hwnd,window)){if(RegionHash(bitmap,c.x-window.Left,c.y-window.Top,c.width,c.height)!=Field(request,"hash"))throw new Exception("应用内容已变化，请重新读取后操作");}
                    control=c;
                }
                if(control==null)throw new Exception("应用界面已变化，请重新读取后操作");
                if(action=="type"){string text=Field(request,"text");if(text.Length>500||text.Any(Char.IsControl))throw new Exception("输入内容应在500字以内，不含控制字符");Type(hwnd,control,text,request.ContainsKey("enter")&&Convert.ToBoolean(request["enter"]));}else Click(hwnd,control,action=="double-click");
                result=Item("ok",true,"performed",true);
            }
        }catch(Exception error){result=Item("ok",false,"error",error is ElementNotAvailableException?"应用界面已经变化，请重新读取":error.Message);if(error.Data.Count>0)result["details"]=error.Data;}
        Console.WriteLine(json.Serialize(result));
    }
}
