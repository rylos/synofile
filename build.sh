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
cp -r ui "$work/pkg/ui"
# DSM serves the interface without Cache-Control, so browsers keep old files
# on heuristics: every URL carries the build, and an upgrade loads afresh
sed -i "s|href=\"app.css\"|href=\"app.css?v=$asset\"|; s|src=\"js/main.js\"|src=\"js/main.js?v=$asset\"|" "$work/pkg/ui/index.html"
sed -i "s|fonts/eza-icons.woff2\"|fonts/eza-icons.woff2?v=$asset\"|" "$work/pkg/ui/app.css"
find "$work/pkg/ui/js" -name '*.js' -exec sed -i \
    -e "s|\(from \"\./[^\"]*\.js\)\"|\1?v=$asset\"|g" \
    -e "s|\(import(\`\./lang/\${code}\.js\)\`)|\1?v=$asset\`)|g" {} +
tar -C "$work/pkg" --owner=0 --group=0 -czf "$work/spk/package.tgz" bin ui

sed "s/@VERSION@/$version/" spk/INFO.in > "$work/spk/INFO"
# WIZARD_UIFILES: a step of the install and upgrade wizard says to run setup
cp -r spk/conf spk/scripts spk/WIZARD_UIFILES "$work/spk/"
cp ui/images/icon_72.png "$work/spk/PACKAGE_ICON.PNG"
cp ui/images/icon_256.png "$work/spk/PACKAGE_ICON_256.PNG"

mkdir -p dist
out="dist/synofile-$version.spk"
tar -C "$work/spk" --owner=0 --group=0 -cf "$out" INFO package.tgz conf scripts WIZARD_UIFILES PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG
echo "$out"
