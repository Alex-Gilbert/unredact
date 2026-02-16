.PHONY: build build-solver run stop restart solver app logs status clean dev kill

SOLVER_BIN  = solver_rs/target/release/unredact-solver
SOLVER_PORT ?= 3100
APP_PORT    ?= 8000
DATA_DIR    = $(CURDIR)/unredact/data
PID_DIR     = .pids
VENV        = .venv/bin
PYTHON      = $(VENV)/python
UVICORN     = $(VENV)/uvicorn

$(PID_DIR):
	mkdir -p $(PID_DIR)

# ── Build ──

build-solver:
	cd solver_rs && cargo build --release

build: build-solver

# ── Run (background, use `make logs` to see output) ──

solver: $(PID_DIR) build-solver
	@if [ -f $(PID_DIR)/solver.pid ] && kill -0 $$(cat $(PID_DIR)/solver.pid) 2>/dev/null; then \
		echo "Solver already running (pid $$(cat $(PID_DIR)/solver.pid))"; \
	else \
		SOLVER_PORT=$(SOLVER_PORT) DATA_DIR=$(DATA_DIR) $(SOLVER_BIN) > $(PID_DIR)/solver.log 2>&1 & \
		echo $$! > $(PID_DIR)/solver.pid; \
		sleep 0.5; \
		if kill -0 $$(cat $(PID_DIR)/solver.pid) 2>/dev/null; then \
			echo "Solver started on :$(SOLVER_PORT) (pid $$(cat $(PID_DIR)/solver.pid))"; \
		else \
			echo "Solver failed to start. Check $(PID_DIR)/solver.log"; \
			cat $(PID_DIR)/solver.log; \
			exit 1; \
		fi \
	fi

app: $(PID_DIR) solver
	@if [ -f $(PID_DIR)/app.pid ] && kill -0 $$(cat $(PID_DIR)/app.pid) 2>/dev/null; then \
		echo "App already running (pid $$(cat $(PID_DIR)/app.pid))"; \
	else \
		SOLVER_URL=http://127.0.0.1:$(SOLVER_PORT) \
		$(UVICORN) unredact.app:app --host 0.0.0.0 --port $(APP_PORT) > $(PID_DIR)/app.log 2>&1 & \
		echo $$! > $(PID_DIR)/app.pid; \
		sleep 1; \
		if kill -0 $$(cat $(PID_DIR)/app.pid) 2>/dev/null; then \
			echo "App started on :$(APP_PORT) (pid $$(cat $(PID_DIR)/app.pid))"; \
		else \
			echo "App failed to start. Check $(PID_DIR)/app.log"; \
			cat $(PID_DIR)/app.log; \
			exit 1; \
		fi \
	fi

# ── Run with live logs (foreground, Ctrl-C stops everything) ──

run: $(PID_DIR) build-solver
	@SOLVER_PORT=$(SOLVER_PORT) DATA_DIR=$(DATA_DIR) $(SOLVER_BIN) > $(PID_DIR)/solver.log 2>&1 & \
	echo $$! > $(PID_DIR)/solver.pid; \
	sleep 0.5; \
	if ! kill -0 $$(cat $(PID_DIR)/solver.pid) 2>/dev/null; then \
		echo "Solver failed to start:"; cat $(PID_DIR)/solver.log; exit 1; \
	fi; \
	echo "Solver started on :$(SOLVER_PORT) (pid $$(cat $(PID_DIR)/solver.pid))"; \
	SOLVER_URL=http://127.0.0.1:$(SOLVER_PORT) \
	$(UVICORN) unredact.app:app --host 0.0.0.0 --port $(APP_PORT) > $(PID_DIR)/app.log 2>&1 & \
	echo $$! > $(PID_DIR)/app.pid; \
	sleep 1; \
	if ! kill -0 $$(cat $(PID_DIR)/app.pid) 2>/dev/null; then \
		echo "App failed to start:"; cat $(PID_DIR)/app.log; exit 1; \
	fi; \
	echo "App started on :$(APP_PORT) (pid $$(cat $(PID_DIR)/app.pid))"; \
	echo "Running at http://localhost:$(APP_PORT)  (Ctrl-C to stop)"; \
	echo ""; \
	trap 'echo ""; echo "Shutting down..."; \
		kill $$(cat $(PID_DIR)/solver.pid) $$(cat $(PID_DIR)/app.pid) 2>/dev/null; \
		rm -f $(PID_DIR)/solver.pid $(PID_DIR)/app.pid; \
		echo "Stopped."; exit 0' INT TERM; \
	tail -f $(PID_DIR)/solver.log $(PID_DIR)/app.log

# ── Stop ──

stop-solver:
	@if [ -f $(PID_DIR)/solver.pid ]; then \
		kill $$(cat $(PID_DIR)/solver.pid) 2>/dev/null && echo "Solver stopped" || echo "Solver not running"; \
		rm -f $(PID_DIR)/solver.pid; \
	else \
		echo "No solver pid file"; \
	fi

stop-app:
	@if [ -f $(PID_DIR)/app.pid ]; then \
		kill $$(cat $(PID_DIR)/app.pid) 2>/dev/null && echo "App stopped" || echo "App not running"; \
		rm -f $(PID_DIR)/app.pid; \
	else \
		echo "No app pid file"; \
	fi

stop: stop-app stop-solver

kill:
	@echo "Killing processes on ports $(APP_PORT) and $(SOLVER_PORT)..."
	@fuser -k $(APP_PORT)/tcp 2>/dev/null && echo "Killed port $(APP_PORT)" || echo "Port $(APP_PORT) free"
	@fuser -k $(SOLVER_PORT)/tcp 2>/dev/null && echo "Killed port $(SOLVER_PORT)" || echo "Port $(SOLVER_PORT) free"
	@rm -f $(PID_DIR)/solver.pid $(PID_DIR)/app.pid

restart: stop run

# ── Status / Logs ──

status:
	@echo "── Solver ──"
	@if [ -f $(PID_DIR)/solver.pid ] && kill -0 $$(cat $(PID_DIR)/solver.pid) 2>/dev/null; then \
		echo "  Running (pid $$(cat $(PID_DIR)/solver.pid))"; \
	else \
		echo "  Stopped"; \
	fi
	@echo "── App ──"
	@if [ -f $(PID_DIR)/app.pid ] && kill -0 $$(cat $(PID_DIR)/app.pid) 2>/dev/null; then \
		echo "  Running (pid $$(cat $(PID_DIR)/app.pid))"; \
	else \
		echo "  Stopped"; \
	fi

logs:
	@tail -f $(PID_DIR)/solver.log $(PID_DIR)/app.log 2>/dev/null

# ── Clean ──

clean: stop
	rm -rf $(PID_DIR)
	cd solver_rs && cargo clean

# ── Test ──

build-associates:
	$(PYTHON) scripts/build_associates.py

test: solver
	$(PYTHON) -m pytest tests/ --ignore=tests/test_alignment.py -v
