#!/usr/bin/env bash

BUNDLE=0

for arg in "$@"; do
    [ "$arg" = "--bundle" ] && BUNDLE=1
done

NAME="vertical-app-grid"
DOMAIN="lublst.github.io"
ZIP_NAME="$NAME@$DOMAIN.zip"

echo ":: Compiling translations..."
cd src

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
