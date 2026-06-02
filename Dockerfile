FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json
RUN npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
RUN addgroup -S flyoverhead && adduser -S -G flyoverhead flyoverhead
USER flyoverhead
ENTRYPOINT ["node", "dist/index.js"]
CMD ["run"]
