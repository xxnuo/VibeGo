.PHONY: generate-docs clean-code format dev-server dev-ui build clean-dist build-frontend build-backend package-backend test-release-packaging verify-release build-release bump prepare-test test download-sherpa thirdparty verify-waveterm-reference

VERSION ?= $(shell git describe --tags --match 'v*' 2>/dev/null || echo v0.0.0-dev)
DIST_DIR ?= dist
ARTIFACTS_DIR ?= artifacts
BINARY_NAME ?= vibego
UI_DIR ?= ui
RELEASE_TARGETS ?= android/arm64 linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64
CURRENT_GOOS ?= $(shell go env GOOS)
CURRENT_GOARCH ?= $(shell go env GOARCH)
CGO_ENABLED ?= 1

generate-docs:
	@echo "Generating docs..."
	@GOOS= GOARCH= go run github.com/swaggo/swag/cmd/swag@latest init -g main.go -o ./internal/docs
	@echo "Docs generated successfully"

clean-code:
	find . -type f \( -name "*.go" -o -name "*.html" -o -name "*.md" \) -exec perl -CSDA -i -pe 's/\p{Extended_Pictographic} //g' {} +

format:
	gofmt -w .
	cd $(UI_DIR) && pnpm run check:fix

dev-server:
	air

dev-ui:
	cd ui && pnpm run dev --host

build:
	$(MAKE) clean-dist
	$(MAKE) build-frontend
	$(MAKE) build-backend GOOS=$(CURRENT_GOOS) GOARCH=$(CURRENT_GOARCH) VERSION=$(VERSION)
	$(MAKE) package-backend GOOS=$(CURRENT_GOOS) GOARCH=$(CURRENT_GOARCH) VERSION=$(VERSION)

download-sherpa:
	@bash scripts/download-sherpa.sh

clean-dist:
	@dist_dir="$(DIST_DIR)"; \
	if [ -z "$$dist_dir" ] || [ "$$dist_dir" = "/" ] || [ "$$dist_dir" = "." ] || [ "$$dist_dir" = ".." ]; then \
		echo "Refusing to clean unsafe DIST_DIR: $$dist_dir"; \
		exit 1; \
	fi; \
	mkdir -p "$$dist_dir"; \
	find "$$dist_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

build-frontend:
	cd $(UI_DIR) && pnpm install --frozen-lockfile
	cd $(UI_DIR) && pnpm run build

build-backend:
	@if [ -z "$(GOOS)" ] || [ -z "$(GOARCH)" ]; then \
		echo "GOOS and GOARCH are required"; \
		exit 1; \
	fi
	@mkdir -p $(DIST_DIR)
	@ext=""; \
	if [ "$(GOOS)" = "windows" ]; then ext=".exe"; fi; \
	output="$(BINARY_NAME)_$(VERSION)_$(GOOS)_$(GOARCH)$${ext}"; \
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "-s -w -X github.com/xxnuo/vibego/internal/version.Version=$(VERSION)" -o "$(DIST_DIR)/$${output}" ./

package-backend:
	@if [ -z "$(GOOS)" ] || [ -z "$(GOARCH)" ]; then \
		echo "GOOS and GOARCH are required"; \
		exit 1; \
	fi
	@mkdir -p $(ARTIFACTS_DIR)
	@bin="$(BINARY_NAME)_$(VERSION)_$(GOOS)_$(GOARCH)"; \
	if [ "$(GOOS)" = "windows" ]; then bin="$${bin}.exe"; fi; \
	tar_name="$${bin%.exe}.tar.gz"; \
	bash scripts/package_release_archive.sh "$(DIST_DIR)" "$(ARTIFACTS_DIR)/$${tar_name}" "$${bin}"

test-release-packaging:
	uv run python scripts/test_release_packages.py

verify-release:
	cd $(UI_DIR) && pnpm install --frozen-lockfile
	cd $(UI_DIR) && pnpm run lint
	cd $(UI_DIR) && pnpm run build
	go test ./...
	$(MAKE) test-release-packaging

build-release:
	$(MAKE) clean-dist
	$(MAKE) build-frontend
	@for target in $(RELEASE_TARGETS); do \
		goos="$${target%/*}"; \
		goarch="$${target#*/}"; \
		$(MAKE) build-backend GOOS=$${goos} GOARCH=$${goarch} VERSION=$(VERSION); \
		$(MAKE) package-backend GOOS=$${goos} GOARCH=$${goarch} VERSION=$(VERSION); \
	done

bump:
	@bash scripts/bump-version.sh $(filter-out $@,$(MAKECMDGOALS))

%:
	@:

TEST_REPO_DIR ?= testdata/repo
WAVETERM_DIR ?= thirdparty/waveterm
WAVETERM_REF ?= bea1949e47c60703b263e1bcd4633f40ee69db6e

prepare-test:
	@echo "Creating test git repository at $(TEST_REPO_DIR)..."
	@rm -rf $(TEST_REPO_DIR)
	@mkdir -p $(TEST_REPO_DIR)
	@cd $(TEST_REPO_DIR) && git init
	@cd $(TEST_REPO_DIR) && git config user.name "Test User"
	@cd $(TEST_REPO_DIR) && git config user.email "test@vibego.local"
	@cd $(TEST_REPO_DIR) && echo "# Test Repo" > README.md && git add README.md && git commit -m "initial commit"
	@cd $(TEST_REPO_DIR) && echo "package main" > main.go && git add main.go && git commit -m "add main.go"
	@cd $(TEST_REPO_DIR) && echo "hello" > hello.txt && git add hello.txt && git commit -m "add hello.txt"
	@cd $(TEST_REPO_DIR) && git checkout -b feature-a
	@cd $(TEST_REPO_DIR) && echo "feature a" > feature.txt && git add feature.txt && git commit -m "feature a work"
	@cd $(TEST_REPO_DIR) && git checkout main
	@cd $(TEST_REPO_DIR) && git checkout -b feature-b
	@cd $(TEST_REPO_DIR) && echo "feature b" > other.txt && git add other.txt && git commit -m "feature b work"
	@cd $(TEST_REPO_DIR) && git checkout main
	@cd $(TEST_REPO_DIR) && echo "modified" >> hello.txt
	@echo "Test repo ready at $(TEST_REPO_DIR)"
	@echo "  Branches: main, feature-a, feature-b"
	@echo "  Uncommitted change: hello.txt"

test:
	go test -v -count=1 ./internal/handler/ -run TestGit -timeout 120s

thirdparty:
	@mkdir -p thirdparty
	@if [ ! -d thirdparty/desktop/.git ]; then git clone --branch development https://github.com/desktop/desktop.git thirdparty/desktop; fi
	@if [ ! -d thirdparty/waveterm/.git ]; then git clone --branch main-legacy https://github.com/wavetermdev/waveterm.git thirdparty/waveterm; fi
	@$(MAKE) verify-waveterm-reference

verify-waveterm-reference:
	@test -d "$(WAVETERM_DIR)/.git" || (echo "$(WAVETERM_DIR) is not a Git checkout; run 'make thirdparty'" >&2; exit 1)
	@test "$$(git -C "$(WAVETERM_DIR)" rev-parse --abbrev-ref HEAD)" = "main-legacy" || (echo "WaveTerm checkout must be on main-legacy" >&2; exit 1)
	@test "$$(git -C "$(WAVETERM_DIR)" rev-parse HEAD)" = "$(WAVETERM_REF)" || (echo "WaveTerm checkout must be at $(WAVETERM_REF)" >&2; exit 1)
