#!/usr/bin/env bash
# Runs the AppImage smoke scenario (smoke.mjs) inside a container of another Linux distribution.
#
#   apps/desktop/scripts/smoke-distro.sh <image> <path/to/Folio.AppImage> [fixture.pdf]
#   e.g. smoke-distro.sh fedora:42 Folio_0.1.3_amd64.AppImage
#
# The AppImage is unpacked and run through AppRun (smoke.mjs does that), so no FUSE is needed.
# Inside the container this script installs Xvfb, D-Bus, the WebKit WebDriver and qpdf with the
# distribution's package manager, then runs smoke.mjs under xvfb-run + dbus-run-session.
#
# Host requirements: docker or podman (CONTAINER_ENGINE overrides), node (mounted read-only into the
# container, so it must run on the image's glibc: Node 22 needs glibc >= 2.28), and tauri-driver
# (TAURI_DRIVER, default: found on PATH). tauri-driver is built on the CI runner, so an image whose
# glibc is older than the runner's fails here: that is a finding about the build, not about the test.
#
# FOLIO_SMOKE_NO_SANDBOX=1 (default) disables WebKit's bubblewrap sandbox, which cannot start inside
# an unprivileged container; set it to 0 when the container is run with --privileged.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <image> <appimage> [fixture.pdf]" >&2
  exit 2
fi
image=$1
appimage=$(realpath "$2")
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
pdf=${3:-${FOLIO_SMOKE_PDF:-}}
engine=${CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}
[ -n "$engine" ] || { echo "no container engine: install docker or podman" >&2; exit 2; }
[ -f "$appimage" ] || { echo "AppImage not found: $appimage" >&2; exit 2; }
[ -n "$pdf" ] && [ -f "$pdf" ] || { echo "a fixture PDF is required (3rd argument or FOLIO_SMOKE_PDF)" >&2; exit 2; }
pdf=$(realpath "$pdf")
driver=$(realpath "${TAURI_DRIVER:-$(command -v tauri-driver || true)}" 2>/dev/null) || driver=""
[ -n "$driver" ] && [ -f "$driver" ] || { echo "tauri-driver not found: set TAURI_DRIVER" >&2; exit 2; }
node_bin=$(realpath "$(command -v node)")
node_root=$(dirname "$(dirname "$node_bin")")

read -r -d '' inner <<'INNER' || true
set -euo pipefail
. /etc/os-release
echo "== ${PRETTY_NAME:-$ID} (glibc $(ldd --version 2>&1 | head -1 | grep -o '[0-9]*\.[0-9]*$'))"
case "${ID_LIKE:-} ${ID}" in
  *debian*|*ubuntu*)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # Ubuntu 20.04 has no webkit2gtk 4.1; the 4.0 driver is the closest match there.
    apt-get install -y -qq --no-install-recommends xvfb xauth dbus dbus-x11 gnome-keyring qpdf ca-certificates libsecret-1-0 \
      libgl1-mesa-dri libgtk-3-0 fonts-dejavu-core
    apt-get install -y -qq --no-install-recommends webkit2gtk-driver
    ;;
  *fedora*|*rhel*)
    dnf install -y -q xorg-x11-server-Xvfb xauth dbus-daemon dbus-x11 gnome-keyring qpdf libsecret mesa-dri-drivers gtk3 \
      dejavu-sans-fonts webkit2gtk4.1 webkit2gtk4.1-devel
    ;;
  *arch*)
    pacman -Sy --noconfirm --needed xorg-server-xvfb xorg-xauth dbus gnome-keyring qpdf libsecret mesa gtk3 ttf-dejavu webkit2gtk-4.1
    ;;
  *)
    echo "unsupported distribution: ${ID}" >&2
    exit 2
    ;;
esac
command -v WebKitWebDriver >/dev/null || export PATH="$PATH:$(dirname "$(find /usr -name WebKitWebDriver -type f 2>/dev/null | head -1)")"
command -v WebKitWebDriver >/dev/null || { echo "WebKitWebDriver is not installed on ${ID}" >&2; exit 2; }
export PATH="/opt/node/bin:/opt/smoke/bin:$PATH"
cd /work
exec xvfb-run -a dbus-run-session -- node apps/desktop/scripts/smoke.mjs
INNER

mounts=(-v "$repo:/work:ro" -v "$appimage:/opt/smoke/Folio.AppImage:ro" -v "$pdf:/opt/smoke/fixture.pdf:ro"
  -v "$driver:/opt/smoke/bin/tauri-driver:ro" -v "$node_root:/opt/node:ro")
envs=(-e FOLIO_APPIMAGE=/opt/smoke/Folio.AppImage -e FOLIO_SMOKE_PDF=/opt/smoke/fixture.pdf)
# WebKit only checks that the variable is set, so it is left out entirely when not wanted.
[ "${FOLIO_SMOKE_NO_SANDBOX:-1}" = 1 ] && envs+=(-e WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1)
echo "smoke-distro: $image with $engine"
exec "$engine" run --rm "${mounts[@]}" "${envs[@]}" "$image" bash -c "$inner"
