#!/usr/bin/env python3
"""Static dev server that refuses to let the browser cache anything.

Plain `python3 -m http.server` sends Last-Modified, so browsers happily reuse
stale ES modules between reloads and you end up debugging code you already
fixed. This is dev-only; GitHub Pages serves the real thing.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    root = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = partial(NoCacheHandler, directory=root)
    print(f'serving {root} on http://localhost:{port}')
    ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
