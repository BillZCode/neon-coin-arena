//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func launchWindow(ctx context.Context, url string) error {
	if runtime.GOOS == "darwin" {
		return launchDarwinWindow(ctx, url)
	}
	return launchLinuxWindow(ctx, url)
}

func launchLinuxWindow(ctx context.Context, url string) error {
	profileDir, err := os.MkdirTemp("", "neoncoinarena-profile-*")
	if err == nil {
		defer os.RemoveAll(profileDir)
	}

	appBrowsers := []string{
		"google-chrome",
		"chromium",
		"chromium-browser",
		"microsoft-edge",
		"brave-browser",
	}

	for _, bin := range appBrowsers {
		path, err := exec.LookPath(bin)
		if err != nil {
			continue
		}
		args := []string{
			"--app=" + url,
			"--window-size=1280,840",
			"--new-window",
		}
		if profileDir != "" {
			args = append(args, "--user-data-dir="+profileDir, "--no-first-run")
		}
		cmd := exec.CommandContext(ctx, path, args...)
		if err := cmd.Start(); err == nil {
			fmt.Printf("Neon Coin Arena berjalan di %s (tutup jendela untuk keluar)\n", url)
			_ = cmd.Wait()
			return nil
		}
	}

	if xdg, err := exec.LookPath("xdg-open"); err == nil {
		_ = exec.Command(xdg, url).Start()
		fmt.Printf("Neon Coin Arena dibuka di browser: %s (tekan Ctrl+C untuk berhenti)\n", url)
		<-ctx.Done()
		return nil
	}

	fmt.Printf("Buka browser ke: %s (tekan Ctrl+C untuk berhenti)\n", url)
	<-ctx.Done()
	return nil
}

func launchDarwinWindow(ctx context.Context, url string) error {
	chromeApp := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if _, err := os.Stat(chromeApp); err == nil {
		profileDir, _ := os.MkdirTemp("", "neoncoinarena-mac-*")
		if profileDir != "" {
			defer os.RemoveAll(profileDir)
		}
		args := []string{"--app=" + url, "--window-size=1280,840", "--no-first-run"}
		if profileDir != "" {
			args = append(args, "--user-data-dir="+filepath.Clean(profileDir))
		}
		cmd := exec.CommandContext(ctx, chromeApp, args...)
		if err := cmd.Start(); err == nil {
			_ = cmd.Wait()
			return nil
		}
	}

	_ = exec.Command("open", url).Start()
	fmt.Printf("Neon Coin Arena dibuka di browser: %s (tekan Ctrl+C untuk berhenti)\n", url)
	<-ctx.Done()
	return nil
}
