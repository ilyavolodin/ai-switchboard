# syntax=docker/dockerfile:1
#
# Build from the repository root:
#
#   docker build -f deploy/Dockerfile \
#     --build-arg SWITCHBOARD_PLUGINS="@acme/switchboard-source-jira@^1" \
#     --secret id=npmrc,src=$HOME/.npmrc .     # optional, for private registries

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --parents packages/*/package.json plugins/*/package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# `deploy` mounts the same store cache as the install, or it re-downloads every dependency.
#
# The CLI is not deployed separately (that would be a second copy of the core). Its built files go
# to /out/core/cli with no package.json, so `@ai-switchboard/core` resolves by self-reference and
# the rest from the core's node_modules. CLI-only deps are copied in and must be dependency-free.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ai-switchboard/core deploy --prod --legacy /out/core \
 && cp -R packages/cli/dist /out/core/cli \
 && find /out/core/cli \( -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
 && extras=$(node -e ' \
      const cli = require("./packages/cli/package.json").dependencies; \
      const core = require("./packages/core/package.json").dependencies; \
      for (const d of Object.keys(cli)) if (d !== "@ai-switchboard/core" && !(d in core)) console.log(d);') \
 && for dep in $extras; do \
      src="packages/cli/node_modules/$dep"; \
      if node -e 'const p = require(process.argv[1]); process.exit(Object.keys(p.dependencies ?? {}).length ? 1 : 0)' "$PWD/$src/package.json"; then \
        mkdir -p "/out/core/node_modules/$(dirname "$dep")" && cp -RL "$src" "/out/core/node_modules/$dep"; \
      else \
        echo "CLI dependency $dep has dependencies of its own; add it to the core or extend this step" >&2; exit 1; \
      fi; \
    done \
 && node /out/core/cli/main.js --version \
 && node /out/core/cli/main.js plugins list --home /tmp/switchboard-check

ARG SWITCHBOARD_PLUGINS=""
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    mkdir -p /opt/switchboard/plugins \
 && for spec in $SWITCHBOARD_PLUGINS; do \
      echo "installing plugin $spec"; \
      node /out/core/cli/main.js plugins add "$spec" --home /opt/switchboard || exit 1; \
    done

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=1.0.0
LABEL org.opencontainers.image.title="AI Switchboard" \
      org.opencontainers.image.description="Turn events from the systems a team already runs into controlled invocations of the automations they already have." \
      org.opencontainers.image.source="https://github.com/ai-switchboard/switchboard" \
      org.opencontainers.image.url="https://github.com/ai-switchboard/switchboard" \
      org.opencontainers.image.documentation="https://github.com/ai-switchboard/switchboard/tree/main/docs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="AI Switchboard" \
      org.opencontainers.image.version="${VERSION}"

# tini reaps children and forwards signals so the server shuts down cleanly on SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 switchboard \
 && useradd --system --uid 10001 --gid switchboard --home-dir /opt/switchboard --shell /usr/sbin/nologin switchboard

COPY --from=build --chown=10001:10001 /out/core /app/core
COPY --from=build --chown=10001:10001 /opt/switchboard /opt/switchboard
RUN chmod +x /app/core/cli/main.js \
 && ln -s /app/core/cli/main.js /usr/local/bin/switchboard

ENV NODE_ENV=production \
    SWITCHBOARD_HOME=/opt/switchboard \
    SWITCHBOARD_UI_DIR=/app/core/public \
    HOST=0.0.0.0 \
    PORT=8080

USER 10001:10001
WORKDIR /app/core
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
