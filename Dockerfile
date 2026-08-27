# TypeScript output is architecture-independent. Keep dependency installation and
# compilation on the native builder so cross-platform releases never execute npm
# under QEMU; only the small runtime stage targets the requested architecture.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache \
  && addgroup -S -g 10001 dryrun && adduser -S -D -H -u 10001 -G dryrun dryrun \
  && mkdir -p /data && chown dryrun:dryrun /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=dryrun:dryrun /app/dist ./dist
USER dryrun
VOLUME ["/data"]
EXPOSE 4320
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
