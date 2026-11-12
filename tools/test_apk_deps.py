"""Everything the server needs must also be inside the APK.

The Pi and x86 images install server/requirements.txt with pip. The Android
build cannot: Chaquopy needs each package named in build.gradle, with wheels
that exist for armeabi-v7a. So the two lists have to agree, and they are
maintained by hand in different files - which is precisely the arrangement that
drifts.

It has drifted twice:

  * Five packages were missing because they are imported LAZILY, inside the
    functions that use them, and the scan that was supposed to find them only
    matched imports at the start of a line. RSS, every iCal calendar and every
    QR code were broken on the TV.

  * python-multipart was missing because NOTHING IMPORTS IT. FastAPI reaches
    for it from inside request.form(). No amount of reading our own import
    graph would ever have found it - it exists only in requirements.txt. The
    failure was ugly: it raises while the browser is still streaming the body,
    so the connection dies mid-upload and the browser reports "Failed to fetch"
    with no status and no message. Uploading a Bible to a television looked
    like a network fault, and the media library had never worked on Android at
    all.

So this compares the two files directly rather than inferring anything from the
code. It is allowed to know about deliberate differences, and each one has to
say why.

    python tools/test_apk_deps.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

problems = []

# ---------------------------------------------------------------- the lists
requirements = os.path.join(ROOT, "server", "requirements.txt")
gradle = os.path.join(ROOT, "android", "app", "build.gradle")

for path in (requirements, gradle):
    if not os.path.exists(path):
        print(f"  skipped: {os.path.relpath(path, ROOT)} is not here")
        sys.exit(0)


def normalise(name: str) -> str:
    """PyPI treats runs of - _ . as the same character, and is case-blind."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


needed = {}
with open(requirements, encoding="utf8") as fh:
    for line in fh:
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        # "uvicorn[standard]>=0.30" -> "uvicorn"
        name = re.split(r"[\[<>=!~;]", line, maxsplit=1)[0]
        if name:
            needed[normalise(name)] = line

pinned = set()
with open(gradle, encoding="utf8") as fh:
    for line in fh:
        code = line.split("//", 1)[0]
        for match in re.finditer(r'install\s+"([^"]+)"', code):
            spec = match.group(1)
            name = re.split(r"[\[<>=!~;]", spec, maxsplit=1)[0]
            pinned.add(normalise(name))

# ------------------------------------------------- deliberate differences --
ALLOWED_ABSENT = {
    # Chaquopy has no wheel for the [standard] extras and does not need them:
    # the app serves loopback traffic to its own WebView, so the C accelerators
    # buy nothing. Plain uvicorn IS pinned.
    "uvicorn-standard",
}

missing = sorted(
    name for name in needed
    if name not in pinned and name not in ALLOWED_ABSENT
)

if missing:
    for name in missing:
        problems.append(
            f"{needed[name]!r} is in server/requirements.txt but nothing in "
            f"android/app/build.gradle installs {name!r} - it will be absent "
            "from the APK")
else:
    print(f"  ok   all {len(needed)} server requirements are pinned for the APK")

# python-multipart is the one nothing imports, so it is named outright: a
# generic check is easy to satisfy by deleting a line from requirements.txt.
if "python-multipart" not in pinned:
    problems.append(
        "python-multipart is not pinned for the APK, so every file upload - "
        "the Bible text and the media library - dies mid-request with "
        '"Failed to fetch"')
else:
    print("  ok   python-multipart is pinned, so uploads work on Android")

# ...and the reverse, which is not a failure but is worth seeing: things the
# APK carries that the server list does not mention.
extra = sorted(pinned - set(needed) - {"pydantic", "h11", "tzdata"})
if extra:
    print(f"  note the APK also pins: {', '.join(extra)}")

if problems:
    print("\nFAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\nThe APK carries what the server asks for.")
