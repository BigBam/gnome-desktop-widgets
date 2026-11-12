import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---- Settings -------------------------------------------------------------
// Weather from Open-Meteo (https://open-meteo.com): free, no account or key.
const CITIES = [
    {name: 'New York', lat: 40.7128, lon: -74.0060},
    {name: 'Providence', lat: 41.8240, lon: -71.4128},
    {name: 'Atlanta', lat: 33.7490, lon: -84.3880},
];
const UNITS = 'fahrenheit';     // 'fahrenheit' | 'celsius'
const REFRESH_MINUTES = 15;     // how often to fetch new weather
const WIDTH = 280;              // card width in px
const GAP = 16;                 // space between this card and the top widget
const MARGIN = 24;              // distance from the screen edge, if no top widget
const TITLE = 'Weather';
// ---------------------------------------------------------------------------

const USER_AGENT = 'desktop-weather-widget/1';
const PEER_CLASS = 'desktop-top-widget';

// WMO weather codes -> [description, day icon, night icon]
const CODES = {
    0: ['Clear', 'weather-clear', 'weather-clear-night'],
    1: ['Mostly clear', 'weather-few-clouds', 'weather-few-clouds-night'],
    2: ['Partly cloudy', 'weather-few-clouds', 'weather-few-clouds-night'],
    3: ['Cloudy', 'weather-overcast'],
    45: ['Fog', 'weather-fog'],
    48: ['Fog', 'weather-fog'],
    51: ['Light drizzle', 'weather-showers-scattered'],
    53: ['Drizzle', 'weather-showers-scattered'],
    55: ['Drizzle', 'weather-showers-scattered'],
    56: ['Freezing drizzle', 'weather-showers-scattered'],
    57: ['Freezing drizzle', 'weather-showers-scattered'],
    61: ['Light rain', 'weather-showers-scattered'],
    63: ['Rain', 'weather-showers'],
    65: ['Heavy rain', 'weather-showers'],
    66: ['Freezing rain', 'weather-showers'],
    67: ['Freezing rain', 'weather-showers'],
    71: ['Light snow', 'weather-snow'],
    73: ['Snow', 'weather-snow'],
    75: ['Heavy snow', 'weather-snow'],
    77: ['Snow grains', 'weather-snow'],
    80: ['Showers', 'weather-showers-scattered'],
    81: ['Showers', 'weather-showers'],
    82: ['Heavy showers', 'weather-showers'],
    85: ['Snow showers', 'weather-snow'],
    86: ['Snow showers', 'weather-snow'],
    95: ['Thunderstorm', 'weather-storm'],
    96: ['Thunderstorm', 'weather-storm'],
    99: ['Thunderstorm', 'weather-storm'],
};

function describe(code, isDay) {
    const [text, day, night] = CODES[code] ?? ['—', 'weather-severe-alert'];
    return {text, icon: `${isDay || !night ? day : night}-symbolic`};
}

const deg = t => `${Math.round(t)}°`;

function apiUrl() {
    const q = [
        `latitude=${CITIES.map(c => c.lat).join(',')}`,
        `longitude=${CITIES.map(c => c.lon).join(',')}`,
        'current=temperature_2m,weather_code,is_day',
        'daily=temperature_2m_max,temperature_2m_min',
        `temperature_unit=${UNITS}`,
        'timezone=auto',
        'forecast_days=1',
    ];
    return `https://api.open-meteo.com/v1/forecast?${q.join('&')}`;
}

