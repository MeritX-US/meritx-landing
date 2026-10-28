# MeritX private pilot -- separate image from the public demo (app/).
FROM node:20-alpine AS build
WORKDIR /pilot
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
# dist = src only: that is all the shipped image gets. dist-test additionally holds the
# compiled tests, which never enter the image; CI copies the synthetic-fixture builder out
# of this stage (see ci/docker-destroy-case.sh).
RUN npm run build && npm run build:tests && npm prune --omit=dev \
 && test -f dist/src/scripts/destroy-case.js && test -f dist/src/scripts/verify-access-log.js \
 && test ! -e dist/test

# Last stage = default build target, so a plain `docker build` (and Render) can only ever
# produce the production image.
FROM node:20-alpine
ENV NODE_ENV=production PRIVATE_MODE=true PORT=3101 PILOT_DATA_DIR=/data
WORKDIR /pilot
COPY --from=build /pilot/node_modules ./node_modules
COPY --from=build /pilot/dist ./dist
COPY package.json ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3101
CMD ["node", "dist/src/server.js"]
