#!/bin/sh
# Turns on this repo's versioned hooks (.githooks/). Run by `npm install`
# through package.json's prepare; by hand: sh .githooks/install.sh
# Does nothing unless this directory is the top of its own git checkout, so
# an install of the package inside some other repo never touches that repo.
d=$(cd "$(dirname "$0")/.." && pwd -P)
top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$(cd "$top" && pwd -P)" = "$d" ] || exit 0
git -C "$d" config core.hooksPath .githooks
