"""Run on the client's fresh Ubuntu VPS. The native app supplies FILES from its build."""
import fcntl
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path("/opt/bravebrand/workrooms")
API = "https://workrooms-setup.bravebrand.com/v1/address"
IMAGE = "ghcr.io/block/buzz@sha256:690016ca465e439e2c58213fdfe8a094073ddbe80de75baec74b0a39de54ab38"


def write(path, contents, mode=0o600, uid=0):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        stream.write(contents.encode())
        os.fchmod(stream.fileno(), mode)
        os.fchown(stream.fileno(), uid, 0)
    os.replace(stream.name, path)


def ensure_packages():
    needed = []
    if not shutil.which("docker") or subprocess.run(
        ["docker", "compose", "version"], stdout=subprocess.DEVNULL).returncode:
        needed += ["docker.io", "docker-compose-v2"]
    if not shutil.which("curl"):
        needed += ["curl"]
    try:
        import cryptography
    except ImportError:
        needed += ["python3-cryptography"]
    if needed:
        subprocess.run(["apt-get", "update"], check=True)
        subprocess.run(["apt-get", "install", "-y", *needed], check=True)
    subprocess.run(["systemctl", "enable", "--now", "docker"], check=True)


def configure(hostname):
    from cryptography.hazmat.primitives.asymmetric import ec
    env = ROOT / ".env"
    if not env.exists():
        owner = ec.generate_private_key(ec.SECP256K1()).private_numbers()
        values = {
            "COMMUNITY_HOST": hostname, "BUZZ_DOMAIN": hostname, "RELAY_URL": "wss://" + hostname,
            "BUZZ_MEDIA_BASE_URL": "https://" + hostname + "/media", "BUZZ_MEDIA_SERVER_DOMAIN": hostname,
            "BUZZ_PAIRING_RELAY_URL": "wss://" + hostname + "/pair", "BUZZ_CORS_ORIGINS": "https://" + hostname,
            "BUZZ_REQUIRE_AUTH_TOKEN": "true", "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "true",
            "BUZZ_ALLOW_NIP_OA_AUTH": "true", "BUZZ_AUTO_MIGRATE": "true", "BUZZ_PUSH_ENABLED": "false",
            "BUZZ_IMAGE": IMAGE, "RELAY_OWNER_PUBKEY": format(owner.public_numbers.x, "064x"),
            "BUZZ_RELAY_PRIVATE_KEY": format(ec.generate_private_key(ec.SECP256K1()).private_numbers().private_value, "064x"),
            "BUZZ_GIT_HOOK_HMAC_SECRET": secrets.token_hex(32), "POSTGRES_PASSWORD": secrets.token_hex(24),
            "REDIS_PASSWORD": secrets.token_hex(24), "BUZZ_S3_ACCESS_KEY": secrets.token_hex(12),
            "BUZZ_S3_SECRET_KEY": secrets.token_hex(24), "BUZZ_S3_BUCKET": "buzz-media",
        }
        # On an interrupted first run only the final .env marks the keys as committed.
        write(ROOT / "owner.key", format(owner.private_value, "064x") + "\n")
        write(env, "".join(k + "=" + v + "\n" for k, v in values.items()))
    values = dict(line.split("=", 1) for line in env.read_text().splitlines())
    if values["COMMUNITY_HOST"] != hostname:
        sys.exit("This VPS already belongs to another workspace.")
    write(ROOT / "redis.conf", "bind 0.0.0.0\nprotected-mode yes\nappendonly yes\nmaxmemory 48mb\n"
          "maxmemory-policy noeviction\nrequirepass " + values["REDIS_PASSWORD"] + "\n", uid=999)
    for name, contents in FILES.items():
        write(ROOT / name, contents, mode=0o644)
    signing_key = ec.derive_private_key(int(values["BUZZ_RELAY_PRIVATE_KEY"], 16), ec.SECP256K1())
    return format(signing_key.public_key().public_numbers().x, "064x")


def main(slug, ip):
    if os.geteuid() or not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", slug):
        sys.exit("Open setup as the server administrator and enter a valid workspace name.")
    if not ipaddress.IPv4Address(ip).is_global:
        sys.exit("Enter the public IPv4 of the VPS.")
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / "setup.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("Another setup is running on this VPS.")
        provision(slug, ip)


def provision(slug, ip):
    state = ROOT / "address.json"
    hostname = slug + ".workrooms.bravebrand.com"
    if state.exists():
        saved = json.loads(state.read_text())
        if saved["slug"] != slug or saved["ip"] != ip:
            sys.exit("Setup is already in progress for another name or address on this VPS.")
    else:
        for port in (80, 443, 18447, 18448):
            with socket.socket() as check:
                check.bind(("", port))
        saved = {"owner": secrets.token_hex(32), "slug": slug, "ip": ip}
        write(state, json.dumps(saved))
    old_mask = os.umask(0o022)
    try:
        ensure_packages()
    finally:
        os.umask(old_mask)
    if not saved.get("registered"):
        link = getpass.getpass("Paste your BraveBrand Team access link from Skool and press Return: ")
        key = re.search(r"(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])", link)
        if not key:
            sys.exit("Check the access link and run setup again.")
        payload = {**saved, "membership": key.group()}
        result = subprocess.run(["curl", "-4", "--silent", "--show-error", "--max-time", "40",
                                 "--write-out", "\n%{http_code}", "-H", "Content-Type: application/json",
                                 "--data-binary", "@-", API], input=json.dumps(payload), capture_output=True, text=True)
        body, _, status = result.stdout.rpartition("\n")
        if status != "200":
            # A definitive conflict/refusal leaves a fresh VPS free to try another name.
            if status == "409" and body.startswith("That name or server") and not (ROOT / ".env").exists():
                state.unlink()
            sys.exit("Address service: " + (body[:220] if status in ("400","403","409") else
                                           "unavailable. Retry setup with the same name."))
        if json.loads(body).get("hostname") != hostname:
            sys.exit("Address service returned an unexpected hostname.")
        saved["registered"] = True
        write(state, json.dumps(saved))
    relay_key = configure(hostname)
    subprocess.run(["docker", "compose", "up", "-d"], cwd=ROOT, check=True)
    print("Waiting for public DNS and HTTPS...", flush=True)
    for _ in range(60):
        try:
            if socket.gethostbyname(hostname) == ip:
                req = urllib.request.Request("https://" + hostname + "/", headers={"Accept": "application/nostr+json"})
                with urllib.request.urlopen(req, timeout=5) as res:
                    if res.geturl() == req.full_url and json.load(res).get("self") == relay_key:
                        print("Workrooms is ready at https://" + hostname)
                        return
        except (OSError, ValueError):
            pass
        time.sleep(5)
    sys.exit("HTTPS is still starting. Allow inbound TCP 80 and 443 and retry using the same name.")


if __name__ == "__main__":
    main(*sys.argv[1:])
