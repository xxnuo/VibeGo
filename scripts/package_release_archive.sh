#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: $0 DIST_DIR ARCHIVE_PATH BINARY_NAME" >&2
    exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
dist_dir="$1"
archive_path="$2"
binary_name="$3"

case "${binary_name}" in
    ""|-*|*/*|*\\*)
        echo "invalid binary name: ${binary_name}" >&2
        exit 2
        ;;
esac

if [ ! -d "${dist_dir}" ]; then
    echo "dist directory not found: ${dist_dir}" >&2
    exit 1
fi
dist_dir="$(cd "${dist_dir}" && pwd -P)"

if [ ! -f "${dist_dir}/${binary_name}" ]; then
    echo "binary not found: ${dist_dir}/${binary_name}" >&2
    exit 1
fi

attribution_files=(
    "thirdparty/waveterm/LICENSE"
    "thirdparty/waveterm/NOTICE"
)
for path in "${attribution_files[@]}"; do
    if [ ! -f "${repo_root}/${path}" ]; then
        echo "attribution file not found: ${repo_root}/${path}" >&2
        exit 1
    fi
done

archive_dir="$(dirname "${archive_path}")"
archive_name="$(basename "${archive_path}")"
mkdir -p "${archive_dir}"
archive_dir="$(cd "${archive_dir}" && pwd -P)"
archive_path="${archive_dir}/${archive_name}"
temporary_archive="${archive_path}.tmp.$$"
trap 'rm -f "${temporary_archive}"' EXIT

tar -czf "${temporary_archive}" \
    -C "${dist_dir}" "${binary_name}" \
    -C "${repo_root}" "${attribution_files[@]}"
mv "${temporary_archive}" "${archive_path}"
trap - EXIT
