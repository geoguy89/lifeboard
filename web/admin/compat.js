/* Make the board survive an old browser, and say so when it cannot.
 *
 * NOT a module, and loaded before everything else. A `<script type="module">`
 * that fails to parse throws silently and paints nothing, so anything meant to
 * catch that failure has to already be running as a classic script.
 *
 * WHY THIS EXISTS
 * ---------------
 * The board runs on whatever browser its display has. On a Pi that is a
 * current Chromium. Inside the Android app it is the device's own System
 * WebView, and on a TV box that has never been updated - which is most of them
 * - that can be years old. Chrome 86 is where `replaceChildren` arrived, and
 * the renderer uses it 54 times, so on Chrome 85 the very first paint throws
 * and the wall goes black with nothing to explain it.
 *
 * A black screen is the worst possible failure for a display with no keyboard,
 * no devtools and nobody standing in front of it. So two jobs:
 *
 *   1. Polyfill what can be polyfilled, so an old engine simply works.
 *   2. When something still breaks, PUT IT ON THE SCREEN. An error nobody can
 *      read is indistinguishable from dead hardware.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ polyfills */

  // Chrome 86 / Safari 14. The single most-used modern DOM call in the
  // renderer, and the one that decides whether an old WebView works at all.
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    var replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      if (arguments.length) this.append.apply(this, arguments);
    };
    Element.prototype.replaceChildren = replaceChildren;
    if (typeof DocumentFragment !== 'undefined') {
      DocumentFragment.prototype.replaceChildren = replaceChildren;
    }
    if (typeof Document !== 'undefined') {
      Document.prototype.replaceChildren = replaceChildren;
    }
  }

  // Chrome 54, but some TV WebViews are stripped oddly and it is two lines.
  if (typeof Element !== 'undefined' && !Element.prototype.append) {
    Element.prototype.append = function () {
      for (var i = 0; i < arguments.length; i++) {
        var node = arguments[i];
        this.appendChild(typeof node === 'string'
          ? document.createTextNode(node) : node);
      }
    };
  }

  // Chrome 61.
  if (typeof Element !== 'undefined' && !Element.prototype.remove) {
    Element.prototype.remove = function () {
      if (this.parentNode) this.parentNode.removeChild(this);
    };
  }

  /* Array.prototype.flat - Chrome 69.
   *
   * This one is why the board went black on a Chrome 66 TV, and it is worth
   * being specific about: `flat()` is called inside `el()`, the helper that
   * builds EVERY element. So the failure was not a widget looking wrong, it
   * was the first element of the first paint throwing, and nothing after it
   * ever running. One missing method from 2018, one entirely black wall.
   */
  if (typeof Array !== 'undefined' && !Array.prototype.flat) {
    Array.prototype.flat = function (depth) {
      var levels = depth === undefined ? 1 : Number(depth);
      var out = [];
      (function walk(list, left) {
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (Array.isArray(item) && left > 0) walk(item, left - 1);
          else out.push(item);
        }
      })(this, levels);
      return out;
    };
  }

  // Chrome 76. Only the RSS widget uses it, so this is the difference between
  // one broken block and one broken block plus an unhandled rejection.
  if (typeof Promise !== 'undefined' && !Promise.allSettled) {
    Promise.allSettled = function (promises) {
      return Promise.all(Array.prototype.map.call(promises, function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      }));
    };
  }

  // Chrome 69 / 73 respectively. Neither is used today; both are two lines,
  // and finding out on a wall six months from now is the expensive way.
  if (typeof Array !== 'undefined' && !Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, self) {
      return Array.prototype.map.call(this, fn, self).flat();
    };
  }
  if (typeof Object !== 'undefined' && !Object.fromEntries) {
    Object.fromEntries = function (pairs) {
      var out = {};
      Array.prototype.forEach.call(pairs, function (pair) { out[pair[0]] = pair[1]; });
      return out;
    };
  }

  /* Optional chaining and nullish coalescing are SYNTAX, not API - they cannot
   * be polyfilled. An engine below Chrome 80 will fail to parse the modules
   * outright, which is what the check below is for: it is the difference
   * between "the board is broken" and "this TV's browser is too old, here is
   * the version and what to do". */

  /* ------------------------------------------------- what this engine lacks */

  /* What this engine lacks THAT THE BOARD STILL NEEDS.
   *
   * The first version of this listed optional chaining, and on a Chrome 66 TV
   * it duly reported that - which was true about the engine and false about
   * the board, because the APK build lowers that syntax away before shipping.
   * A diagnostic that reports a problem which is not the problem is worse than
   * silence: it sends somebody hunting for a WebView update they do not need.
   *
   * So this only reports what is genuinely still required after the polyfills
   * above and the build's lowering.
   */
  function missingFeatures() {
    var missing = [];

    // ES modules. Nothing can be done about these from here - the board is
    // built of them - so this is the one that really does mean "too old".
    var probe = document.createElement('script');
    if (!('noModule' in probe)) {
      missing.push('JavaScript modules (needs Chrome 61+)');
    }

    try {
      new Function('return (async function () { return 1; })();')();
    } catch (e) {
      missing.push('async functions (needs Chrome 55+)');
    }

    if (typeof Promise === 'undefined' || typeof fetch === 'undefined') {
      missing.push('fetch and Promises (needs Chrome 42+)');
    }

    if (typeof ResizeObserver === 'undefined') {
      // Scrolling only. scroll.js already treats its absence as "do not
      // animate", so this is a note rather than a failure.
      missing.push('ResizeObserver — long lists will not scroll (Chrome 64+)');
    }

    return missing;
  }

  /* Things that make the board LOOK wrong rather than fail.
   *
   * Reported separately, because "your spacing will be tight" and "nothing
   * will ever draw" should not appear in the same list as if they were the
   * same kind of problem.
   */
  function cosmeticGaps() {
    var notes = [];
    try {
      var probe = document.createElement('div');
      probe.style.display = 'flex';
      probe.style.gap = '1px';
      if (probe.style.gap !== '1px') {
        notes.push('flexbox gap (Chrome 84+) — blocks will look cramped');
      }
    } catch (e) { /* nothing to report */ }
    return notes;
  }

  /* --------------------------------------------------- showing the failure */

  var shown = false;
  var overlay = null;

  function show(title, detail) {
    if (shown) return;
    shown = true;
    try {
      var engine = 'unknown';
      var match = / Chrome\/(\d+)/.exec(navigator.userAgent || '');
      if (match) engine = 'Chrome/WebView ' + match[1];

      var box = document.createElement('div');
      box.setAttribute('style', [
        'position:fixed', 'inset:0', 'left:0', 'top:0', 'right:0', 'bottom:0',
        'z-index:99999', 'background:#12151b', 'color:#e8eaed',
        'font:16px/1.5 system-ui,-apple-system,sans-serif',
        'padding:6vmin', 'overflow:auto', 'white-space:pre-wrap',
      ].join(';'));

      var heading = document.createElement('div');
      heading.setAttribute('style',
        'font-size:5vmin;color:#d98b8b;margin-bottom:2vmin');
      heading.textContent = title;

      var body = document.createElement('div');
      body.setAttribute('style', 'font-size:2.4vmin;color:#c9ced8');
      body.textContent = detail;

      var foot = document.createElement('div');
      foot.setAttribute('style',
        'font-size:2.2vmin;color:#8b93a1;margin-top:3vmin');
      foot.textContent = 'Browser engine: ' + engine
        + '\nThe board is still running — open its admin page from a computer '
        + 'on the same network to change anything.';

      box.appendChild(heading);
      box.appendChild(body);
      box.appendChild(foot);
      (document.body || document.documentElement).appendChild(box);
      overlay = box;
    } catch (nested) {
      // Last resort: if even this fails, at least stop the screen being black.
      try {
        document.documentElement.style.background = '#12151b';
        document.documentElement.textContent = title + '\n\n' + detail;
      } catch (ignored) { /* nothing left to try */ }
    }
  }

  // Anything thrown anywhere, including inside a module that failed to parse.
  window.addEventListener('error', function (event) {
    var where = event.filename
      ? ' (' + String(event.filename).split('/').pop() + ':' + event.lineno + ')'
      : '';
    show('The board hit an error', String(event.message || 'unknown') + where);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    show('The board hit an error',
      String((reason && (reason.stack || reason.message)) || reason));
  });

  /* A page that loaded but never painted.
   *
   * The failure this file exists for does not always throw: a module that
   * fails to PARSE is reported to window.onerror by some engines and silently
   * skipped by others. So the backstop is the symptom itself - after a few
   * seconds, is there anything on screen?
   *
   * WHICH ROOT depends on the page, and getting that wrong is not a small
   * bug: the first version looked only for the renderer's #board, so on the
   * ADMIN - which renders into #app - it concluded nothing had painted every
   * single time and covered a working page with an error. A diagnostic that
   * fires on healthy pages trains people to ignore it, which is worse than
   * not having one.
   */
  function paintedSomething() {
    var roots = ['board', 'app'];
    for (var i = 0; i < roots.length; i++) {
      var node = document.getElementById(roots[i]);
      if (node && node.children && node.children.length > 0) return true;
    }
    return false;
  }

  /* Find out WHY nothing painted, rather than guessing at it.
   *
   * "A script was blocked or a file failed to load" is a shrug. Importing the
   * entry point by hand and reporting whatever comes back turns it into the
   * actual error - a 404, a MIME type the engine refused, a syntax error with
   * a file and a line. That is the difference between a message somebody can
   * act on and one they can only forward.
   */
  function diagnose(entry, done) {
    var url = entry;
    // Plain fetch first: a 404 or a wrong content type is by far the most
    // likely cause and gives a much clearer answer than an import failure.
    try {
      fetch(url, { cache: 'no-store' }).then(function (resp) {
        if (!resp.ok) {
          done('The board could not load ' + url + ' — the server answered '
               + resp.status + ' ' + resp.statusText + '.');
          return;
        }
        var type = resp.headers.get('content-type') || '(none)';
        if (type.indexOf('javascript') === -1) {
          done('The board loaded ' + url + ' but the server called it "'
               + type + '" instead of JavaScript, so the browser refused to '
               + 'run it.');
          return;
        }
        // It is there and it is JavaScript, so let the engine try it and
        // report whatever it objects to.
        var probe = document.createElement('script');
        probe.type = 'module';
        probe.textContent = 'import ' + JSON.stringify(url) + ';';
        window.addEventListener('error', function once(event) {
          window.removeEventListener('error', once);
          done('Loading the board failed: ' + (event.message || 'unknown')
               + (event.filename ? '\n  in ' + event.filename
                  + ' line ' + event.lineno : ''));
        });
        document.head.appendChild(probe);
        setTimeout(function () {
          done('The board\u2019s files loaded and the browser reported no '
               + 'error, but nothing was drawn.');
        }, 2500);
      }).catch(function (err) {
        done('The board could not reach ' + url + ' — ' + err.message);
      });
    } catch (err) {
      done('Could not test the board\u2019s files: ' + err.message);
    }
  }

  /* HOW LONG TO WAIT BEFORE CALLING A PAGE BROKEN.
   *
   * The first version asked once, six seconds after load, and accused the page
   * if the answer was no. Six seconds is generous for the board, which renders
   * from one call over loopback, and not always enough for the ADMIN, which
   * makes several calls across the network before it draws its first row. So
   * opening the admin from a laptop covered a perfectly healthy page with "the
   * board loaded but drew nothing" - the exact false alarm the #app fix above
   * was meant to end, arriving by a different route.
   *
   * Polling removes the race rather than trading one arbitrary deadline for a
   * larger one. A slow page paints, the interval stops, and the question is
   * never asked. A genuinely broken page never paints and is still diagnosed,
   * just later - and late is the right bias here, because nobody is helped by
   * an error that beats the content it is complaining about.
   */
  var GIVE_UP_AT = 25000;
  var ENGINE_CHECK_AT = 6000;

  window.addEventListener('load', function () {
    var started = Date.now();

    /* A missing built-in is the engine's answer, not the network's. No amount
     * of waiting will conjure Promise.allSettled into Chrome 66, so that one
     * is worth saying early instead of making somebody watch a black screen
     * for another twenty seconds to be told something already knowable.
     */
    setTimeout(function () {
      if (paintedSomething() || shown) return;
      var missing = missingFeatures();
      if (!missing.length) return;
      show('This screen\u2019s browser is too old',
        'The board needs these, and this engine does not have them:\n  \u2022 '
        + missing.join('\n  \u2022 ')
        + '\n\nOn Android, updating "Android System WebView" fixes it \u2014 '
        + 'but on a TV box with no app store, tell whoever builds the board '
        + 'which engine version this is and it can be built to suit.');
    }, ENGINE_CHECK_AT);

    var poll = setInterval(function () {
      if (paintedSomething() || shown) { clearInterval(poll); return; }
      if (Date.now() - started < GIVE_UP_AT) return;
      clearInterval(poll);

      // Already reported by the engine check above; do not say it twice.
      if (missingFeatures().length) return;

      var entry = document.getElementById('board') ? './app.js' : './admin.js';
      var cosmetic = cosmeticGaps();
      diagnose(entry, function (reason) {
        // Diagnosing takes a few seconds of its own - it re-fetches the entry
        // point and waits on a probe script - and a page that was one slow
        // call from finishing will often have finished during it. Ask again
        // before speaking.
        if (paintedSomething() || shown) return;
        show('The board loaded but drew nothing',
          reason + (cosmetic.length
            ? '\n\nAlso worth knowing:\n  \u2022 ' + cosmetic.join('\n  \u2022 ')
            : ''));
      });
    }, 300);

    /* And if it paints anyway, get out of the way.
     *
     * A page that draws itself after the overlay went up is, by definition,
     * working. Leaving an error sitting on top of it until somebody thinks to
     * reload is worse than never having shown it. This also covers the board
     * on a cold boot, where the network comes up minutes after the browser.
     */
    var watch = setInterval(function () {
      if (!paintedSomething()) return;
      clearInterval(watch);
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
        overlay = null;
        shown = false;
      }
    }, 1000);
    setTimeout(function () { clearInterval(watch); }, 5 * 60 * 1000);
  });
})();
