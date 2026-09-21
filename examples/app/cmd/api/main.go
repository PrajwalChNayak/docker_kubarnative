// Command api is the Tasklane HTTP API.
//
//	api            serve HTTP on $PORT (default 8080)
//	api migrate    create or upgrade the schema, then exit
//	api healthcheck probe http://127.0.0.1:$PORT/healthz (for Docker HEALTHCHECK)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"example.com/tasklane/internal/metrics"
	"example.com/tasklane/internal/probe"
	"example.com/tasklane/internal/store"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("svc", "api", "version", version)
	port := env("PORT", "8080")

	mode := "serve"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "healthcheck":
		probe.Run("http://127.0.0.1:" + port + "/healthz")
	case "migrate":
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := migrate(ctx); err != nil {
			log.Error("migration failed", "err", err)
			os.Exit(1)
		}
		log.Info("migration complete")
		return
	case "serve":
	default:
		log.Error("unknown mode", "mode", mode)
		os.Exit(2)
	}

	// SIGTERM is what docker stop and the kubelet send first. NotifyContext
	// turns it into a cancelled context so we can drain in-flight requests.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	db, err := store.Open(ctx)
	if err != nil {
		log.Error("database config invalid", "err", err)
		os.Exit(1)
	}
	defer db.Close()
	if env("MIGRATE_ON_START", "false") == "true" {
		if err := db.Migrate(ctx); err != nil {
			log.Error("migration failed", "err", err)
			os.Exit(1)
		}
	}

	reg := metrics.New()
	reg.Counter("tasklane_http_requests_total", "HTTP requests by method and status code.")
	reg.Counter("tasklane_tasks_created_total", "Tasks accepted by the API.")
	reg.Gauge("tasklane_tasks_pending", "Tasks waiting for a worker.", func() float64 {
		c, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		n, err := db.Pending(c)
		if err != nil {
			return -1
		}
		return float64(n)
	})

	host, _ := os.Hostname()
	var draining atomic.Bool
	mux := http.NewServeMux()

	// Liveness: "is this process able to serve at all?" It must NOT check the
	// database, or a database outage would make Kubernetes restart every API
	// pod in a loop.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n"))
	})
	// Readiness: "should traffic be sent here right now?" Fails while the
	// database is unreachable and while shutting down.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if draining.Load() {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		c, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := db.Ping(c); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ready\n"))
	})
	mux.Handle("GET /metrics", reg)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]string{"service": "tasklane-api", "version": version, "host": host})
	})
	mux.HandleFunc("GET /tasks", func(w http.ResponseWriter, r *http.Request) {
		tasks, err := db.List(r.Context(), 50)
		if err != nil {
			log.Error("list tasks", "err", err)
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, 200, tasks)
	})
	mux.HandleFunc("POST /tasks", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil ||
			strings.TrimSpace(in.Title) == "" || len(in.Title) > 200 {
			http.Error(w, `body must be {"title": "1-200 chars"}`, http.StatusBadRequest)
			return
		}
		t, err := db.Create(r.Context(), strings.TrimSpace(in.Title))
		if err != nil {
			log.Error("create task", "err", err)
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		reg.Inc("tasklane_tasks_created_total", "")
		writeJSON(w, http.StatusCreated, t)
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           countRequests(reg, mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	// Fail readiness first and wait briefly, so load balancers and
	// EndpointSlices stop routing new requests before we close listeners.
	draining.Store(true)
	delay, _ := strconv.Atoi(env("SHUTDOWN_DELAY_SECONDS", "5"))
	log.Info("shutdown signal received, draining", "delay_seconds", delay)
	time.Sleep(time.Duration(delay) * time.Second)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown incomplete", "err", err)
	}
	log.Info("stopped")
}

func migrate(ctx context.Context) error {
	db, err := store.Open(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	// Retry while the database is still starting (Compose, Kubernetes Jobs).
	for i := 0; ; i++ {
		if err = db.Migrate(ctx); err == nil || i == 20 {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(2 * time.Second):
		}
	}
}

type recorder struct {
	http.ResponseWriter
	code int
}

func (r *recorder) WriteHeader(c int) { r.code = c; r.ResponseWriter.WriteHeader(c) }

func countRequests(reg *metrics.Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &recorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(rec, r)
		reg.Inc("tasklane_http_requests_total",
			`method="`+r.Method+`",code="`+strconv.Itoa(rec.code)+`"`)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
