"""顶层窗口枚举 + 截图（探针用）。

用途：验证"点导出按钮后，系统文件对话框到底有没有真的出现在屏幕上"。
之前 _rt/_packui.js 用桩替换了 dialog.showSaveDialog，只能证明"处理函数被调用"，
证明不了对话框对用户可见——这一层就是当时漏掉的。

用法：
  python _rt/_windump.py                 列出全部可见顶层窗口
  python _rt/_windump.py --shot out.png  同时截屏
  python _rt/_windump.py --close-dialogs 给所有 #32770 对话框发 WM_CLOSE
"""
import argparse
import ctypes
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WM_CLOSE = 0x0010


def _proc_name(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return '?'
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit('\\', 1)[-1]
        return '?'
    finally:
        kernel32.CloseHandle(h)


def windows():
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        txt = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, txt, 512)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        out.append({
            'hwnd': hwnd,
            'cls': cls.value,
            'title': txt.value,
            'visible': bool(user32.IsWindowVisible(hwnd)),
            'pid': pid.value,
            'proc': _proc_name(pid.value),
        })
        return True

    user32.EnumWindows(cb, 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shot', default=None)
    ap.add_argument('--close-dialogs', action='store_true')
    ap.add_argument('--filter', default=None, help='只看进程名包含该子串的窗口')
    a = ap.parse_args()

    wins = windows()

    if a.close_dialogs:
        n = 0
        for w in wins:
            if w['cls'] == '#32770' and w['visible']:
                user32.PostMessageW(w['hwnd'], WM_CLOSE, 0, 0)
                n += 1
        print('已发送 WM_CLOSE 到 %d 个对话框' % n)
        return 0

    shown = [w for w in wins if w['visible']]
    if a.filter:
        shown = [w for w in shown if a.filter.lower() in w['proc'].lower()]
    print('可见顶层窗口 %d 个：' % len(shown))
    for w in shown:
        print('  cls=%-24s proc=%-24s pid=%-7d title=%s' % (w['cls'], w['proc'], w['pid'], w['title'][:60]))

    dlg = [w for w in shown if w['cls'] == '#32770']
    print('原生文件对话框（#32770）可见数 = %d' % len(dlg))

    if a.shot:
        try:
            from PIL import ImageGrab
            ImageGrab.grab().save(a.shot)
            print('截图已保存 ' + a.shot)
        except Exception as e:  # noqa: BLE001
            print('截图失败：%s' % e)
            return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
