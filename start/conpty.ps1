# Run one command inside a Windows pseudo-console (ConPTY) and relay what it prints: pty_run.py's protocol, with no
# Python. Windows PowerShell 5.1 or PowerShell 7; Windows 10 1809 or later. Started by runner.mjs as
#   powershell.exe -NoProfile -NonInteractive -EncodedCommand <this file>
# stdin   first line: JSON {"argv": [...], "cwd": "...", "rows": 50, "cols": 200}; then left open, and closing it
#         stops the command.
# stdout  everything the command prints, raw bytes, as it arrives.
# stderr  one-line diagnostics, each starting with "pty_run:".
# exit    0 normal; 2 bad request; 3 no pseudo-console here; 4 the command could not be started.
# With CLOUD_PILOT_PTY_CHECK=1 it only checks that a pseudo-console can be made (exit 0, else 3).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # no progress records (CLIXML) on stderr

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class KitConPty {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr pc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  static void Say(string m) { Console.Error.WriteLine("pty_run: " + m); Console.Error.Flush(); }

  public static int Check() {
    SafeFileHandle inR, inW, outR, outW;
    if (!CreatePipe(out inR, out inW, IntPtr.Zero, 0) || !CreatePipe(out outR, out outW, IntPtr.Zero, 0)) return 3;
    IntPtr pc;
    COORD size; size.X = 80; size.Y = 25;
    int hr;
    try { hr = CreatePseudoConsole(size, inR, outW, 0, out pc); } catch (EntryPointNotFoundException) { return 3; }
    if (hr != 0) return 3;
    ClosePseudoConsole(pc);
    inR.Dispose(); inW.Dispose(); outR.Dispose(); outW.Dispose();
    return 0;
  }

  // Quotes one argument the way CommandLineToArgvW and the C runtime read it back.
  public static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(c); }
      slashes = 0;
    }
    sb.Append('\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  // `argLine` is the arguments as one command line, already quoted for the program that reads them.
  public static int Run(string exe, string argLine, string cwd, short rows, short cols) {
    SafeFileHandle inR, inW, outR, outW;
    if (!CreatePipe(out inR, out inW, IntPtr.Zero, 0) || !CreatePipe(out outR, out outW, IntPtr.Zero, 0)) { Say("cannot create pipes"); return 3; }
    IntPtr pc;
    COORD size; size.X = cols; size.Y = rows;
    int hr;
    try { hr = CreatePseudoConsole(size, inR, outW, 0, out pc); }
    catch (EntryPointNotFoundException) { Say("this Windows has no pseudo-console (needs Windows 10 1809 or later)"); return 3; }
    if (hr != 0) { Say("CreatePseudoConsole failed: 0x" + hr.ToString("X")); return 3; }
    inR.Dispose(); outW.Dispose(); // the pseudo-console holds its own copies

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr list = Marshal.AllocHGlobal(attrSize);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref attrSize)
        || !UpdateProcThreadAttribute(list, 0, (IntPtr)0x20016, pc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
      Say("cannot attach the pseudo-console: error " + Marshal.GetLastWin32Error());
      return 3;
    }
    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES with none: the child gets the pseudo-console, not our pipes
    si.lpAttributeList = list;
    var cmd = new StringBuilder(Quote(exe));
    if (argLine.Length > 0) cmd.Append(' ').Append(argLine);
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, cwd, ref si, out pi)) {
      Say("cannot start " + exe + ": error " + Marshal.GetLastWin32Error());
      ClosePseudoConsole(pc);
      return 4;
    }

    var stdout = Console.OpenStandardOutput();
    var pump = new Thread(() => {
      var buf = new byte[4096];
      try {
        using (var fs = new FileStream(outR, FileAccess.Read, 4096, false)) {
          int n;
          while ((n = fs.Read(buf, 0, buf.Length)) > 0) { stdout.Write(buf, 0, n); stdout.Flush(); }
        }
      } catch (Exception) { /* the pseudo-console closed, or nobody listens any more */ }
    });
    pump.IsBackground = true;
    pump.Start();
    var stop = new ManualResetEvent(false);
    var watch = new Thread(() => {
      try { var s = Console.OpenStandardInput(); var b = new byte[256]; while (s.Read(b, 0, b.Length) > 0) { } } catch (Exception) { }
      stop.Set(); // the Node side closed our stdin
    });
    watch.IsBackground = true;
    watch.Start();

    bool endedByItself = false;
    while (true) {
      if (WaitForSingleObject(pi.hProcess, 50) == 0) { endedByItself = true; break; }
      if (stop.WaitOne(0)) break;
    }
    uint code = 0;
    if (!endedByItself) { TerminateProcess(pi.hProcess, 1); WaitForSingleObject(pi.hProcess, 3000); }
    else GetExitCodeProcess(pi.hProcess, out code);
    pump.Join(300); // what the command printed last
    ClosePseudoConsole(pc);
    pump.Join(1000);
    if (endedByItself) Say("child exited with code " + code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list);
    try { stdout.Flush(); } catch (Exception) { }
    return 0;
  }
}
'@

function Say($message) { [Console]::Error.WriteLine("pty_run: $message") }

try { Add-Type -TypeDefinition $source -Language CSharp } catch {
  Say "cannot load the pseudo-console helper: $($_.Exception.Message)"
  exit 3
}

if ($env:CLOUD_PILOT_PTY_CHECK -eq '1') { exit [KitConPty]::Check() }

try {
  # The request is UTF-8 (a Vietnamese brief stays Vietnamese); Windows PowerShell would read it in the OEM code page.
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  $req = [Console]::In.ReadLine() | ConvertFrom-Json
  $argv = @($req.argv | ForEach-Object { [string]$_ })
  $cwd = [string]$req.cwd
  if ($argv.Count -lt 1 -or -not $cwd) { throw 'argv must be a non-empty list of strings and cwd a string' }
  $rows = if ($req.rows) { [int16]$req.rows } else { [int16]50 }
  $cols = if ($req.cols) { [int16]$req.cols } else { [int16]200 }
} catch {
  Say "bad request: $($_.Exception.Message)"
  exit 2
}

if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Say "directory not found: $cwd"; exit 4 }

# The full path of the program, as PATH and PATHEXT find it (claude.exe, or a claude.cmd that cmd.exe must run).
if ([System.IO.Path]::IsPathRooted($argv[0])) {
  # A full path is taken as it is (Get-Command would read [ ] in it as wildcards).
  if (-not (Test-Path -LiteralPath $argv[0] -PathType Leaf)) { Say "cannot start $($argv[0]): not found"; exit 4 }
  $exe = $argv[0]
} else {
  $found = Get-Command -Name $argv[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { Say "cannot start $($argv[0]): not found"; exit 4 }
  $exe = $found.Source
}
# Only a real program, never a batch file: cmd.exe would read & | % in the arguments (the brief) as commands.
if ($exe -notmatch '\.(exe|com)$') { Say "cannot start ${exe}: only .exe programs are started (no batch files)"; exit 4 }
$rest = @($argv | Select-Object -Skip 1)
$argLine = ($rest | ForEach-Object { [KitConPty]::Quote($_) }) -join ' '

if (-not $env:TERM) { $env:TERM = 'xterm-256color' }
exit [KitConPty]::Run($exe, [string]$argLine, $cwd, $rows, $cols)
