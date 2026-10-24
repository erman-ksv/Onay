# syntax=docker/dockerfile:1
# Staging image includes the locked build and migration tools.
FROM node:22-bookworm-slim
ARG PNPM_VERSION=10.34.8
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY . .
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --filter @workspace/api-server...
RUN pnpm --filter @workspace/api-server run build
RUN chown -R node:node /opt/corepack
ENV NODE_ENV=production PORT=8080 TEZJET_STORAGE_ADAPTER=postgres REQUIRE_DRIVER_APPROVAL=true
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/healthz',{signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "deploy/onay/entrypoint.mjs"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
