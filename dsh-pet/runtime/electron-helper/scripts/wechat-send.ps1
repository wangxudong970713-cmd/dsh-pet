[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$TargetName,
    [Parameter(Mandatory=$true)]
    [string]$Text
)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class Win32Wechat {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;

    public const byte VK_CONTROL = 0x11;
    public const byte VK_MENU = 0x12;
    public const byte VK_RETURN = 0x0D;
    public const byte VK_V = 0x56;
    public const byte VK_F = 0x46;
    public const byte VK_S = 0x53;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    public static IntPtr FindWechatWindow() {
        IntPtr h1 = FindWindow("WeChatMainWndForPC", null);
        if (h1 != IntPtr.Zero) return h1;

        IntPtr h2 = FindWindow("Qt51514QWindowIcon", null);
        if (h2 != IntPtr.Zero) return h2;

        IntPtr bestHwnd = IntPtr.Zero;
        int maxArea = 0;

        EnumWindows((hWnd, lParam) => {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;

            try {
                System.Diagnostics.Process proc = System.Diagnostics.Process.GetProcessById((int)pid);
                string procName = proc.ProcessName.ToLower();
                if (procName == "weixin" || procName == "wechat") {
                    System.Text.StringBuilder sbClass = new System.Text.StringBuilder(256);
                    GetClassName(hWnd, sbClass, 256);
                    string className = sbClass.ToString();

                    RECT r;
                    GetWindowRect(hWnd, out r);
                    int w = r.Right - r.Left;
                    int h = r.Bottom - r.Top;
                    int area = w * h;

                    if (className.Contains("Qt") || className.Contains("WeChat") || className.Contains("Weixin") || className.Contains("ChatWnd")) {
                        if (w > 200 && h > 200 && area > maxArea) {
                            maxArea = area;
                            bestHwnd = hWnd;
                        }
                    } else if (bestHwnd == IntPtr.Zero && w > 300 && h > 300) {
                        maxArea = area;
                        bestHwnd = hWnd;
                    }
                }
            } catch {}
            return true;
        }, IntPtr.Zero);

        return bestHwnd;
    }

    public static void ResetModifiers() {
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(0x10, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void ForceForeground(IntPtr hWnd) {
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, SW_RESTORE);
        } else {
            ShowWindow(hWnd, SW_SHOW);
        }
        ResetModifiers();
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }

    public static void FocusInputArea(IntPtr hWnd) {
        RECT rect;
        if (GetWindowRect(hWnd, out rect)) {
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return;

            int targetX = rect.Left + (int)(width * 0.65);
            int offsetBottom = Math.Max(50, Math.Min(85, height / 5));
            int targetY = rect.Bottom - offsetBottom;

            POINT oldPos;
            GetCursorPos(out oldPos);

            SetCursorPos(targetX, targetY);
            Thread.Sleep(30);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);

            SetCursorPos(oldPos.X, oldPos.Y);
        }
    }

    public static void SendCtrlF() {
        ResetModifiers();
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_F, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(VK_F, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void SendCtrlV() {
        ResetModifiers();
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_V, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void SendEnter() {
        ResetModifiers();
        Thread.Sleep(30);
        keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void SendAltS() {
        ResetModifiers();
        Thread.Sleep(30);
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_S, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        keybd_event(VK_S, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void SendCtrlEnter() {
        ResetModifiers();
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@

Add-Type -TypeDefinition $csharp -ErrorAction SilentlyContinue

function Set-SafeClipboard {
    param([string]$Content)
    for ($i = 0; $i -lt 5; $i++) {
        try {
            [System.Windows.Forms.Clipboard]::SetText($Content)
            return $true
        } catch {
            Start-Sleep -Milliseconds 50
        }
    }
    try {
        Set-Clipboard -Value $Content
        return $true
    } catch {
        return $false
    }
}

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

    $hwnd = [Win32Wechat]::FindWechatWindow()
    if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
        $proc = Get-Process -Name "WeChat", "Weixin" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.MainWindowHandle -ne 0) {
            $hwnd = $proc.MainWindowHandle
        }
    }

    if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
        Write-Output '{"ok":false,"error":"WECHAT_NOT_FOUND"}'
        exit 0
    }

    $prevHwnd = [Win32Wechat]::GetForegroundWindow()

    [Win32Wechat]::ForceForeground($hwnd)
    Start-Sleep -Milliseconds 250

    # Ensure foreground is retained
    $curHwnd = [Win32Wechat]::GetForegroundWindow()
    if ($curHwnd -ne $hwnd) {
        [Win32Wechat]::ForceForeground($hwnd)
        Start-Sleep -Milliseconds 150
    }

    $clipOk = Set-SafeClipboard -Content $TargetName
    if (-not $clipOk) {
        Write-Output '{"ok":false,"error":"CLIPBOARD_TARGET_FAILED"}'
        exit 0
    }

    [Win32Wechat]::SendCtrlF()
    Start-Sleep -Milliseconds 180
    [Win32Wechat]::SendCtrlV()
    Start-Sleep -Milliseconds 400
    [Win32Wechat]::SendEnter()
    Start-Sleep -Milliseconds 300

    [Win32Wechat]::FocusInputArea($hwnd)
    Start-Sleep -Milliseconds 180

    $clipOk2 = Set-SafeClipboard -Content $Text
    if (-not $clipOk2) {
        Write-Output '{"ok":false,"error":"CLIPBOARD_TEXT_FAILED"}'
        exit 0
    }

    [Win32Wechat]::SendCtrlV()
    Start-Sleep -Milliseconds 250

    [Win32Wechat]::SendAltS()
    Start-Sleep -Milliseconds 100
    [Win32Wechat]::SendEnter()
    Start-Sleep -Milliseconds 100

    Start-Sleep -Milliseconds 150

    if ($prevHwnd -and $prevHwnd -ne [IntPtr]::Zero -and $prevHwnd -ne $hwnd) {
        [void][Win32Wechat]::SetForegroundWindow($prevHwnd)
    }

    Write-Output '{"ok":true}'
} catch {
    $err = $_.Exception.Message
    $escaped = $err -replace '\\', '\\' -replace '"', '\"'
    Write-Output "{`"ok`":false,`"error`":`"$escaped`"}"
}
