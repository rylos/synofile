#!/bin/sh
# Builds dist/synofile-<version>.spk: a static x86_64 binary, twice (the
# privileged CGI and daemon, and the worker that runs as the user), plus
# the interface, packed the way DSM 7's Package Center expects.
set -eu
cd "$(dirname "$0")"

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
target=x86_64-unknown-linux-musl

# the build of the interface: every URL carries it (see below), and the
# binary reports it, so a page loaded before an upgrade reloads itself
asset="$version-$(tar -C ui -cf - . | sha256sum | cut -c1-10)"
export SYNOFILE_ASSET="$asset"

cargo test --quiet
cargo build --release --quiet --target "$target"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pkg/bin" "$work/spk"

cp "target/$target/release/synofile" "$work/pkg/bin/synofile"
# the same program under another name: it starts as the worker, and has no capabilities
cp "target/$target/release/synofile" "$work/pkg/bin/synofile-worker"

# the setuid helper postinst runs: it gives bin/synofile its capabilities,
# and only to the binary whose SHA-256 is compiled into it
hash=$(sha256sum "$work/pkg/bin/synofile" | cut -d' ' -f1)
mkdir -p "$work/pkg/bin/helper"
helper="$work/pkg/bin/helper/synofile-helper"
# linked with the musl Rust ships for this target, built for plain x86-64:
# the build machine's own libc may target newer CPUs (CachyOS: x86-64-v3)
# and die with SIGILL on a Celeron J3455. Only musl's headers come from
# the system (musl-tools / musl).
crt="$(rustc --print sysroot)/lib/rustlib/$target/lib/self-contained"
musl_inc=""
for d in /usr/lib/musl/include /usr/include/x86_64-linux-musl /usr/local/musl/include; do
    [ -f "$d/stdio.h" ] && musl_inc=$d && break
done
[ -n "$musl_inc" ] || { echo "musl headers not found (install musl or musl-tools)" >&2; exit 1; }
${CC:-cc} -O2 -march=x86-64 -mtune=generic -static -nostdlib -nostdinc \
    -isystem "$musl_inc" -isystem "$(${CC:-cc} -print-file-name=include)" \
    -Wall -Wextra -DEXPECTED_SHA256="\"$hash\"" -o "$helper" \
    "$crt/crt1.o" "$crt/crti.o" "$crt/crtbegin.o" spk/helper/synofile-helper.c \
    "$crt/libc.a" "$crt/crtend.o" "$crt/crtn.o"
strip "$helper"
# nothing beyond baseline x86-64: no AVX, BMI, MOVBE, POPCNT/LZCNT/TZCNT
if objdump -d --no-show-raw-insn "$helper" | grep -qE '%[yz]mm|[[:space:]]v[a-z0-9]+[[:space:]]+.*%xmm|[[:space:]](shlx|shrx|sarx|rorx|andn|bzhi|pdep|pext|tzcnt|lzcnt|movbe|popcnt)[[:space:]]'; then
    echo "$helper uses instructions beyond baseline x86-64" >&2
    exit 1
fi
cp -r ui "$work/pkg/ui"
cp -r etc "$work/pkg/etc"
# DSM serves the interface without Cache-Control, so browsers keep old files
# on heuristics: every URL carries the build, and an upgrade loads afresh
sed -i "s|href=\"app.css\"|href=\"app.css?v=$asset\"|; s|src=\"js/main.js\"|src=\"js/main.js?v=$asset\"|" "$work/pkg/ui/index.html"
# the modules preloaded by index.html: the very URLs the imports ask for,
# else each would be downloaded twice
sed -i "s|\(<link rel=\"modulepreload\" href=\"js/[^\"]*\.js\)\"|\1?v=$asset\"|g" "$work/pkg/ui/index.html"
sed -i "s|fonts/eza-icons.woff2\"|fonts/eza-icons.woff2?v=$asset\"|" "$work/pkg/ui/app.css"
find "$work/pkg/ui/js" -name '*.js' -exec sed -i \
    -e "s|\(from \"\./[^\"]*\.js\)\"|\1?v=$asset\"|g" \
    -e "s|\(import(\`\./lang/\${code}\.js\)\`)|\1?v=$asset\`)|g" \
    -e "s|\(import(\"\./[^\"]*\.js\)\")|\1?v=$asset\")|g" \
    -e "s|\(import(\`\./syntax/\${name}\.js\)\`)|\1?v=$asset\`)|g" \
    -e "s|\(from \"\.\./vendor/[^\"]*\.js\)\"|\1?v=$asset\"|g" {} +
tar -C "$work/pkg" --owner=0 --group=0 -czf "$work/spk/package.tgz" bin ui etc

sed "s/@VERSION@/$version/" spk/INFO.in > "$work/spk/INFO"
cp -r spk/conf spk/scripts "$work/spk/"
cp ui/images/icon_72.png "$work/spk/PACKAGE_ICON.PNG"
cp ui/images/icon_256.png "$work/spk/PACKAGE_ICON_256.PNG"

mkdir -p dist
out="dist/synofile-$version.spk"
tar -C "$work/spk" --owner=0 --group=0 -cf "$out" INFO package.tgz conf scripts PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG
echo "$out"
