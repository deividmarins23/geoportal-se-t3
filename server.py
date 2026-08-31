# -*- coding: utf-8 -*-
"""
Servidor local do GEOPORTAL SE-T3.

Serve os arquivos estaticos ja pre-gerados (tiles, geojson e frontend) e abre
o navegador padrao automaticamente. Nao ha geracao dinamica em runtime -- para
isso, rode build_data.py antes.

Uso:
    python server.py [porta]
"""
import http.server
import mimetypes
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765

# Python < 3.11 nao conhece .webp por padrao e serviria como
# application/octet-stream; forcamos o tipo correto pros tiles.
mimetypes.add_type("image/webp", ".webp")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[geoportal] " + (fmt % args) + "\n")

    def end_headers(self):
        # cache leve para tiles/geojson locais, sem cache para o html/js (facilita depuracao)
        if self.path.endswith((".png", ".jpg", ".webp")):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def find_free_port(preferred):
    port = preferred
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    return preferred


def main():
    preferred = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            preferred = int(sys.argv[1])
        except ValueError:
            pass

    port = find_free_port(preferred)
    url = f"http://localhost:{port}/static/index.html"

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), QuietHandler)
    print(f"[geoportal] Servindo {ROOT}")
    print(f"[geoportal] Abrindo {url}")

    threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[geoportal] Encerrado.")


if __name__ == "__main__":
    main()
