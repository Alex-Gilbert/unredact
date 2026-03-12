# Stage 1: Build WASM + assemble static site
FROM rust:1.87-bookworm AS builder

RUN cargo install wasm-pack

WORKDIR /src
COPY unredact-wasm/ unredact-wasm/
COPY unredact/static/ unredact/static/
COPY unredact/data/ unredact/data/
COPY scripts/build-static.sh scripts/build-static.sh

RUN bash scripts/build-static.sh

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY --from=builder /src/dist/ /usr/share/nginx/html/

EXPOSE 80
