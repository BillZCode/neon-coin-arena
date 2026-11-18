package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

//go:embed all:web
var embeddedWeb embed.FS

const preferredLocalAddr = "127.0.0.1:18421"

func newWebHandler() (http.Handler, error) {
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(sub))
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"app":"neon-coin-arena-desktop"}`))
	})
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fileServer.ServeHTTP(w, r)
	}))
	return mux, nil
}

func startLocalServer(handler http.Handler) (string, func(), error) {
	ln, err := net.Listen("tcp", preferredLocalAddr)
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", nil, err
		}
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("http server error: %v", err)
		}
	}()

	url := fmt.Sprintf("http://%s/?app=1", ln.Addr().String())
	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
	return url, cleanup, nil
}

func main() {
	smokeTest := flag.Bool("smoke-test", false, "verify embedded HTTP server and exit")
	flag.Parse()

	handler, err := newWebHandler()
	if err != nil {
		log.Fatalf("gagal memuat aset web: %v", err)
	}

	url, shutdown, err := startLocalServer(handler)
	if err != nil {
		log.Fatalf("gagal membuka server lokal: %v", err)
	}
	defer shutdown()

	if *smokeTest {
		resp, err := http.Get(url)
		if err != nil {
			log.Fatalf("smoke test request gagal: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			log.Fatalf("smoke test status tidak valid: %d", resp.StatusCode)
		}
		fmt.Printf("SMOKE_OK %s\n", url)
		return
	}

	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	if err := launchWindow(ctx, url); err != nil {
		log.Fatalf("gagal menjalankan jendela aplikasi: %v", err)
	}
}
