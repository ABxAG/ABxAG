/**
 * Minimal Win32 bindings (via koffi) for cheap, frequent desktop context:
 * foreground window, window rects (DWM extended frame bounds), monitors,
 * process names, idle time and fullscreen detection.
 *
 * Replaces spawning PowerShell for every presence poll. Every function
 * degrades to null/[] when not on Windows or if a binding fails to load.
 */
import { createRequire } from "node:module";

// Works both from tsx (ESM, development) and from the esbuild CJS bundle.
const nodeRequire: NodeRequire = typeof require === "function" ? require : createRequire(import.meta.url);

export interface NativeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NativeWindow {
  hwnd: number;
  title: string;
  className: string;
  pid: number;
  process: string | null;
  rect: NativeRect;
  minimized: boolean;
  visible: boolean;
}

interface Bindings {
  GetForegroundWindow: () => unknown;
  GetWindowTextW: (hwnd: unknown, buffer: Buffer, max: number) => number;
  GetClassNameW: (hwnd: unknown, buffer: Buffer, max: number) => number;
  GetWindowThreadProcessId: (hwnd: unknown, pid: number[]) => number;
  GetWindowRect: (hwnd: unknown, rect: NativeRect) => boolean;
  IsWindowVisible: (hwnd: unknown) => boolean;
  IsIconic: (hwnd: unknown) => boolean;
  IsWindow: (hwnd: unknown) => boolean;
  MonitorFromWindow: (hwnd: unknown, flags: number) => unknown;
  GetMonitorInfoW: (monitor: unknown, info: { cbSize: number; rcMonitor: NativeRect; rcWork: NativeRect; dwFlags: number }) => boolean;
  GetLastInputInfo: (info: { cbSize: number; dwTime: number }) => boolean;
  GetTickCount: () => number;
  EnumWindows: (callback: unknown, lParam: number) => boolean;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  QueryFullProcessImageNameW: (process: unknown, flags: number, buffer: Buffer, size: number[]) => boolean;
  CloseHandle: (handle: unknown) => boolean;
  DwmGetWindowAttribute: (hwnd: unknown, attribute: number, value: NativeRect, size: number) => number;
  koffi: any;
  enumProto: unknown;
}

let bindings: Bindings | null | undefined;

function load(): Bindings | null {
  if (bindings !== undefined) return bindings;
  bindings = null;
  if (process.platform !== "win32") return null;
  try {
    const koffi = nodeRequire("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    const RECT = koffi.struct("ABxAG_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    const MONITORINFO = koffi.struct("ABxAG_MONITORINFO", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
    const LASTINPUTINFO = koffi.struct("ABxAG_LASTINPUTINFO", { cbSize: "uint32", dwTime: "uint32" });
    const enumProto = koffi.proto("bool __stdcall ABxAG_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)");
    bindings = {
      koffi,
      enumProto,
      GetForegroundWindow: user32.func("intptr_t __stdcall GetForegroundWindow()"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint8_t *buf, int max)"),
      GetClassNameW: user32.func("int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *buf, int max)"),
      GetWindowThreadProcessId: user32.func("uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)"),
      GetWindowRect: user32.func("bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ ABxAG_RECT *rect)"),
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(intptr_t hwnd)"),
      IsIconic: user32.func("bool __stdcall IsIconic(intptr_t hwnd)"),
      IsWindow: user32.func("bool __stdcall IsWindow(intptr_t hwnd)"),
      MonitorFromWindow: user32.func("intptr_t __stdcall MonitorFromWindow(intptr_t hwnd, uint32 flags)"),
      GetMonitorInfoW: user32.func("bool __stdcall GetMonitorInfoW(intptr_t monitor, _Inout_ ABxAG_MONITORINFO *info)"),
      GetLastInputInfo: user32.func("bool __stdcall GetLastInputInfo(_Inout_ ABxAG_LASTINPUTINFO *info)"),
      GetTickCount: kernel32.func("uint32 __stdcall GetTickCount()"),
      EnumWindows: user32.func("bool __stdcall EnumWindows(ABxAG_EnumWindowsProc *cb, intptr_t lParam)"),
      OpenProcess: kernel32.func("void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)"),
      QueryFullProcessImageNameW: kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *proc, uint32 flags, _Out_ uint8_t *buf, _Inout_ uint32 *size)"),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *h)"),
      DwmGetWindowAttribute: dwmapi.func("int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ ABxAG_RECT *value, uint32 size)"),
    };
    void MONITORINFO;
    void LASTINPUTINFO;
  } catch {
    bindings = null;
  }
  return bindings;
}

export function nativeAvailable(): boolean {
  return load() !== null;
}

