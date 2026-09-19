FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /signaling .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /signaling /signaling
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/signaling"]
