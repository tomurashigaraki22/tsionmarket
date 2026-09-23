FROM node:22.14.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22.14.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S tsionmarket && adduser -S tsionmarket -G tsionmarket
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER tsionmarket
EXPOSE 3030
CMD ["node", "dist/index.js"]
