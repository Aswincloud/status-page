# Home speed agent: Node 22 + the official Ookla speedtest CLI.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# Ookla CLI needs these; arch is auto-detected so the image works on x86_64 + arm64.
RUN apk add --no-cache ca-certificates tar wget \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64)  PKG=x86_64 ;; \
      aarch64) PKG=aarch64 ;; \
      armv7l)  PKG=armhf ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && wget -qO /tmp/st.tgz "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-${PKG}.tgz" \
 && tar xzf /tmp/st.tgz -C /usr/local/bin speedtest \
 && rm /tmp/st.tgz \
 && speedtest --version

WORKDIR /app
COPY package.json agent.js ./

USER node
CMD ["node", "agent.js"]
