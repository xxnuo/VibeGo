#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path, PurePosixPath

import stage_npm_packages


REPO_ROOT = Path(__file__).resolve().parent.parent
WAVETERM_ATTRIBUTION_FILES = (
    PurePosixPath("thirdparty/waveterm/LICENSE"),
    PurePosixPath("thirdparty/waveterm/NOTICE"),
)


class ReleasePackageTests(unittest.TestCase):
    def make_release_archive(
        self,
        root: Path,
        goos: str = "linux",
        goarch: str = "amd64",
    ) -> tuple[Path, bytes]:
        dist_dir = root / "dist"
        artifacts_dir = root / "artifacts"
        binary_name = f"vibego_v9.8.7_{goos}_{goarch}"
        if goos == "windows":
            binary_name += ".exe"
        binary_data = f"test-vibego-binary-{goos}-{goarch}\n".encode()
        dist_dir.mkdir(exist_ok=True)
        (dist_dir / binary_name).write_bytes(binary_data)

        subprocess.run(
            [
                "make",
                "package-backend",
                f"DIST_DIR={dist_dir}",
                f"ARTIFACTS_DIR={artifacts_dir}",
                "VERSION=v9.8.7",
                f"GOOS={goos}",
                f"GOARCH={goarch}",
            ],
            cwd=REPO_ROOT,
            check=True,
        )
        return artifacts_dir / f"vibego_v9.8.7_{goos}_{goarch}.tar.gz", binary_data

    def assert_attribution_contents(self, tf: tarfile.TarFile, prefix: str = "") -> None:
        for path in WAVETERM_ATTRIBUTION_FILES:
            archive_path = f"{prefix}{path.as_posix()}"
            stream = tf.extractfile(archive_path)
            self.assertIsNotNone(stream, archive_path)
            assert stream is not None
            self.assertEqual(stream.read(), (REPO_ROOT / path).read_bytes())

    def test_make_release_archive_contains_binary_and_attribution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="vibego-release-package-test-") as tmp:
            archive, binary_data = self.make_release_archive(Path(tmp))
            with tarfile.open(archive, "r:gz") as tf:
                self.assertEqual(
                    {member.name for member in tf.getmembers() if member.isfile()},
                    {
                        "vibego_v9.8.7_linux_amd64",
                        "thirdparty/waveterm/LICENSE",
                        "thirdparty/waveterm/NOTICE",
                    },
                )
                binary = tf.extractfile("vibego_v9.8.7_linux_amd64")
                self.assertIsNotNone(binary)
                assert binary is not None
                self.assertEqual(binary.read(), binary_data)
                self.assert_attribution_contents(tf)

    def test_all_platform_npm_packages_preserve_release_attribution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="vibego-npm-package-test-") as tmp:
            root = Path(tmp)
            artifacts_dir = root / "artifacts"
            output_dir = root / "npm"
            expected_binaries: dict[str, tuple[str, bytes]] = {}
            for (goos, goarch), platform in stage_npm_packages.PLATFORMS.items():
                archive, binary_data = self.make_release_archive(root, goos, goarch)
                self.assertEqual(archive.parent, artifacts_dir)
                expected_binaries[platform["pkg_suffix"]] = (platform["binary_name"], binary_data)

            result = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    str(REPO_ROOT / "scripts/stage_npm_packages.py"),
                    "--tag",
                    "v9.8.7",
                    "--artifacts-dir",
                    str(artifacts_dir),
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            metadata = json.loads(result.stdout)
            expected_tarballs = {
                "vibego-npm-9.8.7.tgz",
                *(f"vibego-npm-{suffix}-9.8.7.tgz" for suffix in expected_binaries),
            }
            self.assertEqual(set(metadata["files"]), expected_tarballs)
            self.assertEqual({path.name for path in output_dir.glob("*.tgz")}, expected_tarballs)

            for suffix, (binary_name, binary_data) in expected_binaries.items():
                tarball = output_dir / f"vibego-npm-{suffix}-9.8.7.tgz"
                with tarfile.open(tarball, "r:gz") as tf:
                    names = {member.name for member in tf.getmembers() if member.isfile()}
                    self.assertIn(f"package/vendor/{binary_name}", names)
                    self.assertIn("package/thirdparty/waveterm/LICENSE", names)
                    self.assertIn("package/thirdparty/waveterm/NOTICE", names)
                    binary = tf.extractfile(f"package/vendor/{binary_name}")
                    self.assertIsNotNone(binary)
                    assert binary is not None
                    self.assertEqual(binary.read(), binary_data)
                    self.assert_attribution_contents(tf, prefix="package/")

                    package_json = tf.extractfile("package/package.json")
                    self.assertIsNotNone(package_json)
                    assert package_json is not None
                    package_metadata = json.loads(package_json.read())
                    self.assertEqual(package_metadata["files"], ["vendor", "thirdparty/waveterm"])

    def test_platform_npm_package_rejects_archive_without_attribution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="vibego-npm-package-test-") as tmp:
            root = Path(tmp)
            artifacts_dir = root / "artifacts"
            artifacts_dir.mkdir()
            archive = artifacts_dir / "vibego_v9.8.7_linux_amd64.tar.gz"
            binary = root / "vibego"
            binary.write_bytes(b"test-vibego-binary\n")
            with tarfile.open(archive, "w:gz") as tf:
                tf.add(binary, arcname="vibego_v9.8.7_linux_amd64")

            with self.assertRaisesRegex(RuntimeError, "archive missing required files"):
                stage_npm_packages.stage_platform_package(
                    "9.8.7",
                    artifacts_dir,
                    root / "npm",
                    "v9.8.7",
                    "linux",
                    "amd64",
                    stage_npm_packages.PLATFORMS[("linux", "amd64")],
                )

    def test_release_workflow_uses_shared_archive_script(self) -> None:
        workflow = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn(
            'bash scripts/package_release_archive.sh dist "artifacts/${tar_name}" "${bin}"',
            workflow,
        )


if __name__ == "__main__":
    unittest.main()
