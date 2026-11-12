import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ---- Settings -------------------------------------------------------------
// Free RSS feeds, no account or API key needed. Stories are mixed in turn
// (1st from each feed, then 2nd from each, ...).
const FEEDS = [
    {name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml'},
    {name: 'ABC News', url: 'https://abcnews.go.com/abcnews/topstories'},
    {name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml'},
    {name: 'The Guardian', url: 'https://www.theguardian.com/us/rss'},
];
const REFRESH_MINUTES = 10;     // how often to fetch new stories
const STORIES = 5;              // 1 lead story + 4 in the list
const WIDTH = 360;              // card width in px
const GAP = 16;                 // space between this card and the top widget
const MARGIN = 24;              // distance from the screen edge, if no top widget
const TITLE = 'Top Stories';
// ---------------------------------------------------------------------------

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) desktop-news-widget/1';
const IMAGE_ACCEPT = 'image/jpeg,image/png;q=0.9,*/*;q=0.1';
const PEER_CLASS = 'desktop-top-widget';

// ---------- small helpers ----------

function decodeEntities(s) {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function stripCdata(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagText(chunk, name) {
    const m = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    if (!m)
        return '';
    // Decode first (some feeds double-escape), then strip any markup.
    return decodeEntities(stripCdata(m[1])).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`));
    return m ? decodeEntities(m[2]) : null;
}

function improveImageUrl(url) {
    // BBC thumbnails are 240px; the same path serves larger sizes.
    url = url.replace(/(ichef\.bbci\.co\.uk\/ace\/(?:standard|ws)\/)\d+\//, '$1480/');
    // NPR image CDN: ask for a reasonably sized JPEG instead of a huge WebP.
    if (url.includes('brightspotcdn.com/dims')) {
        url = url.replace(/\/resize\/[^/]+\//, '/resize/600/')
                 .replace(/\/format\/webp\//, '/format/jpeg/');
    }
    return url;
}

function pickImage(chunk) {
    const candidates = [];
    for (const m of chunk.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/g)) {
        const tag = m[0];
        const url = attr(tag, 'url');
        if (!url)
            continue;
        const type = attr(tag, 'type') ?? '';
        const medium = attr(tag, 'medium') ?? '';
        if ((type && !type.startsWith('image')) || (medium && medium !== 'image'))
            continue;
        candidates.push({url, width: parseInt(attr(tag, 'width') ?? '0', 10) || 0});
    }

    let url = null;
    if (candidates.length) {
        // Largest image up to ~700px wide; otherwise the smallest one available.
        const ok = candidates.filter(c => c.width <= 700).sort((a, b) => b.width - a.width);
        url = (ok[0] ?? candidates.sort((a, b) => a.width - b.width)[0]).url;
    } else {
        // Fall back to the first <img> embedded in the description/content.
        const raw = stripCdata(chunk);
        for (const m of raw.matchAll(/<img\b[^>]*>/gi)) {
            const src = attr(m[0], 'src');
            if (src && !/pixel|tracking|1x1/i.test(src)) {
                url = src;
                break;
            }
        }
    }
    return url ? improveImageUrl(url) : null;
}

function parseFeed(xml, source) {
    const items = [];
    const parts = xml.split(/<item[\s>]/).slice(1);
    for (const part of parts) {
        const chunk = part.split('</item>')[0];
        const title = tagText(chunk, 'title');
        if (!title)
            continue;
        const date = Date.parse(tagText(chunk, 'pubDate'));
        let link = tagText(chunk, 'link');
        if (!/^https?:\/\//.test(link)) {
            const guid = tagText(chunk, 'guid');
            link = /^https?:\/\//.test(guid) ? guid : '';
        }
        items.push({
            source,
            title,
            link,
            date: Number.isNaN(date) ? null : date,
            image: pickImage(chunk),
        });
    }
    return items;
}

function timeAgo(ms) {
    if (!ms)
        return '';
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1)
        return 'now';
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function clip(s, max) {
    if (s.length <= max)
        return s;
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

function wrapLabel(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass, x_expand: true});
    const ct = label.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function vbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...params});
}

// ---------- extension ----------

export default class DesktopNewsWidgetExtension extends Extension {
    enable() {
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desktop-news-widget']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);
        this._stories = [];
        this._timeLabels = [];

        this._card = vbox({style_class: 'news-card', reactive: false, width: WIDTH});

        const header = new St.BoxLayout({style_class: 'news-header-box'});
        header.add_child(new St.Label({text: TITLE, style_class: 'news-header',
            y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(new St.Widget({x_expand: true}));
        this._updated = new St.Label({text: '', style_class: 'news-updated',
            y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._updated);
        this._card.add_child(header);

        this._body = vbox();
        this._card.add_child(this._body);
        this._showStatus('Loading stories…');

        // Live in the window stack, directly above the desktop (wallpaper or
        // desktop-icons window) and below every app window. Being above the
        // desktop-icons window is what lets the card receive clicks.
        global.window_group.add_child(this._card);
        this._restackedId = global.display.connect('restacked', () => this._restack());
        this._restack();

        // Watch for the top widget appearing, so we can sit next to it.
        const bg = Main.layoutManager._backgroundGroup;
        this._bgAddedId = bg.connect('child-added', () => this._reposition());

        this._card.connect('notify::size', () => this._reposition());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._workareasId = global.display.connect('workareas-changed', () => this._reposition());

        this._refresh().catch(e => console.error('desktop-news-widget: refresh failed', e));
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            REFRESH_MINUTES * 60, () => {
                this._refresh().catch(e => console.error('desktop-news-widget: refresh failed', e));
                return GLib.SOURCE_CONTINUE;
            });
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateTimes();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;

        for (const id of ['_refreshId', '_tickId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        if (this._bgAddedId) {
            Main.layoutManager._backgroundGroup.disconnect(this._bgAddedId);
            this._bgAddedId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workareasId) {
            global.display.disconnect(this._workareasId);
            this._workareasId = 0;
        }
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = 0;
        }
        this._unwatchPeer();

        this._card?.destroy();
        this._card = null;
        this._body = null;
        this._updated = null;
        this._timeLabels = [];
    }

    // ----- placement: to the left of the top widget, aligned to its top -----

    _findPeer() {
        return Main.layoutManager._backgroundGroup.get_children()
            .find(c => c !== this._card && c.style_class === PEER_CLASS) ?? null;
    }

    _watchPeer(peer) {
        if (peer === this._peer)
            return;
        this._unwatchPeer();
        if (!peer)
            return;
        this._peer = peer;
        this._peerIds = [
            peer.connect('notify::x', () => this._reposition()),
            peer.connect('notify::y', () => this._reposition()),
            peer.connect('notify::width', () => this._reposition()),
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
            x = this._peer.x - GAP - w;
            y = this._peer.y;
        } else {
            x = area.x + area.width - w - MARGIN;
            y = area.y + MARGIN;
        }
        x = Math.max(area.x + MARGIN, x);
        this._card.set_position(Math.round(x), Math.round(y));
    }

    // ----- stacking & clicks -----

    _isDesktopWindow(actor) {
        if (!(actor instanceof Meta.WindowActor))
            return false;
        const w = actor.get_meta_window();
        return !!w && (w.get_window_type() === Meta.WindowType.DESKTOP ||
            !!w.customJS_ding?._keepAtBottom);
    }

    // Mutter re-sorts the window stack on every restack and leaves non-window
    // actors on top, so put the card back just above the desktop each time.
    _restack() {
        if (!this._card)
            return;
        const group = global.window_group;
        let anchor = Main.layoutManager._backgroundGroup;
        for (const child of group.get_children()) {
            if (this._isDesktopWindow(child))
                anchor = child;   // keep the top-most desktop window
        }
        if (anchor.get_parent() === group)
            group.set_child_above_sibling(this._card, anchor);
    }

    _makeClickable(actor, url) {
        actor.reactive = true;
        actor.track_hover = true;   // gives the :hover style
        // Plain press/release signals (ClickAction was removed in GNOME 50).
        let pressed = false;
        actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            pressed = true;
            return Clutter.EVENT_STOP;
        });
        actor.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const wasPressed = pressed;
            pressed = false;
            if (wasPressed && actor.hover)
                this._open(url);
            return Clutter.EVENT_STOP;
        });
        actor.connect('leave-event', () => {
            pressed = false;
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _open(url) {
        try {
            Gio.AppInfo.launch_default_for_uri(url,
                global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`desktop-news-widget: could not open ${url}: ${e.message}`);
        }
    }

    // ----- data -----

    _fetch(url, accept) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`bad url ${url}`));
                return;
            }
            msg.request_headers.append('User-Agent', USER_AGENT);
            if (accept)
                msg.request_headers.append('Accept', accept);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        if (msg.get_status() !== Soup.Status.OK)
                            throw new Error(`HTTP ${msg.get_status()} for ${url}`);
                        resolve(bytes);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _loadFeed(feed) {
        try {
            const bytes = await this._fetch(feed.url, 'application/rss+xml, application/xml, text/xml');
            return parseFeed(new TextDecoder().decode(bytes.toArray()), feed.name);
        } catch (e) {
            if (!this._cancellable?.is_cancelled())
                console.warn(`desktop-news-widget: ${feed.name}: ${e.message}`);
            return [];
        }
    }

    async _cacheImage(url) {
        const name = `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)}.img`;
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, name]));
        if (file.query_exists(null))
            return file;
        try {
            const bytes = await this._fetch(url, IMAGE_ACCEPT);
            file.replace_contents(bytes.toArray(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return file;
        } catch (e) {
            return null;
        }
    }

    _pruneCache(keep) {
        const keepNames = new Set(keep.filter(Boolean).map(f => f.get_basename()));
        try {
            const dir = Gio.File.new_for_path(this._cacheDir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                if (!keepNames.has(info.get_name()))
                    dir.get_child(info.get_name()).delete(null);
            }
            en.close(null);
        } catch (e) {
            // ignore
        }
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const lists = await Promise.all(FEEDS.map(f => this._loadFeed(f)));
            if (!this._card)
                return;

            // Interleave: 1st story of each feed, then 2nd of each, ...
            const picked = [];
            const seen = new Set();
            const longest = Math.max(0, ...lists.map(l => l.length));
            for (let i = 0; i < longest && picked.length < STORIES; i++) {
                for (const list of lists) {
                    const item = list[i];
                    if (!item || picked.length >= STORIES)
                        continue;
                    const key = item.title.toLowerCase();
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    picked.push(item);
                }
            }

            if (!picked.length) {
                if (!this._stories.length)
                    this._showStatus('Couldn’t load news. Retrying in a few minutes.');
                return;
            }

            // Lead story should have a picture.
            const heroIdx = picked.findIndex(s => s.image);
            if (heroIdx > 0)
                picked.unshift(...picked.splice(heroIdx, 1));

            const files = await Promise.all(picked.map(s => s.image ? this._cacheImage(s.image) : null));
            if (!this._card)
                return;
            picked.forEach((s, i) => (s.file = files[i]));

            this._stories = picked;
            this._render();
            this._pruneCache(files);
            this._updated.text = GLib.DateTime.new_now_local().format('%-I:%M %p');
        } finally {
            this._busy = false;
        }
    }

    // ----- UI -----

    _showStatus(text) {
        this._body.destroy_all_children();
        this._timeLabels = [];
        this._body.add_child(wrapLabel(text, 'news-status'));
    }

    _meta(story) {
        const box = new St.BoxLayout({style_class: 'news-meta-box'});
        box.add_child(new St.Label({text: story.source.toUpperCase(), style_class: 'news-source'}));
        const time = new St.Label({text: timeAgo(story.date), style_class: 'news-time'});
        this._timeLabels.push([time, story.date]);
        box.add_child(time);
        return box;
    }

    _imageWidget(styleClass, file, params = {}) {
        const w = new St.Widget({style_class: styleClass, ...params});
        if (file)
            w.style = `background-image: url("${file.get_uri()}");`;
        return w;
    }

    _render() {
        this._body.destroy_all_children();
        this._timeLabels = [];

        const [hero, ...rest] = this._stories;

        const heroBox = vbox({style_class: 'news-hero'});
        if (hero.file)
            heroBox.add_child(this._imageWidget('news-hero-img', hero.file, {x_expand: true}));
        const heroText = vbox({style_class: 'news-hero-text'});
        heroText.add_child(this._meta(hero));
        heroText.add_child(wrapLabel(clip(hero.title, 120), 'news-hero-title'));
        heroBox.add_child(heroText);
        this._body.add_child(heroBox);
        if (hero.link)
            this._makeClickable(heroBox, hero.link);

        for (const story of rest) {
            this._body.add_child(new St.Widget({style_class: 'news-sep', x_expand: true}));

            const row = new St.BoxLayout({style_class: 'news-row'});
            if (story.link)
                this._makeClickable(row, story.link);
            const text = vbox({style_class: 'news-row-text', x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            text.add_child(this._meta(story));
            text.add_child(wrapLabel(clip(story.title, 95), 'news-title'));
            row.add_child(text);
            if (story.file) {
                row.add_child(this._imageWidget('news-thumb', story.file,
                    {y_align: Clutter.ActorAlign.CENTER}));
            }
            this._body.add_child(row);
        }
    }

    _updateTimes() {
        for (const [label, date] of this._timeLabels)
            label.text = timeAgo(date);
    }
}
