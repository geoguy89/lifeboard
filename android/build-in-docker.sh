#!/usr/bin/env bash
# Build the standalone APK inside a Linux container.
#
#   docker run --rm -v "$(pwd)":/src:ro -v /path/to/build:/out debian:bookworm \
#     bash /src/android/build-in-docker.sh      (run from the repo root)
#
# WHY A CONTAINER
# ---------------
# The viewer built fine on Windows because it had no dependencies. The
# standalone one downloads Gradle, the Android Gradle Plugin, Chaquopy and a
# set of Python wheels - and it does all that through a Linux toolchain that
# has never met a path with a space in it. A clean Linux container removes an
# entire class of problem.
#
# Everything is cached under /out/cache so a second build does not
# re-download 400MB. The APK is written to /out.
set -euo pipefail

OUT=/out
SRC=/src

echo "==> installing the toolchain"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  openjdk-17-jdk-headless wget unzip python3 python3-pip ca-certificates git >/dev/null

export ANDROID_SDK_ROOT="$OUT/cache/android-sdk"
export GRADLE_USER_HOME="$OUT/cache/gradle"
mkdir -p "$ANDROID_SDK_ROOT" "$GRADLE_USER_HOME"

# --- Android SDK ----------------------------------------------------------
if [ ! -d "$ANDROID_SDK_ROOT/cmdline-tools/latest" ]; then
  echo "==> fetching the Android command line tools"
  wget -q -O /tmp/tools.zip \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
  unzip -q /tmp/tools.zip -d "$ANDROID_SDK_ROOT/cmdline-tools"
  mv "$ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  rm -f /tmp/tools.zip
fi
export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"

yes | sdkmanager --licenses >/dev/null 2>&1 || true
echo "==> installing platform + build tools"
sdkmanager --install "platforms;android-34" "build-tools;34.0.0" "platform-tools" >/dev/null

# --- Gradle ---------------------------------------------------------------
GRADLE_VERSION=8.7
if [ ! -x "$OUT/cache/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  echo "==> fetching gradle $GRADLE_VERSION"
  wget -q -O /tmp/gradle.zip \
    "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
  unzip -q /tmp/gradle.zip -d "$OUT/cache"
  rm -f /tmp/gradle.zip
fi
export PATH="$OUT/cache/gradle-$GRADLE_VERSION/bin:$PATH"

# --- build ----------------------------------------------------------------
# Copied out of the read-only mount because Gradle writes build/ next to the
# sources, and because the Python source dir is referenced as ../../server.
WORK=/tmp/build
rm -rf "$WORK"; mkdir -p "$WORK"
cp -a "$SRC/android" "$WORK/android"
cp -a "$SRC/server" "$WORK/server"
cp -a "$SRC/web" "$WORK/web"
cp -a "$SRC/templates" "$WORK/templates"

# --- lower the board's JavaScript for old TV browsers ---------------------
#
# The renderer is written for a current Chromium, which is what the Pi has. A
# TV box ships whatever System WebView it was flashed with years ago and often
# has no store to update it from, so the board has to meet it rather than the
# other way round.
#
# Two features decide this: `replaceChildren` (Chrome 86) is an API and is
# polyfilled in compat.js, but `?.` and `??` (Chrome 80) are SYNTAX - a file
# using them fails to parse outright, and no polyfill can help. esbuild lowers
# them to plain equivalents.
#
# Per file, keeping ES module format, rather than bundling into one file:
# the layout on disk stays identical, the server serves the same paths, and
# the only difference is the syntax inside each file. A bundle would be a
# second thing to get wrong for no gain here.
echo "==> lowering the board's javascript for old WebViews"
ESBUILD_VERSION=0.21.5
if [ ! -x "$OUT/cache/esbuild/bin/esbuild" ]; then
  mkdir -p "$OUT/cache/esbuild"
  wget -q -O /tmp/esbuild.tgz     "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-${ESBUILD_VERSION}.tgz"
  tar -xzf /tmp/esbuild.tgz -C "$OUT/cache/esbuild" --strip-components=1
  rm -f /tmp/esbuild.tgz
fi
ESBUILD="$OUT/cache/esbuild/bin/esbuild"

lowered=0
while IFS= read -r js; do
  "$ESBUILD" "$js" --target=es2017 --format=esm --log-level=warning     --outfile="$js.lowered" >/dev/null
  mv -f "$js.lowered" "$js"
  lowered=$((lowered + 1))
# compat.js is EXCLUDED, and that is not an optimisation. It is a classic
# script - not a module - whose entire job is to run on an engine too old for
# everything else and report what is missing. Running it through esbuild with
# --format=esm would turn the one file that must always parse into a module,
# and an engine without module support would then skip the very thing meant to
# explain why nothing works.
done < <(find "$WORK/web/render" "$WORK/web/admin" -name '*.js' ! -name 'compat.js')
echo "    $lowered files lowered to ES2017 (Chrome 61+), compat.js left as ES5"

cd "$WORK/android"
echo "==> gradle assembleDebug"
gradle --no-daemon --console=plain assembleDebug

APK="$(find "$WORK/android/app/build/outputs/apk" -name '*.apk' | head -1)"
[ -n "$APK" ] || { echo "no APK produced" >&2; exit 1; }

mkdir -p "$OUT"
cp -f "$APK" "$OUT/LifeBoard-standalone.apk"
echo
echo "==> $OUT/LifeBoard-standalone.apk"
ls -lh "$OUT/LifeBoard-standalone.apk" | awk '{print "    " $5}'

# --- what actually ended up in it -----------------------------------------
echo
echo "==> contents"
python3 - "$OUT/LifeBoard-standalone.apk" <<'PY'
import sys, zipfile, collections
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
abis = sorted({n.split('/')[1] for n in names if n.startswith('lib/')})
print("    ABIs:            ", ", ".join(abis) or "none")
buckets = collections.Counter()
for n in names:
    if n.startswith('lib/'):            buckets['native (python runtime)'] += z.getinfo(n).file_size
    elif n.startswith('assets/'):       buckets['assets'] += z.getinfo(n).file_size
    else:                               buckets['other'] += z.getinfo(n).file_size
for key, size in buckets.most_common():
    print(f"    {key:24} {size/1e6:6.1f} MB uncompressed")
for want in ("assets/chaquopy", "assets/web", "assets/templates"):
    hits = [n for n in names if n.startswith(want)]
    print(f"    {want:24} {len(hits)} entries")
PY
