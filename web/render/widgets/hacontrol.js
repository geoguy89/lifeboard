/* Interactive Home Assistant controls.
 *
 * This is the widget that turns a board you watch into one you use: lights and
 * switches toggle, scenes and scripts run, a thermostat's setpoint nudges up
 * and down, a light dims.
 *
 * Three rules, all learned from touch dashboards that feel broken:
 *
 *  1. **Optimistic, then reconciled.** A tap flips the control immediately and
 *     the server's answer settles it afterwards. Waiting for a round trip
 *     before anything moves makes a wall display feel dead.
 *  2. **A refusal must be visible.** If the call fails, the control snaps back
 *     and says why. Silently reverting looks like the screen ignored you.
 *  3. **Nothing polls over a press.** A refresh landing mid-tap must not undo
 *     the optimistic state, so updates are suppressed briefly after an action.
 */

import { el, idList } from '../app.js';

/* How long to ignore incoming state after a tap. HA needs a moment to act and
 * report back; without this the poll that lands 200ms later shows the OLD
 * state and the control visibly flips back and forth. */
const SETTLE_MS = 4000;

const DOMAIN_ICON = {
  light: '💡', switch: '🔌', fan: '🌀', lock: '🔒', cover: '🪟',
  climate: '🌡️', scene: '🎬', script: '📜', automation: '⚙️',
  media_player: '🔊', input_boolean: '🎚️', button: '⏺️', input_button: '⏺️',
  humidifier: '💧', siren: '🚨',
};

export const ha_control = {
  panelled: true,
  mount(ctx) {
    const { config, widget } = ctx;
    const ids = idList(config.entity_ids);

    if (!config.source_id || !ids.length) {
      ctx.body.append(el('div', { style: { color: '#9aa0a8' } },
        'Pick a Home Assistant source and the entities to control'));
      return;
    }

    let entities = [];
    const settling = new Map();      // entity_id -> timestamp until which polls are ignored

    const send = async (entity, action, value) => {
      settling.set(entity.entity_id, Date.now() + SETTLE_MS);
      try {
        const resp = await fetch('/api/ha/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widget_id: widget.id, entity_id: entity.entity_id, action, value,
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.detail || body.error || 'could not send that');
        // Settle on what HA actually reports rather than the guess.
        if (body.entity) {
          Object.assign(entity, body.entity, {
            is_on: ON_STATES.has(String(body.entity.state).toLowerCase()),
          });
        }
        ctx.clearFail();
      } catch (err) {
        ctx.fail(err);
        await load(true);            // put the real state back on screen
      } finally {
        settling.delete(entity.entity_id);
        draw();
      }
    };

    const ON_STATES = new Set(['on', 'open', 'unlocked', 'playing', 'home',
                               'heat', 'cool', 'heat_cool', 'auto']);

    const row = (entity) => {
      const icon = entity.attributes?.icon
        ? null
        : (DOMAIN_ICON[entity.domain] || '•');

      const label = el('div', {
        style: {
          flex: '1 1 auto', minWidth: '0', fontSize: `${config.size || 1.8}vmin`,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, entity.name);

      let action = null;

      if (entity.control === 'toggle') {
        // A pill switch. Big enough to hit with a thumb on a wall.
        const knob = el('div', {
          style: {
            width: '2vmin', height: '2vmin', borderRadius: '50%',
            background: '#fff', transition: 'transform .18s ease',
            transform: entity.is_on ? 'translateX(2.1vmin)' : 'translateX(0)',
          },
        });
        action = el('div', {
          style: {
            width: '4.6vmin', height: '2.4vmin', flex: '0 0 auto',
            borderRadius: '1.2vmin', padding: '.2vmin',
            background: entity.is_on ? (config.on_colour || '#7fb069')
                                     : 'rgba(255,255,255,.16)',
            cursor: 'pointer', transition: 'background .18s ease',
            display: 'flex', alignItems: 'center',
          },
          onclick: () => {
            entity.is_on = !entity.is_on;      // optimistic
            draw();
            send(entity, 'toggle');
          },
        }, knob);

      } else if (entity.control === 'run') {
        action = el('div', {
          style: {
            flex: '0 0 auto', padding: '.35vmin 1.1vmin', borderRadius: '6px',
            background: 'rgba(255,255,255,.12)', cursor: 'pointer',
            fontSize: '1.4vmin',
          },
          onclick: (e) => {
            e.currentTarget.textContent = '…';
            send(entity, 'run').then(() => { e.currentTarget.textContent = 'Run'; });
          },
        }, 'Run');

      } else {
        // Not controllable - show the reading, so a mixed list still works.
        action = el('div', {
          style: { flex: '0 0 auto', fontSize: '1.6vmin', color: '#9aa0a8' },
        }, `${entity.state}${entity.unit ? ' ' + entity.unit : ''}`);
      }

      const parts = [
        icon ? el('span', { style: { fontSize: '1.8vmin', flex: '0 0 auto' } }, icon) : null,
        label,
      ];

      // A thermostat gets its setpoint inline, because walking to the wall to
      // nudge the heat is the whole point of putting it on the board.
      if (entity.domain === 'climate' && config.show_setpoint !== false) {
        const target = Number(entity.attributes?.temperature);
        const current = entity.attributes?.current_temperature;
        parts.push(el('div', {
          style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '.5vmin' },
        },
          el('div', {
            style: { cursor: 'pointer', padding: '0 .6vmin', fontSize: '2vmin' },
            onclick: () => send(entity, 'set_temperature', (target || 20) - 1),
          }, '−'),
          el('div', { style: { fontSize: '1.9vmin', minWidth: '4ch', textAlign: 'center' } },
            Number.isFinite(target) ? `${Math.round(target)}°` : '--'),
          el('div', {
            style: { cursor: 'pointer', padding: '0 .6vmin', fontSize: '2vmin' },
            onclick: () => send(entity, 'set_temperature', (target || 20) + 1),
          }, '+'),
          current != null
            ? el('div', { style: { fontSize: '1.3vmin', color: '#9aa0a8' } },
                `now ${Math.round(current)}°`)
            : null,
        ));
      }

      parts.push(action);

      return el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '.8vmin',
          padding: '.25vmin 0', minWidth: '0',
        },
      }, ...parts);
    };

    const draw = () => {
      const wrap = el('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          gap: '.4vmin', overflow: 'hidden',
          justifyContent: config.centre ? 'center' : 'flex-start',
        },
      });
      for (const entity of entities) wrap.append(row(entity));
      if (!entities.length) {
        wrap.append(el('div', { style: { color: '#9aa0a8', fontSize: '1.5vmin' } },
          'None of those entities were found'));
      }
      ctx.body.replaceChildren(wrap);
    };

    const load = async (force = false) => {
      try {
        const data = await ctx.getJSON(
          `/api/data/ha/controls?source_id=${config.source_id}`
          + `&entities=${encodeURIComponent(ids.join(','))}`);
        const now = Date.now();
        const incoming = data.entities || [];

        if (!force) {
          // Keep the optimistic state for anything still settling, so a poll
          // landing right after a tap does not visibly undo it.
          for (const entity of incoming) {
            const until = settling.get(entity.entity_id);
            if (until && now < until) {
              const previous = entities.find((e) => e.entity_id === entity.entity_id);
              if (previous) entity.is_on = previous.is_on;
            }
          }
        }
        entities = incoming;
        ctx.clearFail();
        draw();
      } catch (err) {
        ctx.fail(err, load);
      }
    };

    load();
    ctx.interval(load, Math.max(5, Number(config.refresh_seconds || 15)) * 1000);
  },
};
