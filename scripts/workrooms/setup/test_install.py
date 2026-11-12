import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import install


class SetupTest(unittest.TestCase):
    def test_retry_resumes_without_new_claim_or_member_prompt(self):
        ip, slug = "8.8.8.8", "acme"
        host = slug + ".workrooms.bravebrand.com"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            claimed = []
            started = []
            def run(args, **kwargs):
                if args[0] == "curl":
                    claimed.append(json.loads(kwargs["input"]))
                    return subprocess.CompletedProcess(args, 0, json.dumps({"hostname": host}) + "\n200")
                started.append(args)
                if len(started) == 1:
                    raise subprocess.CalledProcessError(1, args)
            def local_write(path, contents):
                path.write_text(contents)
            reply = io.BytesIO(b'{"self":"test-relay"}')
            reply.geturl = lambda: "https://" + host + "/"
            mask = os.umask(0o077)
            self.addCleanup(os.umask, mask)
            with (patch.object(install, "ROOT", root), patch.object(install, "ensure_packages"),
                  patch.object(install, "write", local_write), patch.object(install, "configure", return_value="test-relay"),
                  patch.object(os, "geteuid", return_value=0), patch("socket.socket"),
                  patch("socket.gethostbyname", return_value=ip),
                  patch("urllib.request.urlopen", return_value=reply),
                  patch("getpass.getpass", return_value="a"*24) as member,
                  patch("subprocess.run", side_effect=run)):
                with self.assertRaises(subprocess.CalledProcessError):
                    install.main(slug, ip)
                install.main(slug, ip)
                member.assert_called_once()
                self.assertEqual(len(claimed), 1)
                self.assertEqual(len(started), 2)
                self.assertNotIn("membership", json.loads((root/"address.json").read_text()))
                with self.assertRaises(SystemExit):
                    install.main("different", ip)


if __name__ == "__main__":
    unittest.main()
