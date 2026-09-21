// Command worker processes pending Tasklane tasks.
//
//	worker             poll the queue; serve /healthz and /metrics on $METRICS_PORT (default 9090)
//	worker healthcheck probe its own /healthz (for Docker HEALTHCHECK)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"example.com/tasklane/internal/metrics"
	"example.com/tasklane/internal/probe"
	"example.com/tasklane/internal/store"
)

var version = "dev"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("svc", "worker", "version", version)
	port := env("METRICS_PORT", "9090")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		probe.Run("http://127.0.0.1:" + port + "/healthz")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	db, err := store.Open(ctx)
	if err != nil {
		log.Error("database config invalid", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	host, _ := os.Hostname()
	workMs, _ := strconv.Atoi(env("WORK_DURATION_MS", "2000"))
	pollMs, _ := strconv.Atoi(env("POLL_INTERVAL_MS", "1000"))

	reg := metrics.New()
	reg.Counter("tasklane_tasks_processed_total", "Tasks completed by this worker.")
	reg.Counter("tasklane_worker_errors_total", "Database errors seen by this worker.")

	// lastLoop is the liveness signal: if the poll loop wedges, /healthz
	// starts failing and the kubelet restarts the container.
	var lastLoop atomic.Int64
	lastLoop.Store(time.Now().Unix())
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if time.Since(time.Unix(lastLoop.Load(), 0)) > 60*time.Second {
			http.Error(w, "poll loop stalled", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})
	mux.Handle("GET /metrics", reg)
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics server failed", "err", err)
		}
	}()

	log.Info("worker started", "work_ms", workMs, "poll_ms", pollMs)
	for ctx.Err() == nil {
		lastLoop.Store(time.Now().Unix())
		t, err := db.Claim(ctx, host)
		switch {
		case errors.Is(err, store.ErrNoTask):
			sleep(ctx, time.Duration(pollMs)*time.Millisecond)
			continue
		case err != nil:
			if ctx.Err() == nil {
				reg.Inc("tasklane_worker_errors_total", "")
				log.Warn("claim failed, retrying", "err", err)
			}
			sleep(ctx, 2*time.Second)
			continue
		}
		log.Info("processing", "task", t.ID, "title", t.Title)
		if !sleep(ctx, time.Duration(workMs)*time.Millisecond) {
			// Interrupted by SIGTERM mid-task: hand the task back so another
			// replica picks it up, instead of leaving it stuck "processing".
			rc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := db.Release(rc, t.ID); err != nil {
				log.Error("release failed", "task", t.ID, "err", err)
			}
			cancel()
			break
		}
		if err := db.Complete(ctx, t.ID); err != nil {
			log.Error("complete failed", "task", t.ID, "err", err)
			continue
		}
		reg.Inc("tasklane_tasks_processed_total", "")
		log.Info("done", "task", t.ID)
	}

	log.Info("shutdown signal received, stopping")
	sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(sc)
	log.Info("stopped")
}

// sleep waits for d and reports false if ctx was cancelled first.
func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
