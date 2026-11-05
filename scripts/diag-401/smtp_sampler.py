# Temporary. Times the banner of one SMTP session after another.
import socket, sys, time
from datetime import datetime, timezone

port, seconds = int(sys.argv[1]), int(sys.argv[2])
until = time.monotonic() + seconds
times = []
while time.monotonic() < until:
    started = time.monotonic()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=30) as conn:
            conn.settimeout(30)
            conn.recv(256)
            ms = (time.monotonic() - started) * 1000
            conn.sendall(b"QUIT\r\n")
    except OSError:
        ms = -1
    times.append(ms)
    if ms < 0 or ms > 250:
        print(datetime.now(timezone.utc).isoformat(), "slow", round(ms), flush=True)
    time.sleep(0.1)
times.sort()
at = lambda share: round(times[int((len(times) - 1) * share)])
print("sessions", len(times), "p50", at(0.5), "p99", at(0.99), "p999", at(0.999), "max", at(1))
