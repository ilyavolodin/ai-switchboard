# syntax=docker/dockerfile:1
#
# The integration stub: an `http` executor target, a webhook sender, a fake Claude Routines API
# and a request recorder. Dependency-free; see deploy/stub/server.js.
#
#   docker build -t ghcr.io/ai-switchboard/switchboard-stub:1.0.0 deploy/stub
FROM node:24-alpine
LABEL org.opencontainers.image.title="AI Switchboard stub" \
      org.opencontainers.image.description="Test stub for AI Switchboard: executor target, webhook sender, fake Routines API." \
      org.opencontainers.image.source="https://github.com/ai-switchboard/switchboard" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /stub
COPY package.json server.js ./
ENV STUB_PORT=9090 NODE_ENV=production
USER node
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.STUB_PORT || 9090) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
