import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ---- Settings -------------------------------------------------------------
const REFRESH_SECONDS = 2;      // how often to sample traffic
const BITS = false;             // true: show Mb/s instead of MB/s
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

function fmtRate(bytesPerSec) {
    if (BITS) {
        const b = bytesPerSec * 8;
        if (b < 1e3) return `${b.toFixed(0)} b/s`;
        if (b < 1e6) return `${(b / 1e3).toFixed(0)} Kb/s`;
        if (b < 1e9) return `${(b / 1e6).toFixed(1)} Mb/s`;
        return `${(b / 1e9).toFixed(2)} Gb/s`;
    }
    if (bytesPerSec < 1e3) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1e6) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`;
    if (bytesPerSec < 1e9) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
    return `${(bytesPerSec / 1e9).toFixed(2)} GB/s`;
}

// A "physical" interface has a backing device in sysfs. Tunnels and VPNs
// (tailscale0, wg0, tun0), bridges and veth pairs don't, and their traffic
// also flows over a physical interface - so counting them would double up.
function isPhysical(name) {
    return GLib.file_test(`/sys/class/net/${name}/device`, GLib.FileTest.EXISTS);
}

function readNetDev() {
    return new Promise(resolve => {
        Gio.File.new_for_path('/proc/net/dev').load_contents_async(null, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                const stats = new Map();
                for (const line of decoder.decode(bytes).split('\n').slice(2)) {
                    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
                    if (!m || m[1] === 'lo')
                        continue;
                    const cols = m[2].trim().split(/\s+/).map(Number);
                    stats.set(m[1], {rx: cols[0], tx: cols[8]});
                }
                resolve(stats);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

const NetIndicator = GObject.registerClass(
class NetIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Network Speed Indicator');
        this.connect('destroy', () => this._onDestroy());

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
        }));
        this._label = new St.Label({
            text: '…',
            style_class: 'netspeed-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);
        this.add_child(box);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem('Network Settings');
        settings.connect('activate', () => {
            Gio.DesktopAppInfo.new('gnome-network-panel.desktop')?.launch([], null);
        });
        this.menu.addMenuItem(settings);

        this._prev = null;     // last sample: {time, stats}
        this._rates = new Map();
        this._sample();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._renderMenu();
        });
    }

    async _sample() {
        const stats = await readNetDev();
        if (this._destroyed || !stats)
            return;
        const now = GLib.get_monotonic_time();

        if (this._prev) {
            const secs = (now - this._prev.time) / 1e6;
            this._rates.clear();
            let down = 0, up = 0;
            for (const [name, s] of stats) {
                const p = this._prev.stats.get(name);
                if (!p)
                    continue;
                // Counters reset when an interface goes down and up again.
                const rx = Math.max(0, s.rx - p.rx) / secs;
                const tx = Math.max(0, s.tx - p.tx) / secs;
                this._rates.set(name, {rx, tx, physical: isPhysical(name)});
                if (this._rates.get(name).physical) {
                    down += rx;
                    up += tx;
                }
            }
            this._label.text = ` ↓ ${fmtRate(down)}  ↑ ${fmtRate(up)}`;
        }
        this._prev = {time: now, stats};
        if (this.menu.isOpen)
            this._renderMenu();
    }

    _renderMenu() {
        this._section.removeAll();
        if (!this._prev) {
            this._section.addMenuItem(new PopupMenu.PopupMenuItem('Measuring…', {reactive: false}));
            return;
        }
        const names = [...this._prev.stats.keys()]
            .sort((a, b) => (isPhysical(b) - isPhysical(a)) || a.localeCompare(b));
        for (const name of names) {
            const r = this._rates.get(name) ?? {rx: 0, tx: 0, physical: isPhysical(name)};
            const s = this._prev.stats.get(name);
            const tag = r.physical ? '' : '  (virtual)';
            const item = new PopupMenu.PopupMenuItem(
                `${name}${tag}   ↓ ${fmtRate(r.rx)}  ↑ ${fmtRate(r.tx)}   ·   ` +
                `${GLib.format_size(s.rx)} in, ${GLib.format_size(s.tx)} out since boot`,
                {reactive: false});
            this._section.addMenuItem(item);
        }
    }

    // Use the signal, not a destroy() override: the shell can dispose the
    // actor from C (e.g. at shutdown) without calling our JS method.
    _onDestroy() {
        this._destroyed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }
});

export default class NetworkSpeedIndicatorExtension extends Extension {
    enable() {
        this._indicator = new NetIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
