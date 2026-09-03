"""Read exact Windows process lifetimes for the checkout fixture."""
import ctypes as c, json, os, socket, socketserver, threading, time
from ctypes import wintypes as w

FRAME_BYTES = 16 * 1024
FRAME_TIMEOUT_SECONDS = 0.5
PARENT_POLL_SECONDS = 0.1
MAX_CLIENTS = 8

kernel = c.WinDLL("kernel32", use_last_error=True)
def bind(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype, function.argtypes = result, arguments
    return function

open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
process_times = bind("GetProcessTimes", w.BOOL, w.HANDLE, *([c.POINTER(w.FILETIME)] * 4))
wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
close = bind("CloseHandle", w.BOOL, w.HANDLE)
def read_processes(pids):
    observations = []
    for pid in pids:
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError("Expected a positive process id")
        # QUERY_LIMITED_INFORMATION reads birth; SYNCHRONIZE proves termination.
        handle = open_process(0x1000 | 0x100000, False, pid)
        if not handle:
            error = c.get_last_error()
            if error != 87:  # ERROR_INVALID_PARAMETER: the positive PID is absent.
                raise c.WinError(error)
            observations.append(dict(pid=pid, alive=False, creationTime=None))
            continue
        try:
            result = wait(handle, 0)
            if result not in (0, 258):  # WAIT_OBJECT_0 / WAIT_TIMEOUT.
                raise c.WinError(c.get_last_error())
            times = [w.FILETIME() for _ in range(4)]
            if not process_times(handle, *(c.byref(value) for value in times)):
                raise c.WinError(c.get_last_error())
            creation = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            observations.append(dict(pid=pid, alive=result == 258, creationTime=str(creation)))
        finally:
            if not close(handle):
                raise c.WinError(c.get_last_error())
    return observations

def respond(request, token):
    if type(request) is not dict or type(request.get("v")) is not int or request["v"] != 1:
        raise ValueError("Expected protocol version 1")
    if request.get("token") != token:
        raise ValueError("Invalid census token")
    operation = request.get("op")
    fields = {"census": {"v", "token", "op", "pids"},
              "shutdown": {"v", "token", "op"}}.get(operation)
    if fields is None:
        raise ValueError("Invalid census operation")
    if set(request) != fields:
        raise ValueError("Invalid census request fields")
    if operation == "shutdown":
        return {"v": 1, "ok": True}, True
    pids = request["pids"]
    valid = type(pids) is list and len(pids) <= 256 and all(
        type(pid) is int and pid > 0 for pid in pids)
    if not valid or len(set(pids)) != len(pids):
        raise ValueError("Expected unique positive process ids")
    return {"v": 1, "observations": read_processes(pids)}, False

def read_frame(connection):
    deadline = time.monotonic() + FRAME_TIMEOUT_SECONDS
    frame = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Census frame deadline exceeded")
        connection.settimeout(remaining)
        chunk = connection.recv(max(1, FRAME_BYTES + 2 - len(frame)))
        if not chunk:
            break
        frame.extend(chunk)
        if len(frame) > FRAME_BYTES + 1:
            break
    if (len(frame) > FRAME_BYTES + 1 or not frame.endswith(b"\n")
            or b"\n" in frame[:-1]):
        raise ValueError("Expected one bounded JSON line")
    return bytes(frame)

class CensusHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            response, shutdown = respond(
                json.loads(read_frame(self.request)), self.server.token)
        except Exception as error:
            response, shutdown = {"v": 1, "error": str(error)}, False
        try:
            self.request.sendall(json.dumps(
                response, separators=(",", ":")).encode() + b"\n")
        except OSError:
            return
        if shutdown:
            # Publish the acknowledgement before asking the owner loop to stop.
            self.server.stop_event.set()

class CensusServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = False
    block_on_close = True
    request_queue_size = MAX_CLIENTS

    def __init__(self, token):
        self.token = token
        self.stop_event = threading.Event()
        self.slots = threading.BoundedSemaphore(MAX_CLIENTS)
        super().__init__(("127.0.0.1", 0), CensusHandler)
        self.timeout = PARENT_POLL_SECONDS

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

def serve():
    token = os.environ["OPENCLAW_CI_CENSUS_TOKEN"]
    deadline = time.monotonic() + int(
        os.environ["OPENCLAW_CI_CENSUS_MAX_LIFETIME_MS"]) / 1000
    parent = open_process(0x100000, False, int(
        os.environ["OPENCLAW_CI_CENSUS_PARENT_PID"]))  # SYNCHRONIZE
    if not parent:
        raise c.WinError(c.get_last_error())
    server = None
    try:
        server = CensusServer(token)
        print(json.dumps({"v": 1, "port": server.server_address[1]}), flush=True)
        while time.monotonic() < deadline and not server.stop_event.is_set():
            parent_state = wait(parent, 0)
            if parent_state not in (0, 258):
                raise c.WinError(c.get_last_error())
            if parent_state == 0:
                break
            server.handle_request()
    finally:
        try:
            if server:
                server.server_close()
        finally:
            if not close(parent):
                raise c.WinError(c.get_last_error())

if __name__ == "__main__":
    serve()
