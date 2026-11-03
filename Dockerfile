# Each image is built on a runner matching its target architecture; no QEMU.
FROM node:24.15.0-alpine AS web
WORKDIR /src/web-ui
COPY web-ui/package.json web-ui/package-lock.json ./
COPY web-ui/vendor ./vendor
RUN npm ci
COPY web-ui/ ./
COPY contracts/bridge/vectors.json /src/contracts/bridge/vectors.json
RUN npm run build

FROM golang:1.25.9-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/herdr-bridge-server ./server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 bridge && adduser -S -D -H -u 10001 -G bridge bridge
WORKDIR /app
COPY --from=server /out/herdr-bridge-server /usr/local/bin/herdr-bridge-server
COPY --from=web /src/web-ui/dist /app/web-ui/dist
COPY deploy/server.yaml /etc/herdr-bridge/server.yaml
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/herdr-bridge-server"]
CMD ["--config", "/etc/herdr-bridge/server.yaml"]
