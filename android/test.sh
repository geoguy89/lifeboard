#!/usr/bin/env bash
# Run the calibration maths on a desktop JVM.
#
#   ./test.sh
#
# Calibration.fit() and its solver touch no Android classes, so they run
# anywhere. android.jar is on the classpath only so the file compiles - the
# stubs in it throw if called, and nothing here calls them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/AppData/Local/Android/Sdk}}"
[ -d "$SDK" ] || SDK="/c/Users/$USER/AppData/Local/Android/Sdk"
PLATFORM="$(ls -1d "$SDK"/platforms/* | sort -V | tail -1)"

JDK=""
for candidate in "/c/Program Files/Android/Android Studio/jbr" "${JAVA_HOME:-}"; do
  if [ -n "$candidate" ] && [ -x "$candidate/bin/javac" ]; then JDK="$candidate"; break; fi
done
JAVAC="${JDK:+$JDK/bin/javac}"; JAVAC="${JAVAC:-javac}"
JAVA="${JDK:+$JDK/bin/java}";   JAVA="${JAVA:-java}"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
CP="$(cygpath -w "$PLATFORM/android.jar")"

"$JAVAC" -nowarn -classpath "$CP" -d "$(cygpath -w "$WORK")" \
  "$(cygpath -w "$HERE/app/src/main/java/com/lifeboard/tv/Calibration.java")" \
  "$(cygpath -w "$HERE/test/CalibrationTest.java")"

"$JAVA" -classpath "$(cygpath -w "$WORK");$CP" CalibrationTest

# --- does every Java file even parse? -------------------------------------
#
# Worth its own check because the failure mode is remote and expensive: a
# mangled escape compiles nowhere, but the only place that shows up is a
# 20-minute Gradle build on another machine. Chaquopy's classes are not on this
# classpath, so "cannot find symbol" for Python/AndroidPlatform/PyObject is
# expected and filtered - anything else is a real syntax error.
echo
echo "==> checking every Java file parses"
find "$HERE/app/src/main/java" -name '*.java' -print0 | xargs -0 cygpath -w > "$WORK/java.txt"
set +e
OUTPUT="$("$JAVAC" -nowarn -classpath "$CP" -d "$(cygpath -w "$WORK")"   "@$(cygpath -w "$WORK/java.txt")" 2>&1)"
set -e
REAL="$(echo "$OUTPUT" | grep -E 'error:'   | grep -viE 'chaquo|cannot find symbol' || true)"
SYMBOLS="$(echo "$OUTPUT" | grep -cE 'cannot find symbol' || true)"
if [ -n "$REAL" ]; then
  echo "$REAL"
  echo "  Java has syntax errors - the APK build would fail on this."
  exit 1
fi
echo "  all Java parses ($SYMBOLS Chaquopy symbols unresolved locally, expected)"
