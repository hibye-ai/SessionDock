"""Fixed CPython broker bridge; run only through AutomationService (-I -S -u).

Useful synchronous subset, not the full SecureCRT API. Screen.Get uses the optional
host readScreen callback (1-based inclusive terminal cells). Without it, Get is a
rolling, ANSI-stripped line view since job launch with Unicode character columns;
cursor addressing, wide-cell widths and renderer scrollback are not emulated there.
Wait/Read match exact decoded text INCLUDING escape sequences. Default timeout is
30 seconds; explicitly passing 0 also uses that finite default. Maximum 300 sec.
crt.Screen/Session and session.screen/session share the same broker objects.
No credential injection, connection selection, connect, imports from the script's
directory or autorun. User scripts have ordinary local Python filesystem access.
"""

import builtins
import io
import json
import math
import os
import sys
import types


# Reserve private protocol descriptors, then replace OS-level stdout as well as
# Python stdout. print(), sys.__stdout__, os.write(1, ...) and inherited subprocess
# stdout now go to drained stderr, not to the JSON-line channel.
_protocol_in = os.fdopen(os.dup(0), "r", encoding="utf-8", newline="\n")
_protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n", buffering=1)
os.set_inheritable(_protocol_in.fileno(), False)
os.set_inheritable(_protocol_out.fileno(), False)
os.dup2(2, 1)
_diagnostics = io.TextIOWrapper(os.fdopen(os.dup(2), "wb"), encoding="utf-8", write_through=True)
sys.stdout = sys.__stdout__ = _diagnostics
sys.stderr = sys.__stderr__ = _diagnostics
# Do not let user input() or native stdin reads consume broker replies.
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
os.close(_null)
sys.stdin = sys.__stdin__ = open(os.devnull, "r", encoding="utf-8")
sys.dont_write_bytecode = True
_sequence = 0


def _rpc(method, *args):
    global _sequence
    _sequence += 1
    payload = json.dumps({"id": _sequence, "method": method, "args": args}, ensure_ascii=True)
    if len(payload.encode("utf-8")) > 256 * 1024:
        raise RuntimeError("Automation request too large")
    _protocol_out.write(payload + "\n")
    _protocol_out.flush()
    line = _protocol_in.readline(256 * 1024 + 1)
    if not line or len(line.encode("utf-8")) > 256 * 1024 or not line.endswith("\n"):
        raise RuntimeError("Automation broker closed")
    response = json.loads(line)
    if response.get("id") != _sequence or "error" in response:
        raise RuntimeError("Automation broker rejected request")
    return response.get("result")


def _timeout(seconds):
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds):
        raise ValueError("Invalid timeout")
    if seconds == 0:
        seconds = 30
    if seconds < 0 or seconds > 300:
        raise ValueError("Invalid timeout")
    return int(seconds * 1000)


def _text(value):
    if not isinstance(value, str):
        raise TypeError("Expected text")
    return value


def _patterns(values):
    if isinstance(values, str):
        return [_text(values)]
    if not isinstance(values, (list, tuple)) or not values:
        raise TypeError("Expected strings")
    return [_text(value) for value in values]


class _Screen:
    Synchronous = True  # Broker always buffers output; assignment is compatible.
    MatchIndex = 0

    def Send(self, text):
        _rpc("send", _text(text))

    def WaitForString(self, text, timeout=30):
        self.MatchIndex = _rpc("wait", [_text(text)], _timeout(timeout))
        return self.MatchIndex != 0

    def WaitForStrings(self, strings, timeout=30):
        self.MatchIndex = _rpc("wait", _patterns(strings), _timeout(timeout))
        return self.MatchIndex

    def ReadString(self, strings, timeout=30):
        result = _rpc("read", _patterns(strings), _timeout(timeout))
        self.MatchIndex = result["matchIndex"]
        return result["text"]

    def Get(self, row1, col1, row2, col2):
        return _rpc("get", row1, col1, row2, col2)

    send = Send
    wait_for_string = WaitForString
    wait_for_strings = WaitForStrings
    read_string = ReadString
    get = Get

    def send_line(self, text):
        self.Send(_text(text) + "\r")


class _Session:
    def __init__(self, screen):
        self.Screen = self.screen = screen

    @property
    def Connected(self):
        return bool(_rpc("connected"))

    @property
    def connected(self):
        return self.Connected

    def Disconnect(self):
        _rpc("disconnect")  # Host stops the job and process tree immediately.

    disconnect = Disconnect

    def send(self, text):
        self.screen.Send(text)

    def send_line(self, text):
        self.screen.send_line(text)

    def wait_for(self, text, timeout=30):
        return self.screen.WaitForString(text, timeout)

    def read_until(self, text, timeout=30):
        return self.screen.ReadString(text, timeout)

    def sleep(self, milliseconds):
        _rpc("sleep", milliseconds)


def _sleep(milliseconds):
    _rpc("sleep", milliseconds)


def _main():
    script_path = os.path.abspath(sys.argv[1])
    sys.argv = [script_path]
    screen = _Screen()
    session = _Session(screen)
    crt = types.ModuleType("crt")
    crt.Screen, crt.Session, crt.Sleep = screen, session, _sleep
    # Both injected globals and explicit imports are supported.
    sys.modules["crt"] = crt
    modern = types.ModuleType("session")
    for name in ("screen", "send", "send_line", "wait_for", "read_until", "sleep", "disconnect"):
        setattr(modern, name, getattr(session, name))
    modern.__getattr__ = lambda name: session.connected if name == "connected" else getattr(session, name)
    sys.modules["session"] = modern
    # -I -S excludes PYTHONPATH, cwd, user site and site startup hooks. Never
    # append the script/bridge directory or run a script as an importable module.
    with open(script_path, "rb") as source:
        contents = source.read(1024 * 1024 + 1)
    if len(contents) > 1024 * 1024:
        raise ValueError("Script too large")
    code = compile(contents, script_path, "exec")
    globals_ = {"__name__": "__main__", "__file__": script_path,
                "__builtins__": builtins, "crt": crt, "session": session}
    exec(code, globals_, globals_)
    _rpc("done")  # Host commits output and terminates this waiting process tree.


try:
    _main()
except BaseException:
    # Never serialize the exception, script line, locals or traceback. Even
    # SyntaxError diagnostics can contain user credentials embedded in source.
    try:
        _rpc("failed")
    except BaseException:
        pass
    os._exit(1)
