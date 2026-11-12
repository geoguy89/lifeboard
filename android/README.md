# LifeBoard for Android TV

The whole LifeBoard — server, database and board — in one APK for an Android
TV box, with touch calibration for an overlay frame.

**Install:** download `LifeBoard-standalone.apk` from the
[latest release](https://github.com/geoguy89/lifeboard/releases/latest), then
`adb install -r LifeBoard-standalone.apk`, or copy it to the box and open it.
Releases are built and signed by GitHub Actions
(`.github/workflows/android.yml`); from v1.0.0 on they share one signing key,
so a newer release installs over the old one.

**Build it yourself:**

```
# from the repo root; the APK lands in /path/to/build
docker run --rm -v "$(pwd)":/src:ro -v /path/to/build:/out debian:bookworm \
  bash /src/android/build-in-docker.sh
adb install -r /path/to/build/LifeBoard-standalone.apk

./android/test.sh   # the calibration maths, on a desktop JVM
```

A build without a signing key uses a throwaway debug key, so it will not
install over a release APK (uninstall first). To sign with your own key, set
`LIFEBOARD_KEYSTORE` (a PKCS#12 file, mounted into the container) and
`LIFEBOARD_KEYSTORE_PASSWORD`.

## What this is

**It is a complete board.** The same Python server the Pi image runs is
embedded with Chaquopy and started as a foreground service, so the app needs
nothing else on the network: open it, browse to the address it shows from a
phone or laptop, and set it up exactly as you would a Pi.

**It can also be a second screen.** Point it at another board in Settings
(for example a Pi at `http://lifeboard.local:8080/render/`) and it shows that
one instead; the embedded server keeps running harmlessly.

Several things in the Pi and x86 images are **not missing here, they are
moot**: Android owns the Wi-Fi, so the setup hotspot has nothing to do;
rotation is an Android setting rather than `xrandr`; boot is a receiver rather
than systemd. HDMI-CEC is the one real loss — a normal Android app cannot turn
a TV off, so the board's scheduled power-off does nothing on this platform.

## Devices

`minSdk 24` (Android 7.0). The embedded Python ships for `armeabi-v7a`,
`arm64-v8a` and `x86_64`, which covers the cheap ARMv7 TV boxes as well as
current ones.

## Touch calibration

A TV with a touch frame bolted to it is two devices that have never been
introduced. The frame reports coordinates in its own space, and until somebody
maps that onto the panel, touches land near where you meant rather than where
you meant — offset, wrongly scaled because the frame is a different aspect, or
with an axis inverted so the board fights you.

The system-wide fix is an input device config in `/system`, which needs root.
This app instead corrects coordinates on their way into its own window, which
for a kiosk amounts to the same thing.

**To calibrate:** hold the top-left corner for two seconds (or press MENU on
the remote) → *Calibrate touch screen* → touch each of the five crosses →
check the circle lands under your finger → OK to save.

It fits a **full affine transform**, so it handles offset, scale, skew,
rotation and axis inversion — not just an offset. Five points rather than the
minimum three, because a person aiming at a crosshair on a TV is a centimetre
out on a good day and with three points that error *becomes* the transform.
The residual is shown so a bad run can be rejected, and a fit that would make
the screen unusable is refused outright rather than saved — the one calibration
you cannot tap your way out of is a broken one.

The targets sit 10% in from the corners: a frame is least accurate at its
extreme edges, and anchoring the fit on its worst readings makes it worse
everywhere else. The centre point catches a frame with its axes swapped, which
the four corners alone are symmetric enough to fit plausibly without.

`./test.sh` simulates six real frame faults — offset, scale, inverted Y,
swapped axes, a frame taped on 2.5° out of true, and all of it at once with a
shaky finger — and checks the fit recovers each one **at points it never
calibrated on**. Fitting five points is easy; making the rest of the screen
work is the thing.

## Getting back to the settings

From a wall, with no keyboard:

- **hold the top-left corner for two seconds**, or
- **press MENU** on the remote (also `SETTINGS`).

`BACK` is swallowed on purpose — on a kiosk it means "leave the board", and
there is nothing behind it.

## Starting on boot

`BootReceiver` starts the board after a power cut, which matters because the TV
and the Pi are usually on the same socket. It is **not guaranteed**: since
Android 10 a background app cannot always start an activity, and several TV
boxes ship an "auto start" whitelist this has to be added to.

If it will not stick, make this app the box's **home launcher** — it declares
`LEANBACK_LAUNCHER` so it appears on an Android TV home screen. That is the
reliable kiosk arrangement.

## How it is built

Gradle with the Chaquopy plugin, which packages the Python server, the web
app and the templates into the APK. `build-in-docker.sh` does the whole thing
in a clean Debian container: it fetches the Android command-line tools,
Gradle and esbuild (cached under `/out/cache`), lowers the board's JavaScript
to ES2017 so older Android System WebViews can run it, and builds the APK.

A clean Linux container is used because Chaquopy and its wheels go through a
Linux toolchain that does not cope with Windows paths containing spaces.

The signing key (`lifeboard-debug.keystore`) is generated on first build and
kept beside the project; it is gitignored. It is not a secret: what it buys is
that the *next* build installs over the top instead of being refused, so it
only has to be the same key each time.

## Setting it up

1. `adb install -r LifeBoard-standalone.apk`, or copy it to the box and open it.
2. The board starts and shows its own setup screen with the address to open,
   such as `http://<address>:8080/admin/`. Open that from a phone or
   laptop on the same network and run through the setup wizard.
3. Choose the orientation and calibrate the touch screen in the app's settings
   (hold the top-left corner for two seconds, or press MENU on the remote).
4. To use it as a second screen for another board instead, enter that board's
   address (`http://<your-board>:8080/render/`) in the app's settings.
