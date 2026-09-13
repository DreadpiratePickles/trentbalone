#!/usr/bin/env python3
"""Local stand-in for GitHub Releases, used only by scripts/install.test.sh.

Serves ROOT at /releases/download/<...> and answers /releases/latest with the 302 redirect
GitHub sends (Location: .../releases/tag/v<VERSION>), so the installer's latest-version
resolution is exercised against the same shape it will see in production.

  testserver.py ROOT PORT VERSION [options]

  --truncate-binaries         send the headers for any trent-* asset, then close the socket
                              after 64 KiB: a transfer that dies mid-body.
  --redirect-binaries-to H    302 any trent-* asset to http://H:PORT/... (a hop off the host).
  --latest-tag TAG            redirect /releases/latest to /releases/tag/vTAG instead of the
                              real version (a spoofed or malformed tag).
"""
import os, sys, http.server, socketserver

args = sys.argv[1:]
root, port, version = args[0], int(args[1]), args[2]
truncate = '--truncate-binaries' in args
redirect_host = args[args.index('--redirect-binaries-to') + 1] if '--redirect-binaries-to' in args else None
latest_tag = args[args.index('--latest-tag') + 1] if '--latest-tag' in args else version

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_HEAD(self): self._serve(head=True)
    def do_GET(self): self._serve(head=False)
    def _serve(self, head):
        if self.path.rstrip('/') == '/releases/latest':
            self.send_response(302)
            self.send_header('Location', f'http://127.0.0.1:{port}/releases/tag/v{latest_tag}')
            self.end_headers(); return
        prefix = '/releases/download/'
        if not self.path.startswith(prefix):
            self.send_error(404); return
        rel = os.path.normpath(self.path[len(prefix):])
        full = os.path.join(root, rel)
        if rel.startswith('..') or not os.path.isfile(full):
            self.send_error(404); return
        name = os.path.basename(full)
        if redirect_host and name.startswith('trent-') and self.headers.get('Host', '').split(':')[0] != redirect_host:
            self.send_response(302)
            self.send_header('Location', f'http://{redirect_host}:{port}{self.path}')
            self.end_headers(); return
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.end_headers()
        if head: return
        with open(full, 'rb') as f:
            if truncate and name.startswith('trent-'):
                self.wfile.write(f.read(65536)); self.wfile.flush()
                self.connection.close(); return
            while True:
                chunk = f.read(1 << 20)
                if not chunk: break
                self.wfile.write(chunk)

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with S(('', port), H) as srv:
    srv.serve_forever()
