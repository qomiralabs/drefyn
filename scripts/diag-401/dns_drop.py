# Temporary. Answers NXDOMAIN and swallows every third query, as a lossy resolver would.
import socket, sys
from datetime import datetime, timezone

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind((sys.argv[1], 53))
seen = 0
while True:
    query, sender = server.recvfrom(512)
    seen += 1
    dropped = seen % 3 == 0
    print(datetime.now(timezone.utc).isoformat(), "query", seen, "dropped" if dropped else "answered", flush=True)
    if not dropped:
        server.sendto(query[:2] + b"\x81\x83" + query[4:], sender)
