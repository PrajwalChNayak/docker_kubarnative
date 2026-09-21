// Package probe implements the "healthcheck" subcommand used by Docker
// HEALTHCHECK. Distroless images have no shell, curl or wget, so the binary
// checks itself.
package probe

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

// Run exits 0 if url answers 2xx within two seconds, otherwise 1.
func Run(url string) {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		os.Exit(1)
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		os.Exit(1)
	}
	os.Exit(0)
}
