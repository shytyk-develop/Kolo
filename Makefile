# local backend in docker: make up (fast, no rebuild), make rebuild (after backend changes)
COMPOSE = docker compose --progress quiet -f infra/docker-compose.yml

.PHONY: up rebuild down logs ps

up:  ## start everything with the images we have, wait until the api answers
	@start=$$(date +%s); $(COMPOSE) up -d --wait --wait-timeout 90 && \
	  echo "kolo api up in $$(( $$(date +%s) - start ))s → http://localhost:8000/health"

rebuild:  ## rebuild the api image (deps stay cached unless pyproject/uv.lock changed), then up
	@$(COMPOSE) build api && $(MAKE) --no-print-directory up

down:
	@$(COMPOSE) down

logs:
	@$(COMPOSE) logs -f --tail 100 api

ps:
	@$(COMPOSE) ps
