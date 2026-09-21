// Package store holds all database access for Tasklane.
//
// Connection settings come from the standard libpq environment variables
// (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE), so the same
// binary works unchanged under docker run, Compose and Kubernetes: each
// platform only has to set environment variables.
package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Task is one unit of background work.
type Task struct {
	ID        int64      `json:"id"`
	Title     string     `json:"title"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	DoneAt    *time.Time `json:"done_at,omitempty"`
	Worker    *string    `json:"worker,omitempty"`
}

type Store struct{ pool *pgxpool.Pool }

// Open creates a connection pool. An empty connection string makes pgx read
// the PG* environment variables.
func Open(ctx context.Context) (*Store, error) {
	cfg, err := pgxpool.ParseConfig("")
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	// PGPASSWORD_FILE lets the password arrive as a mounted file (Compose
	// secrets, Kubernetes Secret volumes) instead of an environment variable,
	// which leaks into `docker inspect` and crash dumps.
	if f := os.Getenv("PGPASSWORD_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		cfg.ConnConfig.Password = strings.TrimSpace(string(b))
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Ping is used by the readiness endpoint.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate is idempotent, so it is safe to run from an init container, a Job
// or on every start.
func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS tasks (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status     TEXT        NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','processing','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ,
  worker     TEXT
);
CREATE INDEX IF NOT EXISTS tasks_pending_idx ON tasks (id) WHERE status = 'pending';`)
	return err
}

func (s *Store) Create(ctx context.Context, title string) (Task, error) {
	var t Task
	err := s.pool.QueryRow(ctx,
		`INSERT INTO tasks (title) VALUES ($1)
		 RETURNING id, title, status, created_at, done_at, worker`, title).
		Scan(&t.ID, &t.Title, &t.Status, &t.CreatedAt, &t.DoneAt, &t.Worker)
	return t, err
}

func (s *Store) List(ctx context.Context, limit int) ([]Task, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, title, status, created_at, done_at, worker
		 FROM tasks ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Task, error) {
		var t Task
		err := r.Scan(&t.ID, &t.Title, &t.Status, &t.CreatedAt, &t.DoneAt, &t.Worker)
		return t, err
	})
}

// Pending returns the number of tasks waiting for a worker. KEDA's
// PostgreSQL scaler runs the same query to scale workers.
func (s *Store) Pending(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE status = 'pending'`).Scan(&n)
	return n, err
}

// ErrNoTask means the queue is empty.
var ErrNoTask = errors.New("no pending task")

// Claim atomically takes one pending task. FOR UPDATE SKIP LOCKED lets any
// number of worker replicas poll the same table without double-processing.
func (s *Store) Claim(ctx context.Context, worker string) (Task, error) {
	var t Task
	err := s.pool.QueryRow(ctx, `
UPDATE tasks SET status = 'processing', worker = $1
WHERE id = (SELECT id FROM tasks WHERE status = 'pending'
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, title, status, created_at, done_at, worker`, worker).
		Scan(&t.ID, &t.Title, &t.Status, &t.CreatedAt, &t.DoneAt, &t.Worker)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNoTask
	}
	return t, err
}

func (s *Store) Complete(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE tasks SET status = 'done', done_at = now() WHERE id = $1`, id)
	return err
}

// Release puts a claimed task back when a worker is interrupted.
func (s *Store) Release(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE tasks SET status = 'pending', worker = NULL WHERE id = $1`, id)
	return err
}
