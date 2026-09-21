// Package metrics is a deliberately tiny Prometheus text-format exporter.
// It keeps the example free of third-party dependencies while still
// producing real /metrics output that Prometheus can scrape.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

type Registry struct {
	mu       sync.Mutex
	help     map[string]string
	kind     map[string]string
	counters map[string]float64 // key: name{labels}
	gauges   map[string]func() float64
}

func New() *Registry {
	return &Registry{
		help:     map[string]string{},
		kind:     map[string]string{},
		counters: map[string]float64{},
		gauges:   map[string]func() float64{},
	}
}

func (r *Registry) Counter(name, help string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.help[name], r.kind[name] = help, "counter"
}

// Inc adds one to a counter series. labels is "k=\"v\",k2=\"v2\"" or "".
func (r *Registry) Inc(name, labels string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := name
	if labels != "" {
		key = name + "{" + labels + "}"
	}
	r.counters[key]++
}

// Gauge registers a value that is computed at scrape time.
func (r *Registry) Gauge(name, help string, fn func() float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.help[name], r.kind[name] = help, "gauge"
	r.gauges[name] = fn
}

func (r *Registry) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	names := make([]string, 0, len(r.help))
	for n := range r.help {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", n, r.help[n], n, r.kind[n])
		if fn, ok := r.gauges[n]; ok {
			fmt.Fprintf(w, "%s %g\n", n, fn())
			continue
		}
		keys := []string{}
		for k := range r.counters {
			if k == n || strings.HasPrefix(k, n+"{") {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(w, "%s %g\n", k, r.counters[k])
		}
	}
}
