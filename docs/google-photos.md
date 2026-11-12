# Google Photos: read this before setting up a slideshow

**Short version: Google closed the door that made this easy, in March 2025.
There is no supported way for a self-hosted appliance to watch a Google Photos
album unattended any more. Three workarounds exist and one of them is genuinely
better than what you have now.**

## What changed

The Google Photos **Library API** used to let an app you authorised list and
read your albums. That is what every photo-frame product was built on.

Effective **31 March 2025**, Google withdrew the broad read scopes
(`photoslibrary.readonly` and siblings) from third-party apps. An app can now
only see media that *it created*, or media the user hand-picks through the new
**Picker API** — a Google-hosted dialog where you select specific photos, and
the app receives short-lived URLs for only those.

This is not a permissions problem you can solve by verifying an app or paying
for something. The capability was removed.

**It affects DAKboard too.** Every dashboard product hit the same wall on the
same date. So this is not a way in which a self-hosted board is worse than what
you are paying for — it is a constraint you already live with.

## Why the Picker API cannot work here

A dashboard runs for months with nobody touching it. The Picker requires a
human to open a dialog and choose photos, and hands back URLs that expire. A
board built on it would go blank every time the tokens lapsed and would need
somebody to re-pick before it came back.

LifeBoard therefore lists `google_picker` as a backend but **deliberately does
not implement it**, and says so with a real message instead of failing
mysteriously.

## The three options that do work

### 1. A local folder — recommended if you have a NAS

Point the album at a directory. On a home server that is a share; mount it on the
appliance over SMB or NFS and give LifeBoard the path.

- Zero dependencies, zero API, no credentials, works with the internet down.
- Nothing can deprecate it.
- Dropping new photos in a folder is about as easy as adding them to an album.

```
Source type: Photo album
Backend:     Local folder
Path:        /mnt/photos/family
```

LifeBoard serves these by **index**, never by path, so a crafted request cannot
be turned into an arbitrary file read.

### 2. Immich — recommended if you want a real photo library

[Immich](https://immich.app) is a self-hosted photo library with albums, faces,
mobile apps with auto-upload, and a proper API. It runs well on Unraid.

This is the closest thing to the old Google Photos experience, and the version
of it that nobody can withdraw. Phones auto-upload to Immich, you curate an
album there, and the board follows it.

```
Backend:   Immich server
Immich URL: http://tower:2283
Album id:   (from the album's URL in the Immich web UI)
API key:    Immich → Account Settings → API Keys
```

LifeBoard proxies the image bytes, so the API key never reaches the browser.

### 3. A Google Photos share link — works today, not durable

Google Photos can publish an album to "anyone with the link". That page embeds
its photo list, and LifeBoard can read it.

```
Backend:    Google Photos share link
Share URL:  https://photos.app.goo.gl/xxxxxxxx
```

**Be clear-eyed about this one.** It is not an API and Google makes no promise
about it. It reads a page you deliberately published, and it will keep working
until Google changes that page's markup — at which point the slideshow stops
and the album needs re-pointing somewhere else. Use it to get running today;
plan on option 1 or 2 for the long term.

Also note that "anyone with the link" means exactly that. Do not use it for an
album you would mind a stranger seeing if the link leaked.

## Videos in an album

All three backends can serve video as well as stills, and the slideshow mixes
them in with the photos: muted, capped at thirty seconds by default, and
starting somewhere random inside anything longer.

How each backend knows which is which:

* **Local folder** — the file extension. `.mp4`, `.m4v`, `.webm`, `.mov` and
  `.ogv` are offered; `.mkv` and `.avi` deliberately are not, because the
  browser will not play them and a slide that cannot play is worse than one
  that was never listed.
* **Immich** — the asset type in its API. Unambiguous, and video is streamed
  through LifeBoard with the Range header forwarded, so seeking works.
* **Google Photos share link** — **measured, not guessed.** The page markup
  has no honest marker separating a video from a still, so instead of
  pattern-matching a blob Google can rearrange whenever it likes, LifeBoard
  asks for **one byte** of each item's video rendition (`=m18`) and reads the
  content type of the reply. A photograph does not come back as `video/mp4`.
  The answer is memoised, so an album is probed once rather than hourly.

  Tick **"Skip the video check (photos only)"** on the source to skip the
  probe entirely and treat the whole album as stills. If a probe fails for any reason the item is
  treated as a photo, which is exactly what this backend did before video
  existed — a broken probe must never turn a working album into forty black
  rectangles.

  `video_suffix` picks the rendition, and `m18` is the default on purpose: it
  is a modest progressive MP4, and **a Pi 3 decodes 1080p in the browser
  badly**. Raise it (`m22`, `m37`) only on x86 hardware.

> The single **Video** widget is a different thing and still the right tool for
> a permanent live stream: it plays through mpv with real hardware decode. The
> slideshow's clips play in the browser, which is fine for a thirty-second
> phone video and is not fine for a 24/7 feed.

## Recommendation

Start with the **share link** if you want your existing album on screen this
evening. Move to **Immich** when you want it to still be working in two years.
Use a **local folder** if you would rather not run another service at all.
