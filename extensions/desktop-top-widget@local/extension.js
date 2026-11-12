import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---- Settings -------------------------------------------------------------
const REFRESH_SECONDS = 2;      // how often top refreshes
const MAX_LINES = 24;           // header (7 lines) + ~17 processes
const COLUMNS = 92;             // fixed widget width, in characters
const MARGIN = 24;              // distance from the screen edge, in px
const CORNER = 'top-right';     // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
// ---------------------------------------------------------------------------

export default class DesktopTopWidgetExtension extends Extension {
    enable() {
        this._widget = new St.BoxLayout({
            style_class: 'desktop-top-widget',
            reactive: false,
        });
        this._label = new St.Label({
            style_class: 'desktop-top-widget-text',
        });
        this._label.clutter_text.line_wrap = false;
        this._widget.add_child(this._label);
        this._setLines(['starting top…']);

        // Live inside the wallpaper group. Mutter always restacks windows above
        // this group, so the widget stays behind every window.
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(this._widget);
        // New wallpaper actors (wallpaper change, monitor change) get added on
        // top of the group; lift the widget back above them.
        this._bgChildId = bg.connect('child-added', (_g, child) => {
            if (child !== this._widget)
                bg.set_child_above_sibling(this._widget, null);
        });

        this._widget.connect('notify::size', () => this._reposition());
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._reposition());
        this._workareasId = global.display.connect('workareas-changed',
            () => this._reposition());

        this._startTop();
    }

    disable() {
        this._stopTop();

        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workareasId) {
            global.display.disconnect(this._workareasId);
            this._workareasId = 0;
        }
        if (this._bgChildId) {
            Main.layoutManager._backgroundGroup.disconnect(this._bgChildId);
            this._bgChildId = 0;
        }

        this._widget?.destroy();
        this._widget = null;
        this._label = null;
    }

    _reposition() {
        if (!this._widget)
            return;

        const monitor = Main.layoutManager.primaryIndex;
        if (monitor < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const [w, h] = this._widget.get_size();

        const left = CORNER.endsWith('left');
        const topSide = CORNER.startsWith('top');
        const x = left ? area.x + MARGIN : area.x + area.width - w - MARGIN;
        const y = topSide ? area.y + MARGIN : area.y + area.height - h - MARGIN;
        this._widget.set_position(Math.round(x), Math.round(y));
    }

    _startTop() {
        this._cancellable = new Gio.Cancellable();
        try {
            this._proc = Gio.Subprocess.new(
                ['top', '-b', '-d', String(REFRESH_SECONDS), '-w', String(COLUMNS)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._setLines([`could not start top: ${e.message}`]);
            this._scheduleRetry();
            return;
        }

        this._stream = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._frame = [];
        this._frameShown = false;
        this._readLine();
    }

    _stopTop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        try {
            this._proc?.force_exit();
        } catch (e) {
            // already gone
        }
        this._proc = null;
        this._stream = null;
    }

    _scheduleRetry() {
        if (this._retryId)
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._retryId = 0;
            if (this._widget) {
                this._stopTop();
                this._startTop();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _readLine() {
        const stream = this._stream;
        const cancellable = this._cancellable;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            if (cancellable.is_cancelled())
                return;

            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                line = null;
            }

            if (line === null) {
                // top exited; restart it shortly
                if (this._label)
                    this._setLines(['top stopped — restarting…']);
                this._scheduleRetry();
                return;
            }

            this._handleLine(line);
            this._readLine();
        });
    }

    _handleLine(line) {
        if (line.startsWith('top - ')) {
            // A new frame begins; show the previous one if it wasn't shown yet.
            if (!this._frameShown && this._frame.length)
                this._show();
            this._frame = [];
            this._frameShown = false;
        }

        if (this._frameShown)
            return;

        this._frame.push(line.trimEnd());
        if (this._frame.length >= MAX_LINES)
            this._show();
    }

    _show() {
        this._frameShown = true;
        if (this._label)
            this._setLines(this._frame);
    }

    // Always render exactly MAX_LINES x COLUMNS characters. With a monospace
    // font this keeps the widget the same size on every refresh.
    _setLines(lines) {
        if (!this._label)
            return;
        const out = [];
        for (let i = 0; i < MAX_LINES; i++)
            out.push((lines[i] ?? '').slice(0, COLUMNS).padEnd(COLUMNS, ' '));
        this._label.text = out.join('\n');
    }
}
