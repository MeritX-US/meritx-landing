# MeritX private pilot -- separate image from the public demo (app/).
FROM node:20-alpine AS build
WORKDIR /pilot
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

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
