# Umbrel Wine image: LinuxServer Selkies desktop + Wine 11.0 (WoW64) + launcher.
#
# MUST be built as a multi-arch manifest list for linux/amd64 AND linux/arm64.
# umbrelOS runs on exactly those two arches, the official app linter hard-errors
# on a single-arch image, and compose pins the *index* digest, which only exists
# for a manifest list. Build and publish with:
#
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/cooperwang-py/umbrel-wine:0.2.3 \
#     --push image/
#   docker buildx imagetools inspect ghcr.io/cooperwang-py/umbrel-wine:0.2.3
#
# Then copy the reported index digest into umbrel-wine-desktop/docker-compose.yml
# as ghcr.io/cooperwang-py/umbrel-wine:0.2.3@sha256:<index-digest>.
#
# The base is pinned by its index digest too, from:
#   docker buildx imagetools inspect ghcr.io/linuxserver/baseimage-selkies:debiantrixie
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie@sha256:d75c1d5a188e9b447785fc34b0e56d4d7ff120bdc4ba6d4be22ec4ce4b231758

ARG TARGETARCH

# One x86_64 Wine build for both arches. New WoW64 runs 32-bit and 64-bit .exe
# files without i386 multiarch, and it is the build type box64's docs/WINE.md
# recommends. arm64 runs it under box64.
ARG WINE_URL=https://github.com/Kron4ek/Wine-Builds/releases/download/11.0/wine-11.0-amd64-wow64.tar.xz
ARG WINE_SHA256=39574efa1132c3ca0d5c77dd2eddbe4a49cca0d6cc2c290ff4924493a1c40314
# Add-ons are pre-seeded so creating a prefix never needs the network. Wine 11.0
# asks for mono 10.4.1 (dlls/appwiz.cpl/addons.c), and a WoW64 prefix installs
# both gecko arches.
ARG MONO_URL=https://dl.winehq.org/wine/wine-mono/10.4.1/wine-mono-10.4.1-x86.tar.xz
ARG MONO_SHA256=a16606ef0724202e6a6848ece6e0cbba64d11e2f11aefe744af1d93c6d9f99bb
ARG GECKO32_URL=https://dl.winehq.org/wine/wine-gecko/2.47.4/wine-gecko-2.47.4-x86.tar.xz
ARG GECKO32_SHA256=2cfc8d5c948602e21eff8a78613e1826f2d033df9672cace87fed56e8310afb6
ARG GECKO64_URL=https://dl.winehq.org/wine/wine-gecko/2.47.4/wine-gecko-2.47.4-x86_64.tar.xz
ARG GECKO64_SHA256=fd88fc7e537d058d7a8abf0c1ebc90c574892a466de86706a26d254710a82814
# Oldest acceptable box64 build: includes the 16K-page Wine mmap fix (box64
# PR #4187) and the in-Docker wineserver path fix (#3813).
ARG BOX64_MIN_DATE=20260926
# The third-party box64 apt repo's signing key (Ryan Fortner). The key is
# fetched at build time, so its fingerprint is checked before it is trusted:
# a swapped key (compromised repo or hosting) fails the build instead of
# silently signing whatever box64 binary ships next.
ARG BOX64_KEY_FPR=DF9A1B8523C32EEEFF2A6CDA7759FA1D9FECAC9E

# Baked in so the Umbrel package and tools/dev-stack.yml behave identically.
# START_DOCKER: the base defaults to starting its bundled Docker daemon.
# DISABLE_SUDO: uploaded .exe files run as `abc`, which the base grants
#   passwordless sudo; left on, any uploaded binary would be root in here.
# SELKIES_FILE_TRANSFERS: uploads go through the launcher; Selkies still offers
#   downloads of files that programs produce.
# SELKIES_USE_CSS_SCALING: size the remote desktop in CSS pixels instead of
#   device pixels. With the base's HiDPI default a 2x screen made the session
#   render and encode 4x the pixels (and Windows programs looked tiny at 96
#   DPI). The HiDPI switch stays in the Selkies sidebar for sharper text.
# SELKIES_ENCODER: the base's menu plus striped H.264, which encodes one stripe
#   per CPU core and only the stripes that changed; it can beat full-frame
#   H.264 on CPU-only hosts such as a Raspberry Pi. h264enc stays the default.
ENV TITLE=Wine \
    SUBFOLDER=/desktop/ \
    PIXELFLUX_WAYLAND=false \
    START_DOCKER=false \
    DISABLE_SUDO=true \
    SELKIES_FILE_TRANSFERS=download \
    FILE_MANAGER_PATH=/config/drives \
    SELKIES_USE_CSS_SCALING=true \
    SELKIES_ENCODER="h264enc,h264enc-striped,h265enc,vp8enc,vp9enc,av1enc,jpeg"

