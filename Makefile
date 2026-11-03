.PHONY: build backend web test check
build: backend web
backend:
	mkdir -p dist
	go build -o dist/herdr-bridge-server ./server
	go build -o dist/herdr-bridge ./client
web:
	npm --prefix web-ui run build
test:
	go test -race ./...
	npm --prefix web-ui test
check: test build
