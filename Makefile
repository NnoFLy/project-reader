.DEFAULT_GOAL := help

PNPM ?= pnpm
DOCKER ?= docker
COMPOSE ?= docker compose
IMAGE ?= vfs:local
RELEASE ?= development
PRODUCTION_HOST ?= localhost

.PHONY: help install dev test test-watch check check-watch lint format build preview quality \
        docker-build prod prod-down prod-logs clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies from the lockfile
	$(PNPM) install --frozen-lockfile

dev: ## Start the development server
	$(PNPM) dev

test: ## Run the test suite
	$(PNPM) test

test-watch: ## Run tests in watch mode
	$(PNPM) exec vitest --watch

check: ## Run Svelte, TypeScript, and module-boundary checks
	$(PNPM) check

check-watch: ## Run Svelte checks in watch mode
	$(PNPM) run check:watch

lint: ## Check formatting and lint the project
	$(PNPM) lint

format: ## Format the project
	$(PNPM) format

build-preview: build preview

build: ## Build the production bundle
	$(PNPM) build

preview: ## Preview the production bundle locally
	$(PNPM) preview --host

quality: test check build lint ## Run the local CI quality checks

docker-build: ## Build the production Docker image
	DOCKER_BUILDKIT=1 $(DOCKER) build --build-arg RELEASE="$(RELEASE)" --tag "$(IMAGE)" .

prod: docker-build ## Build and start the production container locally
	PRODUCTION_HOST="$(PRODUCTION_HOST)" DEPLOY_IMAGE="$(IMAGE)" $(COMPOSE) up --detach --wait

prod-down: ## Stop the local production container
	PRODUCTION_HOST="$(PRODUCTION_HOST)" DEPLOY_IMAGE="$(IMAGE)" $(COMPOSE) down

prod-logs: ## Follow local production container logs
	PRODUCTION_HOST="$(PRODUCTION_HOST)" DEPLOY_IMAGE="$(IMAGE)" $(COMPOSE) logs --follow web

clean: ## Remove generated build output
	rm -rf .svelte-kit dist
