# Tiny prober image: Node 22 on Alpine + iputils for real ICMP ping.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# iputils provides a ping that reports RTT and works with NET_RAW capability.
RUN apk add --no-cache iputils

WORKDIR /app
COPY package.json ./
COPY prober.js ./
COPY config.json ./

# Run as the built-in non-root node user.
USER node

CMD ["node", "prober.js"]
