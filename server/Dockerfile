FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY shared ./shared
COPY server/package*.json ./server/
RUN npm --prefix shared install --ignore-scripts && npm --prefix shared run build
RUN npm --prefix server install
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
RUN npm --prefix server run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY shared/package.json ./shared/package.json
COPY --from=build /workspace/shared/dist ./shared/dist
COPY server/package*.json ./server/
RUN npm --prefix server install --omit=dev
COPY --from=build /workspace/server/dist ./server/dist
USER node
EXPOSE 2567
CMD ["node", "server/dist/index.js"]
