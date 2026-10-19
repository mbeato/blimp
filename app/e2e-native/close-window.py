# Asks the X windows titled argv[1] (or "<folder> — argv[1]", as a project window is titled) to close, the way a window manager's close button does
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
x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_char_p)]
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


# The title as UTF-8 (_NET_WM_NAME). A title with characters outside Latin-1, like the dash in
# "<folder> — blimp", isn't in plain WM_NAME, which is all XFetchName reads.
def x_name(w):
    net, utf8 = x.XInternAtom(d, b"_NET_WM_NAME", 0), x.XInternAtom(d, b"UTF8_STRING", 0)
    t, f, n, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_char_p()
    if x.XGetWindowProperty(d, w, net, 0, 1024, 0, utf8, ctypes.byref(t), ctypes.byref(f), ctypes.byref(n), ctypes.byref(after), ctypes.byref(data)) == 0 and data.value:
        return data.value
    s = ctypes.c_char_p()
    return s.value if x.XFetchName(d, w, ctypes.byref(s)) else None


name = sys.argv[1].encode()
targets = []
for w in windows(x.XDefaultRootWindow(d)):
    v = x_name(w)
    if v and (v == name or v.endswith(" — ".encode() + name)):
        targets.append(w)
print("matched:", [x_name(w) for w in targets])
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
