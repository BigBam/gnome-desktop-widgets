import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---- Settings -------------------------------------------------------------
// Time zone names: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
const ZONES = [
    {name: 'Los Angeles', tz: 'America/Los_Angeles'},
    {name: 'London', tz: 'Europe/London'},
    {name: 'Tokyo', tz: 'Asia/Tokyo'},
    {name: 'Sydney', tz: 'Australia/Sydney'},
];
const HOURS_24 = false;         // true: 14:05, false: 2:05 PM
const WIDTH = 280;              // card width in px
const GAP = 16;                 // space between this card and its neighbours
const MARGIN = 24;              // distance from the screen edge
const TITLE = 'World Clock';
// ---------------------------------------------------------------------------

// The other cards in this collection, and the ones we try to sit next to.
const TOP = 'desktop-top-widget';
const WEATHER = 'weather-card';
const NEWS = 'news-card';

function dayWord(there, here) {
    const d = there.get_year() * 400 + there.get_day_of_year() -
              (here.get_year() * 400 + here.get_day_of_year());
    return d === 0 ? 'Today' : d > 0 ? 'Tomorrow' : 'Yesterday';
}

function offsetWord(there, here) {
    const mins = Math.round((Number(there.get_utc_offset()) - Number(here.get_utc_offset())) / 60e6);
    if (mins === 0)
        return 'same time';
    const h = Math.trunc(Math.abs(mins) / 60), m = Math.abs(mins) % 60;
    return `${mins > 0 ? '+' : '−'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''} hrs`;
}

export default class DesktopWorldClockExtension extends Extension {
    enable() {
        this._watched = [];
        this._zones = ZONES.map(z => ({...z, tz: GLib.TimeZone.new_identifier(z.tz)}))
            .filter(z => {
                if (!z.tz)
                    console.warn(`desktop-world-clock-widget: unknown time zone for ${z.name}`);
                return !!z.tz;
            });

        this._card = new St.BoxLayout({
            style_class: 'clock-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            width: WIDTH,
        });
        this._card.add_child(new St.Label({text: TITLE, style_class: 'clock-header'}));

        this._rows = this._zones.map((z, i) => {
            if (i > 0)
                this._card.add_child(new St.Widget({style_class: 'clock-sep', x_expand: true}));
            const row = new St.BoxLayout({style_class: 'clock-row'});
            const names = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            names.add_child(new St.Label({text: z.name, style_class: 'clock-city'}));
            const sub = new St.Label({style_class: 'clock-sub'});
            names.add_child(sub);
            row.add_child(names);
            const time = new St.Label({style_class: 'clock-time', y_align: Clutter.ActorAlign.CENTER});
            row.add_child(time);
            this._card.add_child(row);
            return {row, sub, time};
        });

        // Same layer as the top and weather widgets: inside the wallpaper
        // group, which Mutter always keeps below every window.
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(this._card);
        this._bgChildId = bg.connect('child-added', (_g, child) => {
            if (child === this._card)
                return;
            bg.set_child_above_sibling(this._card, null);
            this._reposition();   // a neighbour may have just appeared
        });
        this._card.connect('notify::size', () => this._reposition());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._workareasId = global.display.connect('workareas-changed', () => this._reposition());

        this._update();
        this._reposition();
        // Neighbours finish laying out a moment after login; settle once more.
        this._settleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._settleId = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
        this._scheduleTick();
    }

    disable() {
        for (const id of ['_tickId', '_settleId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        if (this._bgChildId) {
            Main.layoutManager._backgroundGroup.disconnect(this._bgChildId);
            this._bgChildId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workareasId) {
            global.display.disconnect(this._workareasId);
            this._workareasId = 0;
        }
        this._unwatch();
        this._card?.destroy();
        this._card = null;
        this._rows = null;
        this._zones = null;
    }

    // ----- clock -----

    // Fire just after each minute boundary so the display never lags.
    _scheduleTick() {
        const secs = 60 - GLib.DateTime.new_now_local().get_second() + 0.05;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(secs * 1000), () => {
            this._update();
            this._scheduleTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const here = GLib.DateTime.new_now_local();
        const fmt = HOURS_24 ? '%H:%M' : '%-I:%M %p';
        this._zones.forEach((z, i) => {
            const there = GLib.DateTime.new_now(z.tz);
            const r = this._rows[i];
            r.time.text = there.format(fmt);
            r.sub.text = `${dayWord(there, here)}, ${offsetWord(there, here)}`;
            const hour = there.get_hour();
            if (hour < 7 || hour >= 22)
                r.row.add_style_class_name('clock-night');
            else
                r.row.remove_style_class_name('clock-night');
        });
    }

    // ----- placement -----
    // Try a few spots next to the other widgets and take the first one that
    // fits on screen without covering anything.

    _find(cls) {
        for (const group of [Main.layoutManager._backgroundGroup, global.window_group]) {
            const hit = group.get_children().find(c => c !== this._card && c.visible &&
                c.style_class?.split(' ').includes(cls));
            if (hit)
                return hit;
        }
        return null;
    }

    _watch(actors) {
        this._unwatch();
        for (const a of actors) {
            this._watched.push([a, [
                a.connect('notify::position', () => this._reposition()),
                a.connect('notify::size', () => this._reposition()),
                a.connect('destroy', () => {
                    this._watched = this._watched.filter(([w]) => w !== a);
                    this._reposition();
                }),
            ]]);
        }
    }

    _unwatch() {
        for (const [a, ids] of this._watched ?? [])
            ids.forEach(id => a.disconnect(id));
        this._watched = [];
    }

    _reposition() {
        if (!this._card || this._placing)
            return;
        const monitor = Main.layoutManager.primaryIndex;
        if (monitor < 0)
            return;
        this._placing = true;   // set_position below re-enters via notify::position

        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const [w, h] = this._card.get_size();
        const top = this._find(TOP), weather = this._find(WEATHER), news = this._find(NEWS);
        const others = [top, weather, news].filter(Boolean);
        this._watch(others);

        const right = a => a.x + a.width, bottom = a => a.y + a.height;
        const candidates = [];
        if (weather) {
            candidates.push([weather.x - GAP - w, weather.y]);            // left of weather
            candidates.push([right(weather) - w, bottom(weather) + GAP]); // below weather
        }
        if (top)
            candidates.push([right(top) - w, bottom(top) + GAP]);         // below top
        if (news)
            candidates.push([news.x, bottom(news) + GAP]);                // below news
        candidates.push([area.x + area.width - w - MARGIN, area.y + MARGIN]);  // corner
        candidates.push([area.x + MARGIN, area.y + MARGIN]);

        const fits = ([x, y]) =>
            x >= area.x && y >= area.y &&
            x + w <= area.x + area.width && y + h <= area.y + area.height &&
            !others.some(o => x < right(o) + GAP / 2 && x + w > o.x - GAP / 2 &&
                              y < bottom(o) + GAP / 2 && y + h > o.y - GAP / 2);

        const [x, y] = candidates.find(fits) ?? candidates[0];
        this._card.set_position(Math.round(x), Math.round(y));
        this._placing = false;
    }
}
