#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUNDLE=0

for arg in "$@"; do
    [ "$arg" = "--bundle" ] && BUNDLE=1
done

NAME="vertical-app-grid-max"
DOMAIN="local"
ZIP_NAME="$NAME@$DOMAIN.zip"

echo ":: Compiling translations..."
cd "$SCRIPT_DIR/src"

for po in po/*.po; do
    lang="$(basename "${po%.po}")"

    mkdir -p "locale/$lang/LC_MESSAGES"
    msgfmt -o "locale/$lang/LC_MESSAGES/$NAME@$DOMAIN.mo" "$po"
done

echo ":: Creating extension bundle..."
zip -qr "$ZIP_NAME" . -x "po/*"

if [ "$BUNDLE" -eq 1 ]; then
    mv "$ZIP_NAME" ..
else
    echo ":: Installing extension..."
    gnome-extensions install -f "$ZIP_NAME"
    rm "$ZIP_NAME"
fi
