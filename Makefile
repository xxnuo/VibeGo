.PHONY: generate-docs

generate-docs:
	@echo "Generating docs..."
	@GOOS= GOARCH= go run github.com/swaggo/swag/cmd/swag@latest init -g main.go -o ./internal/docs
	@echo "Docs generated successfully"

clean-code:
	find . -type f \( -name "*.go" -o -name "*.html" -o -name "*.md" \) -exec perl -CSDA -i -pe 's/\p{Extended_Pictographic} //g' {} +

format:
	gofmt -w .
	cd ui && pnpm format