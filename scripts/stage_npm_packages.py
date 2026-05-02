#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

REPOSITORY_URL = "https://github.com/xxnuo/VibeGo"
WAVETERM_ATTRIBUTION_FILES = (
    PurePosixPath("thirdparty/waveterm/LICENSE"),
    PurePosixPath("thirdparty/waveterm/NOTICE"),
)

PLATFORMS = {
    ("android", "arm64"): {
        "node_os": "android",
        "node_cpu": "arm64",
        "pkg_suffix": "android-arm64",
        "binary_name": "vibego",
    },
    ("linux", "amd64"): {
        "node_os": "linux",
        "node_cpu": "x64",
        "pkg_suffix": "linux-x64",
        "binary_name": "vibego",
    },
    ("linux", "arm64"): {
        "node_os": "linux",
        "node_cpu": "arm64",
        "pkg_suffix": "linux-arm64",
        "binary_name": "vibego",
    },
    ("darwin", "amd64"): {
        "node_os": "darwin",
        "node_cpu": "x64",
        "pkg_suffix": "darwin-x64",
        "binary_name": "vibego",
    },
    ("darwin", "arm64"): {
        "node_os": "darwin",
        "node_cpu": "arm64",
        "pkg_suffix": "darwin-arm64",
        "binary_name": "vibego",
    },
    ("windows", "amd64"): {
        "node_os": "win32",
        "node_cpu": "x64",
        "pkg_suffix": "win32-x64",
        "binary_name": "vibego.exe",
    },
    ("windows", "arm64"): {
        "node_os": "win32",
        "node_cpu": "arm64",
        "pkg_suffix": "win32-arm64",
        "binary_name": "vibego.exe",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, default=Path("scripts/npm/vibego.js"))
    return parser.parse_args()


def run(cmd: list[str], cwd: Path | None = None) -> str:
    res = subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)
    return res.stdout


def npm_pack(staging_dir: Path, output_path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="vibego-npm-pack-") as tmp:
        pack_dir = Path(tmp)
        out = run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(pack_dir)], cwd=staging_dir)
        data = json.loads(out)
        if isinstance(data, list):
            packages = data
        elif isinstance(data, dict):
            packages = list(data.values())
        else:
            packages = []
        if len(packages) != 1 or not isinstance(packages[0], dict):
            raise RuntimeError("npm pack did not return any output")
        filename = packages[0].get("filename")
        if not filename:
            raise RuntimeError("npm pack output missing filename")
        src = pack_dir / filename
        if not src.exists():
            raise RuntimeError(f"npm pack output not found: {src}")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), output_path)


def archive_file_members(tf: tarfile.TarFile, archive: Path) -> dict[PurePosixPath, tarfile.TarInfo]:
    files: dict[PurePosixPath, tarfile.TarInfo] = {}
    for member in tf.getmembers():
        if not member.isfile():
            continue
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError(f"unsafe archive path in {archive}: {member.name}")
        if path in files:
            raise RuntimeError(f"duplicate archive path in {archive}: {member.name}")
        files[path] = member
    return files


def read_archive_file(tf: tarfile.TarFile, archive: Path, member: tarfile.TarInfo) -> bytes:
    stream = tf.extractfile(member)
    if stream is None:
        raise RuntimeError(f"cannot extract file from archive: {archive}: {member.name}")
    return stream.read()