export default class DesktopWeatherWidgetExtension extends Extension {
    enable() {
        this._session = new Soup.Session({timeout: 20, user_agent: USER_AGENT});
        this._cancellable = new Gio.Cancellable();
        this._peer = null;
        this._peerIds = [];

        this._card = new St.BoxLayout({
            style_class: 'weather-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            width: WIDTH,
        });

        const header = new St.BoxLayout({style_class: 'weather-header-box'});
        header.add_child(new St.Label({text: TITLE, style_class: 'weather-header',
            y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(new St.Widget({x_expand: true}));
        this._updated = new St.Label({text: '', style_class: 'weather-updated',
            y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._updated);
        this._card.add_child(header);

        this._body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._card.add_child(this._body);
        this._showStatus('Loading weather…');

        // Live inside the wallpaper group, like the top widget: Mutter keeps
        // every window above this group, so the card stays behind them.
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(this._card);
        this._bgChildId = bg.connect('child-added', (_g, child) => {
            if (child === this._card)
                return;
            // New wallpaper actors land on top; lift the card back above them.
            bg.set_child_above_sibling(this._card, null);
            this._reposition();   // the top widget may have just appeared
        });

        this._card.connect('notify::size', () => this._reposition());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._workareasId = global.display.connect('workareas-changed', () => this._reposition());
        this._reposition();

        this._refresh();
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            REFRESH_MINUTES * 60, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;

        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
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
        this._unwatchPeer();

        this._card?.destroy();
        this._card = null;
        this._body = null;
        this._updated = null;
    }

    // ----- placement: under the top widget, right edges lined up -----

    _findPeer() {
        return Main.layoutManager._backgroundGroup.get_children()
            .find(c => c.style_class === PEER_CLASS) ?? null;
    }

    _watchPeer(peer) {
        if (peer === this._peer)
            return;
        this._unwatchPeer();
        if (!peer)
            return;
        this._peer = peer;
        this._peerIds = [
            peer.connect('notify::position', () => this._reposition()),
            peer.connect('notify::size', () => this._reposition()),
            peer.connect('destroy', () => {
                this._peer = null;
                this._peerIds = [];
                this._reposition();
            }),
        ];
    }

    _unwatchPeer() {
        if (this._peer) {
            for (const id of this._peerIds)
                this._peer.disconnect(id);
        }
        this._peer = null;
        this._peerIds = [];
    }

    _reposition() {
        if (!this._card)
            return;
        const monitor = Main.layoutManager.primaryIndex;
        if (monitor < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const [w] = this._card.get_size();

        this._watchPeer(this._findPeer());

        let x, y;
        if (this._peer) {
            x = this._peer.x + this._peer.width - w;
            y = this._peer.y + this._peer.height + GAP;
        } else {
            x = area.x + area.width - w - MARGIN;
            y = area.y + MARGIN;
        }
        this._card.set_position(Math.round(x), Math.round(y));
    }

    // ----- data -----

    _fetchJson(url) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        if (msg.get_status() !== Soup.Status.OK)
                            throw new Error(`HTTP ${msg.get_status()}`);
                        resolve(JSON.parse(new TextDecoder().decode(bytes.toArray())));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _refresh() {
        try {
            let data = await this._fetchJson(apiUrl());
            if (!this._card)
                return;
            if (!Array.isArray(data))
                data = [data];   // the API returns a plain object for one city
            this._render(data);
            this._updated.text = GLib.DateTime.new_now_local().format('%-I:%M %p');
        } catch (e) {
            if (this._cancellable?.is_cancelled())
                return;
            console.warn(`desktop-weather-widget: ${e.message}`);
            if (!this._hasData)
                this._showStatus('Couldn’t load weather. Retrying soon.');
        }
    }

    // ----- UI -----

    _showStatus(text) {
        this._body.destroy_all_children();
        this._body.add_child(new St.Label({text, style_class: 'weather-status'}));
    }

    _render(data) {
        this._body.destroy_all_children();
        CITIES.forEach((city, i) => {
            const d = data[i];
            if (!d?.current)
                return;
            if (i > 0)
                this._body.add_child(new St.Widget({style_class: 'weather-sep', x_expand: true}));

            const {text, icon} = describe(d.current.weather_code, d.current.is_day);
            const row = new St.BoxLayout({style_class: 'weather-row'});

            row.add_child(new St.Icon({icon_name: icon, style_class: 'weather-icon',
                y_align: Clutter.ActorAlign.CENTER}));

            const names = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            names.add_child(new St.Label({text: city.name, style_class: 'weather-city'}));
            names.add_child(new St.Label({text, style_class: 'weather-cond'}));
            row.add_child(names);

            const temps = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                y_align: Clutter.ActorAlign.CENTER});
            temps.add_child(new St.Label({text: deg(d.current.temperature_2m),
                style_class: 'weather-temp', x_align: Clutter.ActorAlign.END}));
            const hi = d.daily?.temperature_2m_max?.[0];
            const lo = d.daily?.temperature_2m_min?.[0];
            if (hi != null && lo != null) {
                temps.add_child(new St.Label({text: `H ${deg(hi)}  L ${deg(lo)}`,
                    style_class: 'weather-hilo', x_align: Clutter.ActorAlign.END}));
            }
            row.add_child(temps);

            this._body.add_child(row);
        });
        this._hasData = true;
    }
}