const processCache = new Map<number, { name: string | null; at: number }>();

function wideString(buffer: Buffer, length: number): string {
  return buffer.subarray(0, Math.max(0, length) * 2).toString("utf16le");
}

export function processName(pid: number): string | null {
  const b = load();
  if (!b || !pid) return null;
  const cached = processCache.get(pid);
  if (cached && Date.now() - cached.at < 60_000) return cached.name;
  let name: string | null = null;
  const handle = b.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
  if (handle) {
    try {
      const buffer = Buffer.alloc(1040);
      const size = [520];
      if (b.QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        const full = wideString(buffer, size[0]);
        name = full.split("\\").pop() || null;
      }
    } finally {
      b.CloseHandle(handle);
    }
  }
  processCache.set(pid, { name, at: Date.now() });
  if (processCache.size > 400) processCache.clear();
  return name;
}

function describe(hwndPointer: unknown, b: Bindings): NativeWindow | null {
  if (!hwndPointer) return null;
  const title = Buffer.alloc(1024);
  const titleLength = b.GetWindowTextW(hwndPointer, title, 512);
  const klass = Buffer.alloc(512);
  const classLength = b.GetClassNameW(hwndPointer, klass, 256);
  const pid = [0];
  b.GetWindowThreadProcessId(hwndPointer, pid);
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  // Extended frame bounds exclude the invisible resize borders of Windows 10/11.
  if (b.DwmGetWindowAttribute(hwndPointer, 9, rect, 16) !== 0) b.GetWindowRect(hwndPointer, rect);
  return {
    hwnd: Number(hwndPointer),
    title: wideString(title, titleLength),
    className: wideString(klass, classLength),
    pid: pid[0],
    process: processName(pid[0]),
    rect: { ...rect },
    minimized: b.IsIconic(hwndPointer),
    visible: b.IsWindowVisible(hwndPointer),
  };
}

export function foregroundWindow(): NativeWindow | null {
  const b = load();
  if (!b) return null;
  try {
    return describe(b.GetForegroundWindow(), b);
  } catch {
    return null;
  }
}

export function windowByHandle(hwnd: number): NativeWindow | null {
  const b = load();
  if (!b || !hwnd) return null;
  try {
    if (!b.IsWindow(hwnd)) return null;
    return describe(hwnd, b);
  } catch {
    return null;
  }
}

export function listWindows(limit = 60): NativeWindow[] {
  const b = load();
  if (!b) return [];
  const out: NativeWindow[] = [];
  try {
    const callback = b.koffi.register((hwnd: unknown) => {
      if (out.length >= limit) return false;
      if (b.IsWindowVisible(hwnd)) {
        const window = describe(hwnd, b);
        if (window && window.title.trim() && window.rect.right - window.rect.left > 40) out.push(window);
      }
      return true;
    }, b.koffi.pointer(b.enumProto));
    try {
      b.EnumWindows(callback, 0);
    } finally {
      b.koffi.unregister(callback);
    }
  } catch {
    return out;
  }
  return out;
}

export function monitorOf(hwnd: number): { monitor: NativeRect; work: NativeRect; primary: boolean } | null {
  const b = load();
  if (!b) return null;
  try {
    const monitor = b.MonitorFromWindow(hwnd, 2 /* NEAREST */);
    const info = { cbSize: 40, rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
    if (!b.GetMonitorInfoW(monitor, info)) return null;
    return { monitor: { ...info.rcMonitor }, work: { ...info.rcWork }, primary: (info.dwFlags & 1) === 1 };
  } catch {
    return null;
  }
}

export function idleMs(): number | null {
  const b = load();
  if (!b) return null;
  try {
    const info = { cbSize: 8, dwTime: 0 };
    if (!b.GetLastInputInfo(info)) return null;
    return (b.GetTickCount() - info.dwTime) >>> 0;
  } catch {
    return null;
  }
}

const SHELL_CLASSES = /^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd|Windows\.UI\.Core\.CoreWindow)$/;

/** Whether the foreground window covers its whole monitor (game, video, presentation). */
export function foregroundFullscreen(ignorePids: number[] = []): { fullscreen: boolean; window: NativeWindow | null } {
  const window = foregroundWindow();
  if (!window || SHELL_CLASSES.test(window.className) || ignorePids.includes(window.pid) || window.minimized) return { fullscreen: false, window };
  const monitor = monitorOf(window.hwnd);
  if (!monitor) return { fullscreen: false, window };
  const covers = window.rect.left <= monitor.monitor.left && window.rect.top <= monitor.monitor.top
    && window.rect.right >= monitor.monitor.right && window.rect.bottom >= monitor.monitor.bottom;
  return { fullscreen: covers, window };
}



