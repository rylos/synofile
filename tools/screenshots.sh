#!/bin/sh
# Takes the README screenshots into docs/img: the interface on made-up
# shared folders, in headless Chromium, at twice the pixel density.
#
#   cargo build && tools/screenshots.sh
set -eu

cd "$(dirname "$0")/.."
port=8768
out=docs/img
demo=$(mktemp -d)
var=target/devvar
mkdir -p "$out" "$var/prefs"
profile=$(mktemp -d)
trap 'kill "$server" 2>/dev/null; rm -rf "$demo" "$profile"' EXIT

# ---- the made-up shares ----
d="$demo/Documents"
mkdir -p "$d/Projects/website" "$d/Projects/garden" "$d/Invoices/2026" "$d/Recipes" "$d/Scans"
printf '# Notes\n\nThings to do.\n' >"$d/notes.md"
printf '#!/bin/sh\necho deploy\n' >"$d/deploy.sh" && chmod +x "$d/deploy.sh"
printf '[package]\nname = "demo"\n' >"$d/Cargo.toml"
printf 'Read me first.\n' >"$d/README.md"
printf 'fn main() {}\n' >"$d/main.rs"
printf 'secret\n' >"$d/.env"
for f in budget-2026.xlsx contract.pdf report.docx slides.pptx; do head -c 180000 /dev/urandom >"$d/$f"; done
head -c 4200000 /dev/urandom >"$d/photos-2025.zip"
head -c 900000 /dev/urandom >"$d/backup.tar.gz"
ln -s Projects/website "$d/site"
for i in 01 02 03 04 05 06; do printf 'invoice %s\n' "$i" >"$d/Invoices/2026/invoice-$i.pdf"; done
touch -d '2025-11-02 10:14' "$d/backup.tar.gz" "$d/contract.pdf"
touch -d '2026-03-18 17:40' "$d/Recipes" "$d/Scans"

p="$demo/Photos"
mkdir -p "$p/2026/Holidays" "$p/2025"
n=0
for spec in "sunset:#ff7e5f:#feb47b" "sea:#2193b0:#6dd5ed" "forest:#134e5e:#71b280" "lavender:#7f7fd5:#86a8e7" \
    "dune:#e6dada:#274046" "lake:#1a2980:#26d0ce" "peach:#ffafbd:#ffc3a0" "night:#141e30:#243b55" \
    "meadow:#56ab2f:#a8e063" "rose:#eecda3:#ef629f" "storm:#373b44:#4286f4" "citrus:#f7971e:#ffd200"; do
    n=$((n + 1))
    name=${spec%%:*}
    rest=${spec#*:}
    magick -size 640x427 "gradient:${rest%%:*}-${rest#*:}" -swirl $((n * 23)) -quality 82 "$p/2026/Holidays/IMG_$(printf '%04d' $((2400 + n)))-$name.jpg"
done
head -c 2000000 /dev/urandom >"$p/2026/Holidays/VID_2412.mp4"

v="$demo/Video"
mkdir -p "$v/Films" "$v/Series"
truncate -s 4718592000 "$v/Films/Nature documentary (2024).mkv"
truncate -s 1610612736 "$v/Films/Old home movie.mp4"
truncate -s 734003200 "$v/Series/episode-01.mkv"
head -c 1500000000 /dev/zero >"$v/Films/Concert (2025).mkv"

m="$demo/Music"
mkdir -p "$m/Jazz" "$m/Classical"
head -c 32000000 /dev/zero >"$m/Classical/symphony.flac"
head -c 9000000 /dev/zero >"$m/Jazz/track-01.mp3"
mkdir -p "$demo/Backup/laptop" "$demo/homes"
# an older copy of a file, for the conflict
head -c 150000 /dev/urandom >"$demo/Backup/laptop/contract.pdf"
touch -d '2026-01-09 08:30' "$demo/Backup/laptop/contract.pdf"

# ---- the server ----
SYNOFILE_DEV_USER=dev python3 tools/devserver.py --root "$demo" --port "$port" >/dev/null 2>&1 &
server=$!
sleep 1.5
api="http://127.0.0.1:$port/api.cgi"

prefs() {
    printf '%s' "$1" >"$var/prefs/dev.json"
}

# shot NAME WIDTH,HEIGHT QUERY
shot() {
    LANG=en_US.UTF-8 LANGUAGE=en LC_ALL=en_US.UTF-8 chromium --headless=new --hide-scrollbars \
        --no-first-run --user-data-dir="$profile" --lang=en-US --force-device-scale-factor=2 --window-size="$2" \
        --virtual-time-budget=4000 --screenshot="$out/$1.png" "http://127.0.0.1:$port/index.html?lang=enu$3" >/dev/null 2>&1
    echo "$out/$1.png"
}

tabs='"tabs":{"list":[{"panes":[{"path":"/Documents"}]},{"panes":[{"path":"/Photos/2026/Holidays","view":"grid"}]},{"panes":[{"path":"/Video/Films"}]}],"current":0}'
prefs "{\"theme\":\"dark\",\"info\":false,\"favorites\":[{\"path\":\"/Documents/Projects\",\"name\":\"Projects\"},{\"path\":\"/Photos/2026\",\"name\":\"2026\"}],$tabs}"
shot list 1360,780 ""

prefs "{\"theme\":\"dark\",\"info\":true,\"favorites\":[{\"path\":\"/Documents/Projects\",\"name\":\"Projects\"}],\"tabs\":{\"list\":[{\"panes\":[{\"path\":\"/Documents\"}]},{\"panes\":[{\"path\":\"/Photos/2026/Holidays\",\"view\":\"grid\"}]}],\"current\":1}}"
shot grid 1360,780 ""

prefs "{\"theme\":\"light\",\"info\":false,\"favorites\":[{\"path\":\"/Documents/Projects\",\"name\":\"Projects\"}],\"tabs\":{\"list\":[{\"panes\":[{\"path\":\"/Video/Films\"},{\"path\":\"/Backup/laptop\"}],\"active\":0}],\"current\":0}}"
shot light 1360,780 ""

# a copy that changes pace, so the chart has something to show
prefs "{\"theme\":\"dark\",\"info\":false,$tabs}"
id=$(curl -s -X POST "$api/jobs/new" -d '{"op":"copy","sources":["/Video/Films/Concert (2025).mkv"],"dest":"/Backup/laptop","verify":true,"limit":62914560}' |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')
for bps in 104857600 41943040 83886080 136314880; do
    sleep 1.2
    curl -s -X POST "$api/jobs/control" -d "{\"id\":$id,\"action\":\"limit\",\"bps\":$bps}" >/dev/null
done
sleep 1
shot transfer 1360,980 "&xfer=last"

# a conflict, waiting for an answer
curl -s -X POST "$api/jobs/new" -d '{"op":"copy","sources":["/Documents/contract.pdf"],"dest":"/Backup/laptop","conflict":"ask"}' >/dev/null
sleep 1.5
shot conflict 1360,1020 "&xfer=last"

if command -v pngquant >/dev/null; then
    pngquant --force --skip-if-larger --ext .png --quality 85-98 "$out"/*.png || true
fi