# Native libraries Wine links on amd64 and box64 wraps on arm64.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg xz-utils cabextract fonts-liberation \
        libfreetype6 libfontconfig1 libgnutls30t64 libasound2t64 libpulse0 \
        libgl1 libglx-mesa0 libegl1 libosmesa6 libvulkan1 mesa-vulkan-drivers \
        libx11-6 libxext6 libxrandr2 libxrender1 libxi6 libxcursor1 \
        libxcomposite1 libxinerama1 libxfixes3 libxxf86vm1 libxkbcommon0 \
        libdbus-1-3 libsdl2-2.0-0 libunwind8 libcups2t64 libkrb5-3 \
        libgstreamer-plugins-base1.0-0; \
    if [ "$TARGETARCH" = "arm64" ]; then \
        curl -fsSL -o /tmp/box64.gpg https://ryanfortner.github.io/box64-debs/KEY.gpg; \
        fpr=$(gpg --show-keys --with-colons /tmp/box64.gpg | awk -F: '$1 == "fpr" { print $10; exit }'); \
        [ "$fpr" = "$BOX64_KEY_FPR" ]; \
        gpg --dearmor -o /etc/apt/trusted.gpg.d/box64-debs-archive-keyring.gpg /tmp/box64.gpg; \
        rm /tmp/box64.gpg; \
        echo 'deb https://ryanfortner.github.io/box64-debs/debian ./' > /etc/apt/sources.list.d/box64.list; \
        apt-get update; \
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends box64; \
        d=$(dpkg-query -W -f='${Version}' box64 | sed -nE 's/.*\+([0-9]{8})\..*/\1/p'); \
        [ -n "$d" ] && [ "$d" -ge "$BOX64_MIN_DATE" ]; \
    fi; \
    curl -fsSL -o /tmp/wine.tar.xz "$WINE_URL"; \
    echo "$WINE_SHA256  /tmp/wine.tar.xz" | sha256sum -c; \
    tar -xJf /tmp/wine.tar.xz -C /opt; \
    mv /opt/wine-11.0-amd64-wow64 /opt/wine; \
    test -x /opt/wine/bin/wine && test -x /opt/wine/bin/wineserver; \
    curl -fsSL -o /tmp/mono.tar.xz "$MONO_URL"; \
    echo "$MONO_SHA256  /tmp/mono.tar.xz" | sha256sum -c; \
    curl -fsSL -o /tmp/gecko32.tar.xz "$GECKO32_URL"; \
    echo "$GECKO32_SHA256  /tmp/gecko32.tar.xz" | sha256sum -c; \
    curl -fsSL -o /tmp/gecko64.tar.xz "$GECKO64_URL"; \
    echo "$GECKO64_SHA256  /tmp/gecko64.tar.xz" | sha256sum -c; \
    mkdir -p /opt/wine/share/wine/mono /opt/wine/share/wine/gecko; \
    tar -xJf /tmp/mono.tar.xz -C /opt/wine/share/wine/mono; \
    tar -xJf /tmp/gecko32.tar.xz -C /opt/wine/share/wine/gecko; \
    tar -xJf /tmp/gecko64.tar.xz -C /opt/wine/share/wine/gecko; \
    test -d /opt/wine/share/wine/mono/wine-mono-10.4.1; \
    test -d /opt/wine/share/wine/gecko/wine-gecko-2.47.4-x86; \
    test -d /opt/wine/share/wine/gecko/wine-gecko-2.47.4-x86_64; \
    rm -rf /tmp/*.tar.xz /var/lib/apt/lists/*

# No USER, CMD or ENTRYPOINT: s6-overlay from the base image is the entrypoint
# and starts the desktop, nginx and the launcher (svc-umbrel-wine).
COPY root/ /
