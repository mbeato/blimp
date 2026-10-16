# Asks the X window titled argv[1] to close, the way a window manager's close button does
# (a WM_DELETE_WINDOW client message), so the app takes its normal exit path. No WM runs under
# Xvfb, and WebDriver's "close window" is the driver's own teardown, not a user's close.
import ctypes, ctypes.util, sys

x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))
x.XOpenDisplay.restype = ctypes.c_void_p
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]


class ClientMessage(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]


d = x.XOpenDisplay(None)
if not d:
    sys.exit("no X display")


def windows(w):
    root, parent, kids, n = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    if not x.XQueryTree(d, w, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(n)):
        return
    for i in range(n.value):
        yield kids[i]
        yield from windows(kids[i])


name = sys.argv[1].encode()
targets = []
for w in windows(x.XDefaultRootWindow(d)):
    s = ctypes.c_char_p()
    if x.XFetchName(d, w, ctypes.byref(s)) and s.value == name:
        targets.append(w)
if not targets:
    sys.exit(f"no window named {sys.argv[1]}")
for w in targets:
    e = XEvent()
    e.xclient.type = 33  # ClientMessage
    e.xclient.window = w
    e.xclient.message_type = x.XInternAtom(d, b"WM_PROTOCOLS", 0)
    e.xclient.format = 32
    e.xclient.l[0] = x.XInternAtom(d, b"WM_DELETE_WINDOW", 0)
    x.XSendEvent(d, w, 0, 0, ctypes.byref(e))
x.XFlush(d)
print(f"sent WM_DELETE_WINDOW to {len(targets)} window(s)")
