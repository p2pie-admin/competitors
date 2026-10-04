# --- build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn config set network-timeout 300000 -g && yarn install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build && ls build

# --- runtime ---
FROM node:20-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    COMPETITORS_PORT=5100
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn config set network-timeout 300000 -g && yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=build /app/build ./build
COPY seed ./seed
# SQLite lives in the volume; owned by the unprivileged user so the first-created volume is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5100/health || exit 1
CMD ["node", "build/index.js"]
