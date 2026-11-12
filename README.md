# GNOME Desktop Widgets

A small collection of GNOME Shell extensions that put live info on your desktop,
plus a one-command installer that picks up anything new you add to the repo.

| Widget | What it does |
|---|---|
| **Disk Space Indicator** | Free disk space in the top bar. Click for details and to open Disk Usage Analyzer. |
| **Desktop Top Widget** | Live `top` output in a semi-transparent panel on the desktop, behind windows. |
| **Desktop News Widget** | Top stories from free RSS feeds (NPR, ABC News, BBC, The Guardian) in a desktop card. |
| **Desktop Weather Widget** | Current weather for a few cities from Open-Meteo (free, no API key) in a desktop card. |

Tested on GNOME Shell 50 (Ubuntu 26.04); metadata declares GNOME 45–50.

## Install

```bash
git clone https://github.com/BigBam/gnome-desktop-widgets.git
cd gnome-desktop-widgets
./install.sh
```

The installer copies each widget to `~/.local/share/gnome-shell/extensions/`,
enables it, and then pops up a confirmation asking whether to **log out now**
(GNOME only loads new extensions at login). Choose *Later* and it reminds you
with a notification instead.

Other options:

```bash
./install.sh --list                    # what's in the repo, and what's installed
./install.sh --only desktop-news-widget  # install just one (repeatable)
./install.sh --dry-run                 # show what would happen
./install.sh --uninstall               # disable and remove everything
./install.sh --uninstall --only disk-space-indicator
```

Nothing needs root. Optional packages: `procps` (for `top`, almost always present)
and `baobab` (Disk Usage Analyzer, opened from the disk indicator's menu).

## Customizing

Each widget keeps its settings as constants at the top of its `extension.js` —
for example the cities and units in
[`desktop-weather-widget@local/extension.js`](extensions/desktop-weather-widget@local/extension.js),
the feeds in the news widget, or the corner the `top` panel sits in.
Edit, re-run `./install.sh`, and log out and back in.

## Adding a new widget or tool

The installer discovers everything automatically — you never edit `install.sh`.

**A GNOME Shell extension** → add a folder under `extensions/` named after its uuid:

```
extensions/
  my-new-widget@local/
    metadata.json      # "uuid" must equal the folder name
    extension.js
    stylesheet.css     # optional
    schemas/           # optional; compiled automatically if present
```

**A command-line tool** → drop an executable file into `bin/` (`chmod +x` it).
It's installed to `~/.local/bin/`.

Then `./install.sh` (or `./install.sh --only my-new-widget`).

## License

MIT
