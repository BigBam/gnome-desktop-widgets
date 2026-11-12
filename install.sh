#!/usr/bin/env bash
#
# install.sh - install (or remove) every widget and tool in this repo.
#
# The installer discovers what to install by looking in two folders, so new
# widgets and tools are picked up automatically - no edits to this script:
#
#   extensions/<uuid>/   a GNOME Shell extension (must contain metadata.json
#                        whose "uuid" matches the folder name). Copied to
#                        ~/.local/share/gnome-shell/extensions/ and enabled.
#   bin/<name>           an executable command-line tool. Copied to ~/.local/bin/.
#
# Run ./install.sh --help for options.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$REPO_DIR/extensions"
BIN_SRC="$REPO_DIR/bin"
EXT_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
BIN_DEST="$HOME/.local/bin"

MODE=install
DRY_RUN=0
ASK_LOGOUT=1
ONLY=()

# ---------------------------------------------------------------- output ----

if [[ -t 1 ]]; then
    B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' N=$'\e[0m'
else
    B='' G='' Y='' R='' D='' N=''
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '  %s[dry-run] %s%s\n' "$D" "$*" "$N"; else "$@"; fi; }

usage() {
    cat <<EOF
Usage: ./install.sh [options]

Installs every GNOME extension in extensions/ and every tool in bin/.

Options:
  -l, --list           List the widgets and tools in this repo, then exit
  -o, --only NAME      Only install NAME (repeatable). NAME is an extension
                       uuid, its short name (part before the @), or a bin/ file
  -u, --uninstall      Disable and remove instead of installing
  -n, --dry-run        Show what would happen without changing anything
      --no-logout      Don't offer to log out at the end
  -h, --help           Show this help
EOF
}

while (( $# )); do
    case "$1" in
        -l|--list)      MODE=list ;;
        -o|--only)      [[ $# -ge 2 ]] || die "--only needs a name"; ONLY+=("$2"); shift ;;
        --only=*)       ONLY+=("${1#*=}") ;;
        -u|--uninstall) MODE=uninstall ;;
        -n|--dry-run)   DRY_RUN=1 ;;
        --no-logout)    ASK_LOGOUT=0 ;;
        -h|--help)      usage; exit 0 ;;
        *)              usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

[[ $EUID -ne 0 ]] || die "run this as your normal user, not root - extensions are installed per user."

# ------------------------------------------------------------- helpers ------

# json_get FILE KEY -> prints the value (arrays are joined with spaces)
json_get() {
    python3 - "$1" "$2" <<'PY'
import json, sys
v = json.load(open(sys.argv[1])).get(sys.argv[2], "")
print(" ".join(map(str, v)) if isinstance(v, list) else v)
PY
}

# gsettings_list_edit KEY add|remove UUID... -> edits an org.gnome.shell string list
gsettings_list_edit() {
    local key=$1 op=$2; shift 2
    local current new
    current=$(gsettings get org.gnome.shell "$key")
    new=$(python3 - "$op" "$current" "$@" <<'PY'
import ast, sys
op, raw, uuids = sys.argv[1], sys.argv[2], sys.argv[3:]
raw = raw.removeprefix("@as ").strip()
items = ast.literal_eval(raw) if raw else []
if op == "add":
    items += [u for u in uuids if u not in items]
else:
    items = [i for i in items if i not in uuids]
print(str(items))
PY
)
    [[ "$new" == "$current" ]] || run gsettings set org.gnome.shell "$key" "$new"
}

