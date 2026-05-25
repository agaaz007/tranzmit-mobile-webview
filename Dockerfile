FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm install --workspace=packages/server --workspace=packages/shared
COPY tsconfig.json ./
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
EXPOSE 3000
CMD ["npx", "tsx", "packages/server/src/index.ts"]
