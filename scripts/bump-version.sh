#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

die() {
	echo "error: $*" >&2
	exit 1
}

normalize_version() {
	local raw="$1"
	raw="${raw#v}"
	if ! [[ "${raw}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		die "invalid version: ${raw}"
	fi
	echo "${raw}"
}

latest_tag() {
	git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1
}

next_patch_version() {
	local tag version major minor patch
	tag="$(latest_tag)"
	if [ -z "${tag}" ]; then
		echo "0.0.1"
		return
	fi
	version="${tag#v}"
	IFS=. read -r major minor patch <<< "${version}"
	echo "${major}.${minor}.$((patch + 1))"
}

replace_json_version() {
	local file="$1"
	local version="$2"
	uv run python - "${file}" "${version}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
data = json.loads(path.read_text())
data["version"] = version
if "packages" in data and "" in data["packages"] and isinstance(data["packages"][""], dict):
    data["packages"][""]["version"] = version
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

replace_regex() {
	local file="$1"
	local pattern="$2"
	local replacement="$3"
	uv run python - "${file}" "${pattern}" "${replacement}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
pattern = sys.argv[2]
replacement = sys.argv[3]
text = path.read_text()
new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
if count == 0:
    raise SystemExit(f"pattern not found in {path}: {pattern}")
path.write_text(new_text)
PY
}

rollback() {
	local tag="$1"
	if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
		git tag -d "${tag}" >/dev/null
	fi
	git restore -- ui/package.json ui/package-lock.json main.go internal/docs/swagger.json internal/docs/swagger.yaml
}

if [ -n "$(git status --porcelain)" ]; then
	die "working tree is not clean"
fi

input="${1:-}"
if [ -n "${input}" ]; then
	version="$(normalize_version "${input}")"
else
	version="$(next_patch_version)"
fi
tag="v${version}"

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
	die "tag already exists: ${tag}"
fi

replace_json_version "ui/package.json" "${version}"
if [ -f "ui/package-lock.json" ]; then
	replace_json_version "ui/package-lock.json" "${version}"
fi
replace_regex "main.go" '^// @version .*$' "// @version ${version}"
replace_regex "internal/docs/swagger.json" '("version": ")[^"]+(")' "\\g<1>${version}\\g<2>"
replace_regex "internal/docs/swagger.yaml" '(^  version: ).*$' "\\g<1>${version}"

git add ui/package.json ui/package-lock.json main.go internal/docs/swagger.json internal/docs/swagger.yaml
git commit -m "chore: bump version ${tag}"
git tag "${tag}"

if ! make verify-release; then
	echo "verify-release failed, rollback to previous version" >&2
	git tag -d "${tag}" >/dev/null 2>&1 || true
	git reset --hard HEAD~1
	exit 1
fi

current_branch="$(git branch --show-current)"
if [ -z "${current_branch}" ]; then
	rollback "${tag}"
	die "detached HEAD is not supported"
fi

git push origin "${current_branch}"
git push origin "${tag}"

echo "bumped and pushed ${tag}"
