/* Home Assistant widgets: entity metrics, and people tracking.
 *
 * Both poll the LifeBoard server, which polls HA. The renderer never holds the
 * HA token. Polling rather than HA's websocket is a deliberate call for an
 * appliance: a websocket that silently dies after a HA restart is the classic
 * "dashboard was fine yesterday" bug, and a 15-second poll is indistinguishable
 * on a wall display while being trivially self-healing.
 */

import { el, idList } from '../app.js';

/* The ringing pulse. Added once, on demand - a board with no presence chip
 * should not carry a stylesheet for one. */
const CHIP_STYLE_ID = 'lb-presence-anim';

function ensureChipStyle() {
  if (document.getElementById(CHIP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CHIP_STYLE_ID;
  style.textContent = `
    @keyframes lb-phone-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: .35; }
    }
    @media (prefers-reduced-motion: reduce) {
      [style*="lb-phone-pulse"] { animation: none !important; }
    }
  `;
  document.head.append(style);
}

/* Entities go stale in a specific, dangerous way: HA restarts, an integration
 * drops out, and the last known value sits there looking current. Anything
 * older than this wears a marker so a frozen number is visibly frozen. */
const STALE_AFTER_MS = 30 * 60 * 1000;

function isStale(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > STALE_AFTER_MS;
}

function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** HA reports numbers as strings; format them without mangling text states. */
function formatState(entity, decimals) {
  const raw = entity.state;
  if (raw === 'unavailable' || raw === 'unknown' || raw == null) return '--';
  const num = Number(raw);
  if (Number.isNaN(num)) {
    // A text state like 'home' or 'playing' - title-case it for display.
    return String(raw).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const places = decimals == null ? (Math.abs(num) >= 100 ? 0 : 1) : Number(decimals);
  return num.toFixed(places).replace(/\.0+$/, '');
}

export const entity = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    const ids = idList(config.entity_ids);
    if (!config.source_id || !ids.length) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } },
        'Pick a Home Assistant source and at least one entity'));
      return;
    }

    const columns = Number(config.columns || (ids.length > 2 ? 2 : 1));

    const draw = (data) => {
      const grid = el('div', {
        style: {
          display: 'grid', height: '100%',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: '1vmin', alignContent: 'center',
        },
      });

      for (const item of data.entities || []) {
        const stale = isStale(item.last_changed);
        grid.append(el('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '.2vmin', minWidth: '0' },
        },
          el('div', {
            style: {
              fontSize: '1.4vmin', color: '#9aa0a8',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, config.show_names === false ? '' : item.name),
          el('div', {
            style: {
              display: 'flex', alignItems: 'baseline', gap: '.4vmin',
              opacity: stale ? '.55' : '1',
            },
          },
            el('span', { style: { fontSize: `${config.size || 3.6}vmin`, fontWeight: '300' } },
              formatState(item, config.decimals)),
            item.unit
              ? el('span', { style: { fontSize: '1.6vmin', color: '#9aa0a8' } }, item.unit)
              : null,
          ),
          stale
            ? el('div', { style: { fontSize: '1.1vmin', color: '#d9a06b' } },
                `stale · ${relativeTime(item.last_changed)}`)
            : null,
        ));
      }

      // Name what is missing instead of leaving a hole. A renamed entity in HA
      // is the most common cause of a tile quietly disappearing.
      for (const missing of data.missing || []) {
        grid.append(el('div', { style: { fontSize: '1.3vmin', color: '#d98b8b' } },
          `${missing} not found`));
      }

      ctx.body.replaceChildren(grid);
    };

    const load = async () => {
      try {
        draw(await ctx.getJSON(
          `/api/data/ha/states?source_id=${config.source_id}&entities=${encodeURIComponent(ids.join(','))}`
        ));
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);      // keep the last values on screen
      }
    };

    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_seconds || 15)) * 1000);
  },
};

