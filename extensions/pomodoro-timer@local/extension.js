import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ---- Settings -------------------------------------------------------------
const PHASES = {
    focus: {label: 'Focus', minutes: 25},
    short: {label: 'Short break', minutes: 5},
    long: {label: 'Long break', minutes: 15},
};
const LONG_BREAK_EVERY = 4;           // a long break after this many focus sessions
const AUTO_START_BREAKS = true;       // start the break as soon as focus ends
const SOUND = 'alarm-clock-elapsed';  // freedesktop sound name, or '' for silence
// ---------------------------------------------------------------------------

// GNOME disables extensions while the screen is locked, then re-enables them.
// Keeping the timer state at module level (the module stays loaded) means a
// running timer survives locking the screen.
const state = {
    phase: null,        // 'focus' | 'short' | 'long' | null (idle)
    endsAt: 0,          // GLib.get_real_time() µs when the phase ends (if running)
    remaining: 0,       // µs left, while paused
    paused: false,
    completed: 0,       // focus sessions finished today
    day: '',
};

const now = () => GLib.get_real_time();
const today = () => GLib.DateTime.new_now_local().format('%F');

function fmt(us) {
    const s = Math.max(0, Math.ceil(us / 1e6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function nextBreak() {
    return state.completed > 0 && state.completed % LONG_BREAK_EVERY === 0 ? 'long' : 'short';
}

const PomodoroIndicator = GObject.registerClass(
class PomodoroIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Pomodoro Timer');
        this.connect('destroy', () => this._onDestroy());

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: 'alarm-symbolic', style_class: 'system-status-icon'});
        box.add_child(this._icon);
        this._label = new St.Label({style_class: 'pomodoro-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this.add_child(box);

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pause = new PopupMenu.PopupMenuItem('Pause');
        this._pause.connect('activate', () => this._togglePause());
        this.menu.addMenuItem(this._pause);

        for (const [key, p] of Object.entries(PHASES)) {
            const item = new PopupMenu.PopupMenuItem(`Start ${p.label.toLowerCase()} (${p.minutes} min)`);
            item.connect('activate', () => this._start(key));
            this.menu.addMenuItem(item);
        }

        this._stop = new PopupMenu.PopupMenuItem('Stop');
        this._stop.connect('activate', () => this._reset());
        this.menu.addMenuItem(this._stop);

        // Finished while the screen was locked? Wrap it up now.
        if (state.phase && !state.paused && now() >= state.endsAt)
            this._finish();
        this._tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _start(phase) {
        state.phase = phase;
        state.paused = false;
        state.endsAt = now() + PHASES[phase].minutes * 60e6;
        this._tick();
    }

    _togglePause() {
        if (!state.phase)
            return;
        if (state.paused) {
            state.endsAt = now() + state.remaining;
            state.paused = false;
        } else {
            state.remaining = state.endsAt - now();
            state.paused = true;
        }
        this._tick();
    }

    _reset() {
        state.phase = null;
        state.paused = false;
        this._tick();
    }

    _finish() {
        const finished = state.phase;
        if (finished === 'focus') {
            state.completed++;
            const brk = nextBreak();
            this._notify('Focus session done 🎉',
                `That's ${state.completed} today. Time for a ${PHASES[brk].label.toLowerCase()}.`);
            if (AUTO_START_BREAKS) {
                this._start(brk);
                return;
            }
        } else {
            this._notify('Break’s over', 'Ready for another focus session?');
        }
        state.phase = null;
        state.paused = false;
    }

    _notify(title, body) {
        if (SOUND)
            global.display.get_sound_player().play_from_theme(SOUND, title, null);
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Pomodoro', iconName: 'alarm-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        this._source.addNotification(new MessageTray.Notification({
            source: this._source, title, body, urgency: MessageTray.Urgency.HIGH,
        }));
    }

    _tick() {
        if (state.day !== today()) {
            state.day = today();
            state.completed = 0;
        }
        if (state.phase && !state.paused && now() >= state.endsAt)
            this._finish();

        const running = !!state.phase;
        const left = state.paused ? state.remaining : state.endsAt - now();

        this.remove_style_class_name('pomodoro-focus');
        this.remove_style_class_name('pomodoro-break');
        this.remove_style_class_name('pomodoro-paused');
        if (running) {
            this.add_style_class_name(state.paused ? 'pomodoro-paused'
                : state.phase === 'focus' ? 'pomodoro-focus' : 'pomodoro-break');
        }

        this._label.text = running ? ` ${fmt(left)}` : '';
        this._label.visible = running;
        this._icon.icon_name = !running ? 'alarm-symbolic'
            : state.paused ? 'media-playback-pause-symbolic'
                : state.phase === 'focus' ? 'alarm-symbolic' : 'face-smile-symbolic';

        const done = `${state.completed} focus session${state.completed === 1 ? '' : 's'} today`;
        this._status.label.text = running
            ? `${PHASES[state.phase].label}${state.paused ? ' (paused)' : ''} — ${fmt(left)} left · ${done}`
            : `Not running · ${done}`;
        this._pause.label.text = state.paused ? 'Resume' : 'Pause';
        this._pause.visible = running;
        this._stop.visible = running;
    }

    // Use the signal, not a destroy() override: the shell can dispose the
    // actor from C (e.g. at shutdown) without calling our JS method.
    _onDestroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }

    // Called from disable(), not on destroy: at shell shutdown the message
    // tray is already gone and touching it would throw.
    removeNotifications() {
        this._source?.destroy();
        this._source = null;
    }
});

export default class PomodoroTimerExtension extends Extension {
    enable() {
        this._indicator = new PomodoroIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.removeNotifications();
        this._indicator?.destroy();
        this._indicator = null;
    }
}
