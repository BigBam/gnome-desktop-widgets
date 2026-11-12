import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 30;
const ATTRS = 'filesystem::size,filesystem::free';

// Mount points to report. The first one drives the top-bar label.
// Others are shown in the menu only if they are a separate filesystem.
const PATHS = ['/', GLib.get_home_dir()];

function fmt(bytes) {
    return GLib.format_size(bytes);
}

function queryFs(path) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_filesystem_info_async(ATTRS, GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
                const info = f.query_filesystem_info_finish(res);
                const size = info.get_attribute_uint64('filesystem::size');
                const free = info.get_attribute_uint64('filesystem::free');
                resolve({path, size, free});
            } catch (e) {
                resolve(null);
            }
        });
    });
}

const DiskIndicator = GObject.registerClass(
class DiskIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Disk Space Indicator');
        this.connect('destroy', () => this._onDestroy());

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            icon_name: 'drive-harddisk-symbolic',
            style_class: 'system-status-icon',
        }));
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);
        this.add_child(box);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const analyzer = new PopupMenu.PopupMenuItem('Open Disk Usage Analyzer');
        analyzer.connect('activate', () => this._launch('org.gnome.baobab.desktop'));
        this.menu.addMenuItem(analyzer);

        const disks = new PopupMenu.PopupMenuItem('Open Disks');
        disks.connect('activate', () => this._launch('org.gnome.DiskUtility.desktop'));
        this.menu.addMenuItem(disks);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        });

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _launch(desktopId) {
        const app = Gio.DesktopAppInfo.new(desktopId);
        if (app)
            app.launch([], null);
    }

    async _refresh() {
        const results = (await Promise.all(PATHS.map(queryFs))).filter(Boolean);
        if (this._destroyed)
            return;

        if (results.length === 0) {
            this._label.text = '?';
            return;
        }

        const root = results[0];
        this._label.text = ` ${fmt(root.free)} free`;

        // De-duplicate paths that live on the same filesystem.
        const seen = new Set();
        this._section.removeAll();
        for (const r of results) {
            const key = `${r.size}:${r.free}`;
            if (seen.has(key))
                continue;
            seen.add(key);

            const used = r.size - r.free;
            const pct = r.size > 0 ? Math.round((used / r.size) * 100) : 0;
            const item = new PopupMenu.PopupMenuItem(
                `${r.path}   ${fmt(used)} used of ${fmt(r.size)} (${pct}%) · ${fmt(r.free)} free`,
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

export default class DiskSpaceIndicatorExtension extends Extension {
    enable() {
        this._indicator = new DiskIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
