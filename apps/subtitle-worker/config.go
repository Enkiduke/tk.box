package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// worker.json, next to worker.exe (worker.example.json shows every field).
type Config struct {
	Server   string `json:"server"`   // tk.box's HTTPS address, e.g. https://tk.example.com
	Token    string `json:"token"`    // from Admin › Downloads › Subtitles › Workers
	Whisper  string `json:"whisper"`  // whisper-cli.exe from whisper.cpp's Windows CUDA build
	Model    string `json:"model"`    // ggml-large-v3-turbo.bin
	VAD      string `json:"vad"`      // ggml-silero-*.bin; empty runs without VAD
	Window   string `json:"window"`   // "01:00-08:00"; empty means any time
	MaxGPU   int    `json:"maxGpu"`   // busy above this utilization, %
	MaxVRAM  int    `json:"maxVram"`  // busy above this much VRAM in use, MB
	Threads  int    `json:"threads"`  // whisper-cli -t; 0 leaves its default
	EveryMin int    `json:"everyMin"` // minutes between checks
}

func loadConfig(path string) (Config, error) {
	c := Config{Window: "01:00-08:00", MaxGPU: 15, MaxVRAM: 1536, EveryMin: 5}
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("worker.json: %w", err)
	}
	c.Server = strings.TrimRight(c.Server, "/")
	switch {
	case !strings.HasPrefix(c.Server, "https://") && !strings.HasPrefix(c.Server, "http://localhost") && !strings.HasPrefix(c.Server, "http://127.0.0.1"):
		return c, fmt.Errorf("worker.json: server must be an https:// address")
	case !strings.HasPrefix(c.Token, "tkw_"):
		return c, fmt.Errorf("worker.json: token must be a worker token (tkw_…)")
	case c.Whisper == "" || c.Model == "":
		return c, fmt.Errorf("worker.json: whisper and model are required")
	}
	if _, _, err := parseWindow(c.Window); err != nil {
		return c, err
	}
	if c.EveryMin < 1 {
		c.EveryMin = 1
	}
	return c, nil
}

// "01:00-08:00" as minutes after midnight. Empty is all day.
func parseWindow(w string) (start, end int, err error) {
	if strings.TrimSpace(w) == "" {
		return 0, 24 * 60, nil
	}
	parts := strings.Split(w, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("worker.json: window must look like 01:00-08:00")
	}
	if start, err = clock(parts[0]); err == nil {
		end, err = clock(parts[1])
	}
	return
}

func clock(s string) (int, error) {
	hm := strings.Split(strings.TrimSpace(s), ":")
	if len(hm) == 2 {
		h, e1 := strconv.Atoi(hm[0])
		m, e2 := strconv.Atoi(hm[1])
		if e1 == nil && e2 == nil && h >= 0 && h <= 24 && m >= 0 && m < 60 && h*60+m <= 24*60 {
			return h*60 + m, nil
		}
	}
	return 0, fmt.Errorf("worker.json: %q isn't a time like 01:00", s)
}

// Whether t is inside the window; a window like 22:00-06:00 runs past midnight.
func inWindow(window string, t time.Time) bool {
	start, end, err := parseWindow(window)
	if err != nil {
		return false
	}
	now := t.Hour()*60 + t.Minute()
	if start <= end {
		return now >= start && now < end
	}
	return now >= start || now < end
}
