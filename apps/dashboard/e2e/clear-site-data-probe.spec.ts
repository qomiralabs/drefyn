import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@playwright/test';

// Measures what each browser does with Clear-Site-Data, on real https with real __Host-
// cookies, the shape production has. No Drefyn code is involved, so it needs no stack. The
// server is a loopback listener in Python because the only thing it reaches is the browser.
const APP = 'app.corp.localhost';
const SIBLING = 'sso.corp.localhost';

const SERVER = String.raw`
import ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FLAGS = "Path=/; HttpOnly; Secure; SameSite=Lax"
CLEAR = ("Clear-Site-Data", '"cookies"')
REISSUE = ("Set-Cookie", "__Host-device=reissued; " + FLAGS)
EXPIRE = ("Set-Cookie", "__Host-session=; Max-Age=0; " + FLAGS)
HTML = ("Content-Type", "text/html")
LANDED = b"<h1>landed</h1>"

MODES = {
    "header": (303, "/landed", [CLEAR]),
    "header-200": (200, None, [CLEAR]),
    "reissue-same": (303, "/landed", [CLEAR, REISSUE]),
    "reissue-200": (200, None, [CLEAR, REISSUE]),
    "reissue-hop": (303, "/landed-reissue", [CLEAR]),
    "named": (303, "/landed", [EXPIRE]),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def reply(self, status, headers, body=b""):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        host = self.headers.get("Host", "")
        if self.path == "/seed" and host.startswith("sso."):
            self.reply(200, [HTML, ("Set-Cookie", "__Host-sibling=1; " + FLAGS)], b"seeded")
        elif self.path == "/seed":
            self.reply(
                200,
                [
                    HTML,
                    ("Set-Cookie", "__Host-session=s; " + FLAGS),
                    ("Set-Cookie", "__Host-device=original; Max-Age=3600; " + FLAGS),
                    ("Set-Cookie", "parent-app=1; Domain=corp.localhost; Path=/; Secure; SameSite=Lax"),
                ],
                b"seeded",
            )
        elif self.path == "/landed":
            self.reply(200, [HTML], LANDED)
        elif self.path == "/landed-reissue":
            self.reply(200, [HTML, REISSUE], LANDED)
        elif self.path.startswith("/start/"):
            mode = self.path.removeprefix("/start/")
            form = f'<form method="post" action="/out/{mode}"><button>go</button></form>'
            self.reply(200, [HTML], form.encode())
        else:
            self.reply(404, [])

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        status, location, headers = MODES[self.path.removeprefix("/out/")]
        if location is None:
            self.reply(status, [HTML, *headers], LANDED)
        else:
            self.reply(status, [("Location", location), *headers])

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_address[1], flush=True)
server.serve_forever()
`;

const MODES = [
  'header',
  'header-200',
  'reissue-same',
  'reissue-200',
  'reissue-hop',
  'named',
] as const;

let server: ChildProcess;
let port = '';
let dir = '';

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'csd-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      `/CN=${APP}`,
      '-addext',
      `subjectAltName=DNS:${APP},DNS:${SIBLING}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  server = spawn('python3', ['-c', SERVER, cert, key], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<string>((resolve) => {
    server.stdout?.once('data', (chunk: Buffer) => {
      resolve(chunk.toString().trim());
    });
  });
});

test.afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true });
});

test.use({ ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });

for (const mode of MODES) {
  test(`probe ${mode}`, async ({ browser, browserName }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const tab = await context.newPage();
    const app = `https://${APP}:${port}`;
    await tab.goto(`${app}/seed`);
    await tab.goto(`https://${SIBLING}:${port}/seed`);
    await tab.goto(`${app}/start/${mode}`);
    await tab.getByRole('button', { name: 'go' }).click();
    await tab.getByRole('heading', { name: 'landed' }).waitFor();
    // Anything that clears off the response path gets time to land.
    await tab.waitForTimeout(1_000);
    const seen = (await context.cookies())
      .map((c) => `${c.name}=${c.value}@${c.domain}`)
      .sort()
      .join(' ');
    console.log(`PROBE ${browserName} ${mode}: ${seen === '' ? '(none)' : seen}`);
    await context.close();
  });
}