def extract_release_files(
    archive: Path,
    archive_binary_name: str,
    package_binary_name: str,
    package_root: Path,
) -> None:
    binary_path = PurePosixPath(archive_binary_name)
    with tarfile.open(archive, "r:gz") as tf:
        members = archive_file_members(tf, archive)
        if binary_path not in members:
            raise RuntimeError(f"archive missing binary {archive_binary_name}: {archive}")

        missing = [str(path) for path in WAVETERM_ATTRIBUTION_FILES if path not in members]
        if missing:
            raise RuntimeError(f"archive missing required files: {archive}: {', '.join(missing)}")
        binary_data = read_archive_file(tf, archive, members[binary_path])
        attribution = {
            path: read_archive_file(tf, archive, members[path])
            for path in WAVETERM_ATTRIBUTION_FILES
        }

    binary_dest = package_root / "vendor" / package_binary_name
    binary_dest.parent.mkdir(parents=True, exist_ok=True)
    binary_dest.write_bytes(binary_data)
    binary_dest.chmod(0o755)

    for path in WAVETERM_ATTRIBUTION_FILES:
        dest = package_root.joinpath(*path.parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(attribution[path])


def stage_platform_package(
    version: str,
    artifacts_dir: Path,
    output_dir: Path,
    tag: str,
    goos: str,
    goarch: str,
    platform: dict[str, str],
) -> Path:
    archive = artifacts_dir / f"vibego_{tag}_{goos}_{goarch}.tar.gz"
    if not archive.exists():
        raise RuntimeError(f"missing artifact: {archive}")
    archive_binary_name = f"vibego_{tag}_{goos}_{goarch}"
    if goos == "windows":
        archive_binary_name += ".exe"

    pkg_name = f"@vibego/vibego-{platform['pkg_suffix']}"

    with tempfile.TemporaryDirectory(prefix=f"vibego-npm-{platform['pkg_suffix']}-") as tmp:
        root = Path(tmp)
        package_json = {
            "name": pkg_name,
            "version": version,
            "os": [platform["node_os"]],
            "cpu": [platform["node_cpu"]],
            "files": ["vendor", "thirdparty/waveterm"],
            "repository": {
                "type": "git",
                "url": REPOSITORY_URL,
            },
        }
        (root / "package.json").write_text(json.dumps(package_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        extract_release_files(archive, archive_binary_name, platform["binary_name"], root)

        tarball = output_dir / f"vibego-npm-{platform['pkg_suffix']}-{version}.tgz"
        npm_pack(root, tarball)
        return tarball


def stage_main_package(version: str, output_dir: Path, launcher: Path, platform_versions: dict[str, str]) -> Path:
    if not launcher.exists():
        raise RuntimeError(f"launcher not found: {launcher}")

    optional_dependencies = {
        f"@vibego/vibego-{suffix}": version
        for suffix in sorted(platform_versions.keys())
    }

    with tempfile.TemporaryDirectory(prefix="vibego-npm-main-") as tmp:
        root = Path(tmp)
        (root / "bin").mkdir(parents=True, exist_ok=True)
        shutil.copy2(launcher, root / "bin" / "vibego.js")
        (root / "bin" / "vibego.js").chmod(0o755)

        package_json = {
            "name": "vibego",
            "version": version,
            "type": "module",
            "bin": {
                "vibego": "bin/vibego.js"
            },
            "files": ["bin"],
            "engines": {
                "node": ">=16"
            },
            "optionalDependencies": optional_dependencies,
            "repository": {
                "type": "git",
                "url": REPOSITORY_URL,
            },
        }
        (root / "package.json").write_text(json.dumps(package_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        tarball = output_dir / f"vibego-npm-{version}.tgz"
        npm_pack(root, tarball)
        return tarball


def validate_tag(tag: str) -> str:
    if not tag.startswith("v"):
        raise RuntimeError(f"tag must start with v: {tag}")
    version = tag[1:]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise RuntimeError(f"invalid semver tag: {tag}")
    return version


def main() -> int:
    args = parse_args()
    tag = args.tag.strip()
    version = validate_tag(tag)

    artifacts_dir = args.artifacts_dir.resolve()
    output_dir = args.output_dir.resolve()
    launcher = args.launcher.resolve()

    if not artifacts_dir.exists():
        raise RuntimeError(f"artifacts directory not found: {artifacts_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)

    platform_versions: dict[str, str] = {}

    for (goos, goarch), platform in PLATFORMS.items():
        stage_platform_package(version, artifacts_dir, output_dir, tag, goos, goarch, platform)
        platform_versions[platform["pkg_suffix"]] = version

    stage_main_package(version, output_dir, launcher, platform_versions)

    files = sorted(p.name for p in output_dir.glob("*.tgz"))
    print(json.dumps({"version": version, "files": files}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
