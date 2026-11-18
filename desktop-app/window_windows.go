//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	webview2 "github.com/jchv/go-webview2"
)

func resolveWebViewDataDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "NeonCoinArena", "WebView2")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func launchWindow(ctx context.Context, url string) error {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  resolveWebViewDataDir(),
		WindowOptions: webview2.WindowOptions{
			Title:  "Neon Coin Arena — AWS WebSocket",
			Width:  1280,
			Height: 840,
			Center: true,
		},
	})
	if w != nil {
		defer w.Destroy()
		go func() {
			<-ctx.Done()
			w.Terminate()
		}()
		w.SetSize(1280, 840, webview2.HintNone)
		w.Navigate(url)
		w.Run()
		return nil
	}

	return launchFallbackBrowser(ctx, url)
}

func launchFallbackBrowser(ctx context.Context, url string) error {
	candidates := [][]string{
		{"msedge", "--app=" + url, "--window-size=1280,840"},
		{"chrome", "--app=" + url, "--window-size=1280,840"},
		{"cmd", "/c", "start", "", url},
	}

	for _, args := range candidates {
		path, err := exec.LookPath(args[0])
		if err != nil {
			continue
		}
		cmd := exec.CommandContext(ctx, path, args[1:]...)
		if err := cmd.Start(); err == nil {
			if args[0] == "cmd" {
				<-ctx.Done()
				return nil
			}
			return cmd.Wait()
		}
	}

	if err := exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", url).Start(); err == nil {
		<-ctx.Done()
		return nil
	}
	return fmt.Errorf("WebView2 runtime dan browser fallback tidak ditemukan; buka manual: %s", url)
}
