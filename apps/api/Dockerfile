# ---------- Builder ----------
FROM node:24-alpine AS build

ENV APP_NAME="api"
WORKDIR /usr/src/app

ENV HUSKY=0

COPY . .

RUN corepack enable && \
    pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm run build:packages && \
    pnpm run build --no-cache --filter="*$APP_NAME"

# ---------- Runner ----------
FROM node:24-alpine AS run

ARG APP_VERSION=dev
ENV API_VERSION=${APP_VERSION}

ENV WORKDIR=/usr/src/app
ENV APP_NAME="api"
ENV HTTP_PORT=5000

WORKDIR $WORKDIR

RUN apk add --update python3 make g++ curl

COPY --from=build $WORKDIR/pnpm-workspace.yaml ./
COPY --from=build $WORKDIR/pnpm-lock.yaml ./
COPY --from=build $WORKDIR/package.json ./

COPY --from=build $WORKDIR/node_modules ./node_modules/
COPY --from=build $WORKDIR/packages ./packages/
COPY --from=build $WORKDIR/apps/$APP_NAME/package.json ./apps/$APP_NAME/
COPY --from=build $WORKDIR/apps/$APP_NAME/dist ./apps/$APP_NAME/dist/
COPY --from=build $WORKDIR/apps/$APP_NAME/node_modules ./apps/$APP_NAME/node_modules/

# For seeds
COPY --from=build $WORKDIR/apps/$APP_NAME/src ./apps/$APP_NAME/src/
#RUN find ./packages -mindepth 2 -maxdepth 2 \
#  ! -name dist \
#  ! -name node_modules \
#  ! -name package.json \
#  -exec rm -rf {} +

RUN corepack enable && pnpm --version

EXPOSE $HTTP_PORT

CMD ["node", "apps/api/dist/main.js"]