export const tracker = {
  panelled: true,
  mount(ctx) {
    const { config } = ctx;
    if (!config.source_id) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } },
        'Pick a Home Assistant source'));
      return;
    }

    const ids = idList(config.entity_ids);

    const draw = (data) => {
      const wrap = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '.9vmin',
                 height: '100%', overflow: 'hidden' },
      });

      const people = data.people || [];
      if (!people.length) {
        wrap.append(el('div', { style: { color: '#9aa0a8', fontSize: '1.6vmin' } },
          'No people found in Home Assistant'));
      }

      for (const person of people) {
        const home = person.raw_state === 'home';
        wrap.append(el('div', {
          style: { display: 'flex', alignItems: 'center', gap: '1vmin', minWidth: '0' },
        },
          // Avatar if HA has one, otherwise initials - avoids a broken-image
          // box for people with no picture set.
          person.picture
            ? el('div', {
                style: {
                  width: '4.2vmin', height: '4.2vmin', borderRadius: '50%',
                  backgroundImage: `url("${person.picture}")`,
                  backgroundSize: 'cover', backgroundPosition: 'center',
                  flex: '0 0 auto',
                },
              })
            : el('div', {
                style: {
                  width: '4.2vmin', height: '4.2vmin', borderRadius: '50%',
                  background: 'rgba(255,255,255,.10)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.7vmin', flex: '0 0 auto',
                },
              }, (person.name || '?').slice(0, 1).toUpperCase()),

          el('div', { style: { flex: '1 1 auto', minWidth: '0' } },
            el('div', {
              style: { fontSize: '1.9vmin', overflow: 'hidden',
                       textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, person.name),
            el('div', {
              style: {
                fontSize: '1.4vmin',
                color: home ? '#7fb069' : '#9aa0a8',
              },
            },
              person.zone,
              config.show_updated !== false && person.last_changed
                ? ` · ${relativeTime(person.last_changed)}`
                : '',
            ),
          ),

          config.show_battery !== false && person.battery != null
            ? el('div', {
                style: {
                  fontSize: '1.4vmin', flex: '0 0 auto',
                  color: person.battery < 20 ? '#d98b8b' : '#9aa0a8',
                },
              }, `${person.battery}%`)
            : null,
        ));
      }
      ctx.body.replaceChildren(wrap);
    };

    /* Chips, matching the vault's home page exactly.
     *
     * Rebuilt from Home.md and vault-3.0.css rather than approximated, so the
     * two surfaces show the same object rather than two versions of it.
     *
     * Everything is expressed through one scale so the whole chip resizes
     * coherently: the numbers are the CSS pixel values, divided through by a
     * reference so they land as vmin on a portrait board. */
    const CHIP = {
      // Home and a named zone share a colour: both mean "somewhere known",
      // and orange then means "out and about" on its own. Two states read
      // faster from across a room than three.
      home: config.home_colour || '#60a5fa',
      zone: config.home_colour || '#60a5fa',
      away: config.away_colour || '#fb923c',
      battOk: '#4ade80', battLow: '#fb923c', battCrit: '#ef4444',
      phoneIdle: '#66bb6a', phoneRing: '#ffa726', phoneCall: '#ef5350',
    };

    const PHONE_LABEL = { idle: 'Idle', ring: 'Ringing', call: 'On call' };

    /* Home Assistant returns the full name on a person entity - "Alex
     * Morgan" - while the board's chips say "Alex". A chip is a glance,
     * and a surname it never varies by is width spent on nothing. */
    const displayName = (name) => (
      config.short_names === false ? name : String(name || '').split(' ')[0]);

    /* Compact by necessity: this sits on the same line as the location, in a
     * chip about 400px wide that also carries an avatar and two stats.
     * "Updated 3h ago" is nine characters of chrome around two of
     * information, and it was those nine that pushed the line over the
     * battery column. Next to a location, "3h" is unambiguous. */
    const relTime = (iso) => {
      const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
      if (mins < 1) return 'now';
      if (mins < 60) return `${mins}m`;
      if (mins < 1440) return `${Math.round(mins / 60)}h`;
      return `${Math.round(mins / 1440)}d`;
    };

    /* Everything is a multiple of --u, and --u is resolved by the browser
     * from the container's own size.
     *
     * The previous version measured the block in JavaScript and redrew from a
     * ResizeObserver, which made the result depend on when the measurement
     * happened: zero before layout, and the observer firing on a redraw it had
     * itself caused. Container query units are computed at layout, every time,
     * with no ordering to get wrong.
     *
     * The multipliers are the vault's own, measured against its 36px avatar:
     * battery 15x9, phone 11x11, dot 7, text 0.82/0.72/0.66em of a 16px base.
     */
    const M = {
      avatar: 1, ring: 0.055, dot: 0.19,
      name: 0.36, loc: 0.32, locBig: 0.36, stat: 0.29,
      battW: 0.42, battH: 0.25, phone: 0.31,
      gap: 0.28, padY: 0.17, padR: 0.39, padL: 0.19, extraGap: 0.08,
    };
    const u = (multiple) => `calc(var(--u) * ${multiple})`;

    const batterySvg = (level, colour) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 22 12');
      svg.setAttribute('fill', 'none');
      svg.style.width = u(M.battW);
      svg.style.height = u(M.battH);
      svg.style.flex = '0 0 auto';
      svg.style.color = colour;
      const fill = Math.round(14 * Math.max(0, Math.min(100, level)) / 100);
      svg.innerHTML =
        '<rect x="0.5" y="0.5" width="18" height="11" rx="2.5" fill="none"'
        + ' stroke="currentColor" stroke-width="1.4"/>'
        + '<rect x="19.5" y="3.5" width="2.5" height="5" rx="1" fill="currentColor"/>'
        + `<rect x="2.5" y="2.5" width="${fill}" height="7" rx="1" fill="currentColor"/>`;
      return svg;
    };

    const phoneSvg = (colour, pulse) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.width = u(M.phone);
      svg.style.height = u(M.phone);
      svg.style.flex = '0 0 auto';
      svg.style.color = colour;
      svg.innerHTML =
        '<path fill="currentColor" d="M6.62 10.79c1.44 2.83 3.76 5.15 6.59 6.59l2.2-2.2c.27-.27.67-.36'
        + ' 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17'
        + ' 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>';
      // Ringing and on-call pulse. It is the one presence fact worth
      // interrupting somebody for, so it moves and nothing else does.
      if (pulse) svg.style.animation = 'lb-phone-pulse 1.4s ease-in-out infinite';
      return svg;
    };

    ensureChipStyle();

    const drawChips = (data) => {
      const people = data.people || [];

      /* The size, in one place.
       *
       * 62cqh fills the block's height allowing for the pill's padding;
       * 30cqw stops a chip outgrowing a narrow block, where height alone
       * would give an avatar wider than the text beside it. `min()` takes
       * whichever binds. The percentage is the user's, applied to both.
       */
      /* Read the stored size, tolerating values written under the old meaning.
       *
       * This field used to hold a vmin measurement - 4 meant "4vmin", about
       * 43px. It now holds a PERCENTAGE, so a board saved before that change
       * reads 4 as four percent and renders a three-pixel avatar. Changing
       * what a stored value means without migrating the values already saved
       * is my mistake; this is the migration.
       *
       * Anything under 20 cannot be a percentage anyone wanted - a fifth of
       * the fit is already unreadable - so it is treated as an old value and
       * ignored in favour of the default.
       */
      const stored = Number(config.chip_size);
      const scale = Number.isFinite(stored) && stored >= 20 ? stored / 100 : 1;

      const bar = el('div', {
        style: {
          height: '100%', display: 'flex', flexWrap: 'wrap',
          gap: u(M.gap),
          justifyContent: config.centre === false ? 'flex-start' : 'center',
          alignContent: config.centre === false ? 'flex-start' : 'center',
          overflow: 'hidden',
        },
      });
      bar.style.setProperty('--u', `calc(min(62cqh, 30cqw) * ${scale})`);

      const fitting = [];

      for (const person of people) {
        const kind = person.kind || (person.home ? 'home' : 'away');
        const dotColour = CHIP[kind] || CHIP.away;

        const avatarSrc = person.picture
          ? `/api/data/ha/avatar?source_id=${config.source_id}`
            + `&path=${encodeURIComponent(person.picture)}`
          : '';

        const avatar = avatarSrc
          ? el('img', {
              src: avatarSrc, alt: person.name,
              style: {
                width: u(M.avatar), height: u(M.avatar), borderRadius: '50%',
                objectFit: 'cover', flex: '0 0 auto',
                border: `${u(M.ring)} solid rgba(96,165,250,.40)`,
              },
            })
          : el('div', {
              style: {
                width: u(M.avatar), height: u(M.avatar), borderRadius: '50%',
                flex: '0 0 auto', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontWeight: '700', fontSize: u(M.name),
                background: 'rgba(96,165,250,.22)',
                border: `${u(M.ring)} solid rgba(96,165,250,.40)`,
              },
            }, (displayName(person.name) || '?').slice(0, 1).toUpperCase());

        /* The face identifies the person better than the name does, so with a
         * photograph the name is repetition - width taken from what actually
         * changes. Shown when there is no picture, because an unlabelled
         * initial is worse than a labelled one. */
        const nameShown = config.show_name === true
          || (config.show_name !== false && !avatarSrc);

        // Held so the line can be measured after it is in the document.
        let locLine = null;

        const stamp = config.show_updated !== false && person.last_changed
          ? el('span', {
              style: {
                color: 'rgba(232,234,240,.45)', fontWeight: '500',
                // The location is the fact; the timestamp is the footnote,
                // so the footnote is what gives way when space is short.
                overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0',
              },
            }, ` · ${relTime(person.last_changed)}`)
          : null;

        const info = el('div', {
          style: {
            display: 'flex', flexDirection: 'column', lineHeight: '1.25',
            // Shrinkable, so the battery and phone column keeps its width
            // instead of being written over.
            minWidth: '0', flex: '1 1 auto', overflow: 'hidden',
          },
        },
          nameShown ? el('div', {
            style: {
              fontSize: u(M.name), fontWeight: '700',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, displayName(person.name)) : null,
          (locLine = el('div', {
            style: {
              fontSize: u(nameShown ? M.loc : M.locBig),
              fontWeight: nameShown ? '600' : '700', color: dotColour,
              display: 'flex', alignItems: 'center', gap: u(0.11),
              // nowrap with nothing to stop it ran "Home · Updated 3h ago"
              // straight over the battery column. The line has to be allowed
              // to shrink, and to end in an ellipsis when it does.
              whiteSpace: 'nowrap', overflow: 'hidden',
              textOverflow: 'ellipsis', minWidth: '0',
            },
          },
            el('span', {
              style: {
                width: u(M.dot), height: u(M.dot),
                borderRadius: '50%', flex: '0 0 auto',
                background: dotColour,
                boxShadow: `0 0 ${u(0.17)} ${dotColour}88`,
              },
            }),
            person.location || person.zone,
            stamp)));

        const battery = person.battery;
        const phone = person.phone_state;
        const extras = [];

        if (config.show_battery !== false && battery != null) {
          const colour = battery <= 20 ? CHIP.battCrit
                       : battery <= 50 ? CHIP.battLow : CHIP.battOk;
          extras.push(el('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: u(0.14),
              fontSize: u(M.stat), fontWeight: '700', color: colour,
              lineHeight: '1',
            },
          }, batterySvg(battery, colour), el('span', {}, `${battery}%`)));
        }

        if (config.show_phone !== false && phone) {
          const colour = phone === 'call' ? CHIP.phoneCall
                       : phone === 'ring' ? CHIP.phoneRing : CHIP.phoneIdle;
          extras.push(el('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: u(0.14),
              fontSize: u(M.stat), fontWeight: '700', color: colour,
              lineHeight: '1',
            },
          }, phoneSvg(colour, phone !== 'idle'), el('span', {}, PHONE_LABEL[phone])));
        }

        // The chip is a pill, so frosting belongs on IT rather than on the
        // widget's rectangle - which is what the panel setting would frost.
        const frosted = config.chip_style === 'glass';
        bar.append(el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: u(M.gap),
            padding: `${u(M.padY)} ${u(M.padR)} ${u(M.padY)} ${u(M.padL)}`,
            borderRadius: '999px',
            minWidth: '0', maxWidth: '100%',
            ...(frosted
              ? {
                  background: 'linear-gradient(160deg,'
                    + ' rgba(255,255,255,.18) 0%,'
                    + ' rgba(255,255,255,.07) 40%,'
                    + ' rgba(10,12,18,.28) 100%)',
                  backdropFilter: 'blur(14px) saturate(135%)',
                  WebkitBackdropFilter: 'blur(14px) saturate(135%)',
                  border: '1px solid rgba(255,255,255,.30)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.50),'
                    + ' 0 3px 14px rgba(0,0,0,.28)',
                }
              : {
                  background: config.chip_style === 'none'
                    ? 'transparent' : 'rgba(255,255,255,.07)',
                  border: config.chip_style === 'none'
                    ? '1px solid transparent' : '1px solid rgba(255,255,255,.14)',
                }),
          },
        },
          avatar,
          info,
          extras.length
            ? el('div', {
                style: {
                  display: 'flex', flexDirection: 'column', gap: u(M.extraGap),
                  marginLeft: u(0.11), paddingLeft: u(M.gap),
                  borderLeft: '1px solid rgba(255,255,255,.14)',
                  flex: '0 0 auto', whiteSpace: 'nowrap',
                },
              }, ...extras)
            : null));

        // Remembered so the fitting pass below can measure this line once the
        // chip is actually in the document.
        fitting.push({
          line: locLine,
          stamp,
          base: nameShown ? M.loc : M.locBig,
        });
      }

      if (!people.length) {
        bar.append(el('div', { style: { color: '#9aa0a8', fontSize: '1.6vmin' } },
          'No people found in Home Assistant'));
      }

      /* Make long place names fit.
       *
       * "Home" is comfortable; "Old Orchard Beach" - what the town lookup
       * returns when somebody is out - is not, and an ellipsis would cut the
       * one thing on the chip anybody is reading.
       *
       * Measured once, after the chips are in the document. A single read is
       * safe; it was the continuous observer feeding its own redraws that
       * caused trouble before.
       */
      requestAnimationFrame(() => {
        for (const { line, stamp: footnote, base } of fitting) {
          if (!line || line.scrollWidth <= line.clientWidth) continue;

          // 1. The footnote goes first.
          if (footnote && footnote.parentNode) {
            footnote.remove();
            if (line.scrollWidth <= line.clientWidth) continue;
          }

          // 2. Then shrink, in steps, to a floor that is still readable from
          //    across a room. Below three quarters this trades one failure
          //    for another.
          for (const factor of [0.92, 0.84, 0.76]) {
            line.style.fontSize = `calc(var(--u) * ${base * factor})`;
            if (line.scrollWidth <= line.clientWidth) break;
          }
          // 3. Anything still too long keeps the ellipsis it already had.
        }
      });

      /* The container has to have a DEFINITE size.
       *
       * .widget-body is `flex: 1 1 auto`, so its height comes from flex
       * layout rather than from a value. `container-type: size` applies size
       * containment in both axes - the element is sized without regard to its
       * contents - so putting it on the body collapsed the height to nearly
       * nothing and took every cqh unit down with it. That is why the chips
       * came out microscopic.
       *
       * An absolutely positioned child filling a relative parent takes its
       * size from the containing block instead, which containment cannot
       * collapse. .widget-body is already position: relative.
       */
      const frame = el('div', {
        style: {
          position: 'absolute', inset: '0',
          containerType: 'size',
        },
      }, bar);

      ctx.body.replaceChildren(frame);
    };

    const render = (data) => (
      config.layout === 'chips' ? drawChips(data) : draw(data));

    // No ResizeObserver: cqh/cqw are resolved by the browser at layout, so
    // the chip follows its block without anything having to notice.
    let lastData = null;

    const load = async () => {
      try {
        const query = ids.length ? `&entities=${encodeURIComponent(ids.join(','))}` : '';
        lastData = await ctx.getJSON(
          `/api/data/ha/trackers?source_id=${config.source_id}${query}`);
        render(lastData);
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(10, Number(config.refresh_seconds || 30)) * 1000);
  },
};
