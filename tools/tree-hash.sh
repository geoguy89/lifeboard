#!/usr/bin/env sh
# One hash for the whole deployed application tree.
#
#   tools/tree-hash.sh [root]        # default: the repo this script is in
#
# Run it against the source, an appliance's /opt/lifeboard, and a mounted
# image, and compare. Equal hashes mean the same code is in all three.
#
# This exists because a spot check lied. `admin.js` matched across the source,
# the running appliance and both images, which looked like proof that
# everything was in step - while two other files were a commit behind on two
# of the four. One file is not a manifest.
#
# Two details that are load-bearing:
#
#   * Only the checksum column is hashed. git-bash prints "hash *path" where
#     GNU coreutils prints "hash  path", so including the path makes a Windows
#     source tree differ from an identical Linux one for no reason. That
#     cosmetic difference initially pointed the investigation at the wrong
#     artifact.
#
#   * LC_ALL=C on the sort, or the file order - and therefore the hash -
#     depends on the machine's locale.
set -eu

ROOT="${1:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$ROOT" || { echo "no such directory: $ROOT" >&2; exit 1; }

if [ ! -d web ] || [ ! -d server/lifeboard ]; then
  echo "not a lifeboard tree: $ROOT" >&2
  exit 1
fi

find web server/lifeboard templates deploy -type f \
     ! -path '*__pycache__*' ! -name '*.pyc' 2>/dev/null \
  | LC_ALL=C sort \
  | xargs md5sum 2>/dev/null \
  | awk '{print $1}' \
  | md5sum \
  | cut -c1-32
