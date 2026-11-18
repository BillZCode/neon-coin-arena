package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestEmbeddedServerServesGameAndHealth(t *testing.T) {
	handler, err := newWebHandler()
	if err != nil {
		t.Fatalf("newWebHandler error: %v", err)
	}

	url, cleanup, err := startLocalServer(handler)
	if err != nil {
		t.Fatalf("startLocalServer error: %v", err)
	}
	defer cleanup()

	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s error: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "Neon Coin Arena") {
		t.Fatalf("index.html missing game title")
	}

	base := strings.Split(url, "/?")[0]
	for _, asset := range []string{"/game.js", "/style.css", "/health"} {
		r, err := http.Get(base + asset)
		if err != nil {
			t.Fatalf("GET %s error: %v", asset, err)
		}
		_ = r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK for %s, got %d", asset, r.StatusCode)
		}
	}
}
