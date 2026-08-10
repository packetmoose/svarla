# MediaBridge standalone build
# Produces a single static binary with no external dependencies.

FROM golang:1.24-alpine AS builder

ARG TARGETARCH

WORKDIR /build

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Build static binary
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -ldflags="-s -w" -o /mediabridge ./cmd/mediabridge

# Runtime image — distroless for minimal attack surface
FROM gcr.io/distroless/static-debian12

COPY --from=builder /mediabridge /mediabridge
COPY mediabridge-config.yaml /mediabridge-config.yaml

WORKDIR /

EXPOSE 10443/tcp
EXPOSE 10443/udp
EXPOSE 5060/udp
EXPOSE 5060/tcp
EXPOSE 5061/tcp
EXPOSE 5062/udp
EXPOSE 9091/tcp

ENTRYPOINT ["/mediabridge", "-config", "/mediabridge-config.yaml"]