selected() {   # selected NAME... -> true if --only wasn't given or any NAME matches
    (( ${#ONLY[@]} == 0 )) && return 0
    local want name
    for want in "${ONLY[@]}"; do
        for name in "$@"; do [[ "$want" == "$name" ]] && return 0; done
    done
    return 1
}

# ------------------------------------------------------------ discovery -----

EXTS=()   # uuids
TOOLS=()  # file names in bin/
declare -A EXT_NAME EXT_DESC EXT_SHELL

if [[ -d "$EXT_SRC" ]]; then
    for dir in "$EXT_SRC"/*/; do
        [[ -f "$dir/metadata.json" ]] || continue
        folder=$(basename "$dir")
        uuid=$(json_get "$dir/metadata.json" uuid)
        if [[ "$uuid" != "$folder" ]]; then
            warn "skipping extensions/$folder: metadata.json uuid is '$uuid' (must match the folder name)"
            continue
        fi
        selected "$uuid" "${uuid%%@*}" || continue
        EXTS+=("$uuid")
        EXT_NAME[$uuid]=$(json_get "$dir/metadata.json" name)
        EXT_DESC[$uuid]=$(json_get "$dir/metadata.json" description)
        EXT_SHELL[$uuid]=$(json_get "$dir/metadata.json" shell-version)
    done
fi

if [[ -d "$BIN_SRC" ]]; then
    for f in "$BIN_SRC"/*; do
        [[ -f "$f" && -x "$f" ]] || continue
        name=$(basename "$f")
        selected "$name" || continue
        TOOLS+=("$name")
    done
fi

if (( ${#ONLY[@]} )) && (( ${#EXTS[@]} + ${#TOOLS[@]} == 0 )); then
    die "nothing matched --only ${ONLY[*]} (try ./install.sh --list)"
fi

# ----------------------------------------------------------------- list -----

if [[ $MODE == list ]]; then
    info "${B}GNOME extensions${N} (extensions/)"
    for u in "${EXTS[@]}"; do
        state="not installed"
        [[ -d "$EXT_DEST/$u" ]] && state="installed"
        printf '  %-32s %s%s%s\n      %s\n' "$u" "$D" "$state" "$N" "${EXT_DESC[$u]}"
    done
    (( ${#EXTS[@]} )) || info "  (none)"
    info "${B}Command-line tools${N} (bin/)"
    for t in "${TOOLS[@]}"; do printf '  %s\n' "$t"; done
    (( ${#TOOLS[@]} )) || info "  (none)"
    exit 0
fi

(( ${#EXTS[@]} + ${#TOOLS[@]} )) || die "nothing to ${MODE}: extensions/ and bin/ are empty."

# --------------------------------------------------------- preflight --------

command -v python3 >/dev/null || die "python3 is required."
if (( ${#EXTS[@]} )); then
    command -v gsettings >/dev/null || die "gsettings not found - is this a GNOME desktop?"
    command -v gnome-shell >/dev/null || die "gnome-shell not found - these widgets need the GNOME desktop."
    SHELL_MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
    [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* ]] ||
        warn "XDG_CURRENT_DESKTOP is '${XDG_CURRENT_DESKTOP:-unset}', not GNOME - installing anyway."
fi

# ------------------------------------------------------------ uninstall -----

if [[ $MODE == uninstall ]]; then
    info "${B}Removing${N}"
    if (( ${#EXTS[@]} )); then
        gsettings_list_edit enabled-extensions remove "${EXTS[@]}"
        for u in "${EXTS[@]}"; do
            if [[ -d "$EXT_DEST/$u" ]]; then
                run rm -rf "${EXT_DEST:?}/$u"; ok "${EXT_NAME[$u]}"
            else
                info "  - ${EXT_NAME[$u]} ${D}(was not installed)${N}"
            fi
        done
    fi
    for t in "${TOOLS[@]}"; do
        if [[ -e "$BIN_DEST/$t" ]]; then run rm -f "$BIN_DEST/$t"; ok "$t"; fi
    done
    info ""
    info "Done. The widgets disappear right away; nothing else to do."
    exit 0
fi

# -------------------------------------------------------------- install -----

INSTALLED=()

if (( ${#EXTS[@]} )); then
    info "${B}Installing GNOME extensions${N} → $EXT_DEST"
    run mkdir -p "$EXT_DEST"
    for u in "${EXTS[@]}"; do
        if [[ " ${EXT_SHELL[$u]} " != *" $SHELL_MAJOR "* ]]; then
            warn "${EXT_NAME[$u]} lists GNOME ${EXT_SHELL[$u]// /, }; you have $SHELL_MAJOR. GNOME may refuse to load it."
        fi
        tmp="$EXT_DEST/.$u.new"
        run rm -rf "$tmp"
        run cp -r "$EXT_SRC/$u" "$tmp"
        # Extensions that ship GSettings schemas need them compiled.
        if [[ -d "$EXT_SRC/$u/schemas" ]]; then
            command -v glib-compile-schemas >/dev/null || die "glib-compile-schemas is needed for $u"
            run glib-compile-schemas "$tmp/schemas"
        fi
        run rm -rf "${EXT_DEST:?}/$u"
        run mv "$tmp" "$EXT_DEST/$u"
        ok "${EXT_NAME[$u]}"
        INSTALLED+=("${EXT_NAME[$u]}")
    done

    gsettings_list_edit enabled-extensions add "${EXTS[@]}"
    gsettings_list_edit disabled-extensions remove "${EXTS[@]}"
    if [[ $(gsettings get org.gnome.shell disable-user-extensions) == true ]]; then
        warn "user extensions were switched off globally; turning them back on."
        run gsettings set org.gnome.shell disable-user-extensions false
    fi
fi

if (( ${#TOOLS[@]} )); then
    info "${B}Installing command-line tools${N} → $BIN_DEST"
    run mkdir -p "$BIN_DEST"
    for t in "${TOOLS[@]}"; do
        run install -m 755 "$BIN_SRC/$t" "$BIN_DEST/$t"
        ok "$t"
        INSTALLED+=("$t")
    done
    [[ ":$PATH:" == *":$BIN_DEST:"* ]] ||
        warn "$BIN_DEST is not on your PATH yet - it will be after you log back in on most distros."
fi

# Optional helpers some widgets use.
command -v top >/dev/null || warn "'top' not found - the Desktop Top Widget needs it (package: procps)."
[[ -e /usr/share/applications/org.gnome.baobab.desktop ]] ||
    warn "Disk Usage Analyzer isn't installed - optional, used by Disk Space Indicator (package: baobab)."

info ""
(( DRY_RUN )) && { info "Dry run finished - nothing was changed."; exit 0; }
(( ${#EXTS[@]} )) || { info "Done."; exit 0; }

# --------------------------------------------------------------- logout -----
# GNOME only loads new extensions at login (always on Wayland), so offer to
# log out now. We confirm first, then log out without GNOME's second prompt.

list=$(printf '  • %s\n' "${INSTALLED[@]}")
msg="Installed:
$list

GNOME loads new widgets when you log in, so you need to log out and back in to see them."

if (( ASK_LOGOUT )); then
    answer=no
    if [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]] && command -v zenity >/dev/null; then
        if zenity --question --title="Desktop widgets installed" --icon=system-log-out \
                  --width=420 --ok-label="Log Out Now" --cancel-label="Later" \
                  --text="$msg

Save any open work first, then choose <b>Log Out Now</b>." 2>/dev/null; then
            answer=yes
        fi
    elif [[ -t 0 ]]; then
        info "$msg"
        read -r -p "Log out now? Save your work first. [y/N] " reply
        [[ "$reply" =~ ^[Yy] ]] && answer=yes
    fi

    if [[ $answer == yes ]]; then
        info "Logging out…"
        gnome-session-quit --logout --no-prompt
        exit 0
    fi
fi

info "${B}Log out and back in${N} to load the new widgets."
command -v notify-send >/dev/null && [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]] &&
    notify-send -i system-log-out "Desktop widgets installed" \
        "Log out and back in to load them." 2>/dev/null || true
