#!/usr/bin/env bash
set -euo pipefail

APP_NAME="screensound"
VERSION=$(python3 -c "import re; print(re.search(r'VERSION\s*=\s*\"(.+?)\"', open('freeze_detector.py').read()).group(1))")
ARCH="amd64"
PKG_DIR="${APP_NAME}_${VERSION}_${ARCH}"

echo "Building ${APP_NAME} ${VERSION} .deb package..."

# Clean previous build
rm -rf "$PKG_DIR" "${PKG_DIR}.deb"

# Create directory structure
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/opt/${APP_NAME}"
mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/applications"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/128x128/apps"

# --- DEBIAN/control ---
cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: ${APP_NAME}
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${ARCH}
Depends: python3 (>= 3.10), python3-venv, python3-tk, scrot, alsa-utils
Maintainer: ScreenSound <screensound@local>
Description: Screen Freeze Detector
 Monitors screen zones and alerts with sound when a zone freezes.
 Useful for detecting paused/buffering videos.
 Supports multiple zones, configurable threshold, and global hotkeys (F11/F12).
EOF

# --- DEBIAN/postinst (setup venv + install deps) ---
cat > "${PKG_DIR}/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

INSTALL_DIR="/opt/screensound"
VENV_DIR="${INSTALL_DIR}/venv"

echo "Setting up Python virtual environment..."
python3 -m venv "$VENV_DIR"
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet Pillow pynput

echo "ScreenSound installed successfully."
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# --- DEBIAN/prerm (cleanup venv) ---
cat > "${PKG_DIR}/DEBIAN/prerm" << 'EOF'
#!/bin/bash
set -e
rm -rf /opt/screensound/venv
EOF
chmod 755 "${PKG_DIR}/DEBIAN/prerm"

# --- Application file ---
cp freeze_detector.py "${PKG_DIR}/opt/${APP_NAME}/freeze_detector.py"

# --- Launcher script ---
cat > "${PKG_DIR}/usr/bin/${APP_NAME}" << 'EOF'
#!/bin/bash
exec /opt/screensound/venv/bin/python /opt/screensound/freeze_detector.py "$@"
EOF
chmod 755 "${PKG_DIR}/usr/bin/${APP_NAME}"

# --- Generate icon (teal circle with S) ---
python3 -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.ellipse([8, 8, 120, 120], fill='#25403B', outline='#36BFB1', width=4)
draw.ellipse([20, 20, 108, 108], fill='#2C736C')
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 56)
except:
    font = ImageFont.load_default()
draw.text((64, 64), 'S', fill='#94F2E9', font=font, anchor='mm')
img.save('${PKG_DIR}/usr/share/icons/hicolor/128x128/apps/${APP_NAME}.png')
print('Icon generated.')
"

# --- Desktop entry ---
cat > "${PKG_DIR}/usr/share/applications/${APP_NAME}.desktop" << EOF
[Desktop Entry]
Name=Screen Freeze Detector
Comment=Monitor screen zones and alert when frozen
Exec=${APP_NAME}
Icon=${APP_NAME}
Terminal=false
Type=Application
Categories=Utility;AudioVideo;
Keywords=screen;freeze;monitor;video;alert;
EOF

# --- Build .deb ---
dpkg-deb --build --root-owner-group "$PKG_DIR"

echo ""
echo "Package built: ${PKG_DIR}.deb"
echo "Install with: sudo dpkg -i ${PKG_DIR}.deb"
echo "Then run:     screensound"
