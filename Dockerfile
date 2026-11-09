FROM node:20-alpine AS client
WORKDIR /src/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
WORKDIR /src/server
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/server/target/release/office /usr/local/bin/office
COPY --from=client /src/client/dist /app/dist
COPY assets /app/assets
WORKDIR /app
ENV DIST_DIR=/app/dist
ENV ASSETS_DIR=/app/assets
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
CMD ["office"]
