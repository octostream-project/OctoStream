#!/bin/bash
# =============================================================================
# OctoStream — nodo de salida compartido (Debian 13 Trixie)
#
# Monta en un VPS:
#   - Proxy propio en Python (sin deps externas) en LOCALHOST:
#       SOCKS5       127.0.0.1:1819   (CONNECT TCP)
#       HTTP CONNECT 127.0.0.1:1820   (CONNECT + forward proxy para http://)
#   - Usuario dedicado "octo" con contraseña aleatoria para el túnel SSH.
#
# Arquitectura: cada OctoStream abre un túnel SSH al VPS (port-forward
#   local 1819/1820 -> 127.0.0.1 del VPS) y su tráfico sale por la IP
#   pública del VPS -> misma IP para todos, sea donde estén (AllDebrid
#   multiusuario). El proxy nunca toca Internet: solo es alcanzable por
#   quien ya entro por SSH. Cifrado y auth = el propio SSH.
#
# Uso (como root, en el VPS recién creado):
#   bash setup-octo-node.sh
# Al final imprime la IP publica, el usuario y la clave para OctoStream.
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta como root: sudo bash $0" >&2
  exit 1
fi

echo "==> [1/5] Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates python3 ufw

echo "==> [2/5] Usuario dedicado 'octo' (solo para el tunel)"
if ! id octo >/dev/null 2>&1; then
  useradd -m -s /bin/bash octo
fi
OCTO_PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
echo "octo:${OCTO_PASS}" | chpasswd

# Permitir auth por contraseña en sshd (algunas imagenes la desactivan)
mkdir -p /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/60-octo.conf <<'EOF'
PasswordAuthentication yes
EOF
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true

echo "==> [3/5] Proxy SOCKS5 :1819 + HTTP :1820 (solo localhost)"
mkdir -p /opt/octo-proxy

cat >/opt/octo-proxy/octo_proxy.py <<'PYEOF'
#!/usr/bin/env python3
"""OctoStream shared-exit proxy: SOCKS5 (:1819) + HTTP (:1820) on loopback."""
import asyncio
import ipaddress
import sys

BUF = 65536


async def relay(r, w):
    try:
        while True:
            data = await r.read(BUF)
            if not data:
                break
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        for fn in (w.write_eof, w.close):
            try:
                fn()
            except Exception:
                pass


async def socks5(r, w):
    head = await r.readexactly(2)
    if head[0] != 5:
        w.close()
        return
    await r.readexactly(head[1])
    w.write(b"\x05\x00")  # no auth (solo localhost, ya autenticado por SSH)
    await w.drain()
    req = await r.readexactly(4)
    cmd, atyp = req[1], req[3]
    if cmd != 1:
        w.write(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
        await w.drain()
        w.close()
        return
    if atyp == 1:
        host = str(ipaddress.IPv4Address(await r.readexactly(4)))
    elif atyp == 3:
        ln = (await r.readexactly(1))[0]
        raw = await r.readexactly(ln)
        try:
            host = raw.decode("utf-8")
        except UnicodeDecodeError:
            host = raw.decode("latin-1")
    elif atyp == 4:
        host = str(ipaddress.IPv6Address(await r.readexactly(16)))
    else:
        w.close()
        return
    port = int.from_bytes(await r.readexactly(2), "big")
    try:
        rr, rw = await asyncio.open_connection(host, port)
    except Exception:
        w.write(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
        await w.drain()
        w.close()
        return
    w.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
    await w.drain()
    await asyncio.gather(relay(r, rw), relay(rr, w))


async def http(r, w):
    line = await r.readline()
    if not line:
        w.close()
        return
    parts = line.split()
    if len(parts) < 3:
        w.close()
        return
    method, target, version = parts[0], parts[1], parts[2]
    headers = []
    while True:
        h = await r.readline()
        if h in (b"\r\n", b"\n", b""):
            break
        name = h.split(b":", 1)[0].strip().lower()
        if name in (b"proxy-connection", b"proxy-authorization"):
            continue
        headers.append(h)

    if method.upper() == b"CONNECT":
        host, _, port = target.decode("latin-1").rpartition(":")
        host, port = host.strip("[]"), int(port or "443")
        try:
            rr, rw = await asyncio.open_connection(host, port)
        except Exception:
            w.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            await w.drain()
            w.close()
            return
        w.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await w.drain()
        await asyncio.gather(relay(r, rw), relay(rr, w))
        return

    # forward proxy: absolute-URI (http://host/path)
    from urllib.parse import urlsplit
    try:
        u = urlsplit(target.decode("latin-1"))
        host, port = u.hostname, u.port or (443 if u.scheme == "https" else 80)
    except Exception:
        w.close()
        return
    if not host:
        w.close()
        return
    try:
        rr, rw = await asyncio.open_connection(host, port)
    except Exception:
        w.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        await w.drain()
        w.close()
        return
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    rw.write(method + b" " + path.encode("latin-1") + b" " + version + b"\r\n")
    for h in headers:
        rw.write(h)
    rw.write(b"\r\n")
    await rw.drain()
    await asyncio.gather(relay(r, rw), relay(rr, w))


async def guarded(handler, r, w):
    try:
        await handler(r, w)
    except Exception:
        try:
            w.close()
        except Exception:
            pass


async def main():
    s1 = await asyncio.start_server(
        lambda r, w: guarded(socks5, r, w), "127.0.0.1", 1819)
    s2 = await asyncio.start_server(
        lambda r, w: guarded(http, r, w), "127.0.0.1", 1820)
    async with s1, s2:
        await asyncio.gather(s1.serve_forever(), s2.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
PYEOF

cat >/etc/systemd/system/octo-proxy.service <<'EOF'
[Unit]
Description=OctoStream shared proxy (SOCKS5+HTTP on loopback)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/octo-proxy/octo_proxy.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now octo-proxy

echo "==> [4/5] Firewall (solo SSH abierto)"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw reload >/dev/null

PUB_IP="$(curl -s https://api.ipify.org || echo '<IP-DEL-VPS>')"

echo "==> [5/5] Verificacion del proxy"
sleep 1
curl -s --socks5 127.0.0.1:1819 --max-time 8 https://api.ipify.org >/dev/null \
  && echo "    SOCKS5 OK (sale por la IP del VPS)" \
  || echo "    AVISO: la sonda SOCKS5 fallo - revisa: journalctl -u octo-proxy"

echo
echo "=============================================================="
echo " LISTO - datos para OctoStream"
echo "=============================================================="
echo " Servidor   : $PUB_IP"
echo " Puerto SSH : 22"
echo " Usuario    : octo"
echo " Clave      : $OCTO_PASS"
echo "=============================================================="
echo
echo " En cada OctoStream (Ajustes -> WARP):"
echo "   1. 'Usar el WARP de otro OctoStream' -> $PUB_IP"
echo "   2. Activa el modo SSH e introduce usuario 'octo' + la clave"
echo "   3. Conecta -> todo el trafico de la app sale por $PUB_IP"
echo
echo " Verifica desde un cliente:  ssh -N -L 1819:127.0.0.1:1819 octo@$PUB_IP"
echo "   y en otra terminal: curl --socks5 127.0.0.1:1819 https://api.ipify.org"
echo
echo " Log/estado:  journalctl -u octo-proxy -f"
echo "=============================================================="
