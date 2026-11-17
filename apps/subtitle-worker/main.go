// worker.exe: the tk.box subtitle worker for a Windows PC with an NVIDIA GPU (docs/PHASE-5.md). A tray icon; every few
// minutes, inside the window and while the GPU is idle, it takes a job from tk.box, runs whisper.cpp on its audio and
// uploads the English SRT. It only ever connects out to tk.box. worker.json sits next to worker.exe and is read again
// each cycle, so edits apply without a restart.
package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed worker.example.json
var exampleConfig []byte

const runKey, runValue = `Software\Microsoft\Windows\CurrentVersion\Run`, "tk.box subtitle worker"

type state struct {
	mu      sync.Mutex
	status  string
	tone    tone
	paused  bool
	working bool
}

var (
	dir, _  = os.Executable()
	home    = filepath.Dir(dir)
	logger  *log.Logger
	current state
	wake    = make(chan bool, 1) // true: run now, ignoring the window
	status  *systray.MenuItem
)

func main() {
	// One at a time.
	name, _ := windows.UTF16PtrFromString(`Local\tkbox-subtitle-worker`)
	if _, err := windows.CreateMutex(nil, false, name); err == windows.ERROR_ALREADY_EXISTS {
		return
	}
	logPath := filepath.Join(home, "worker.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 5<<20 {
		_ = os.Rename(logPath, logPath+".old")
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		f = os.Stderr
	}
	logger = log.New(f, "", log.LstdFlags)
	systray.Run(ready, func() {})
}

func ready() {
	systray.SetTitle("tk.box subtitles")
	status = systray.AddMenuItem("Starting…", "")
	status.Disable()
	systray.AddSeparator()
	pause := systray.AddMenuItemCheckbox("Pause", "Take no new jobs", false)
	now := systray.AddMenuItem("Run now", "Take a job now, outside the hours (the GPU must still be idle)")
	startup := systray.AddMenuItemCheckbox("Start with Windows", "", startsWithWindows())
	folder := systray.AddMenuItem("Open folder", "worker.json and worker.log")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", "A running job is handed back")
	set("Starting…", idle)

	ctx, cancel := context.WithCancel(context.Background())
	go loop(ctx)
	go func() {
		for {
			select {
			case <-pause.ClickedCh:
				current.mu.Lock()
				current.paused = !current.paused
				p := current.paused
				current.mu.Unlock()
				if p {
					pause.Check()
					set("Paused", warn)
				} else {
					pause.Uncheck()
					set("Resumed", idle)
					poke(false)
				}
			case <-now.ClickedCh:
				poke(true)
			case <-startup.ClickedCh:
				if err := setStartWithWindows(!startup.Checked()); err != nil {
					logf("start with Windows: %v", err)
				} else if startup.Checked() {
					startup.Uncheck()
				} else {
					startup.Check()
				}
			case <-folder.ClickedCh:
				_ = exec.Command("explorer.exe", home).Start()
			case <-quit.ClickedCh:
				cancel()
				// Give a running job a moment to hand itself back.
				for i := 0; i < 50 && isWorking(); i++ {
					time.Sleep(100 * time.Millisecond)
				}
				systray.Quit()
				return
			}
		}
	}()
}

func poke(now bool) {
	select {
	case wake <- now:
	default:
	}
}

func isWorking() bool { current.mu.Lock(); defer current.mu.Unlock(); return current.working }

// Every everyMin minutes (or on Run now): read worker.json, then take jobs one after another while it's allowed.
func loop(ctx context.Context) {
	force := false
	for {
		every := cycle(ctx, force)
		select {
		case <-ctx.Done():
			return
		case force = <-wake:
		case <-time.After(every):
			force = false
		}
	}
}

func cycle(ctx context.Context, force bool) time.Duration {
	configPath := filepath.Join(home, "worker.json")
	c, err := loadConfig(configPath)
	if os.IsNotExist(err) {
		_ = os.WriteFile(configPath, exampleConfig, 0o600)
		set("Fill in worker.json (Open folder)", bad)
		return time.Minute
	}
	if err != nil {
		set(err.Error(), bad)
		return time.Minute
	}
	every := time.Duration(c.EveryMin) * time.Minute
	cl := &Client{c: c, http: &http.Client{Timeout: 45 * time.Minute}}
	for ctx.Err() == nil {
		current.mu.Lock()
		paused := current.paused
		current.mu.Unlock()
		if paused {
			set("Paused", warn)
			return every
		}
		if !force && !inWindow(c.Window, time.Now()) {
			set("Waiting for "+c.Window, idle)
			return every
		}
		gpu, err := readGPU(ctx)
		if err != nil {
			set(err.Error(), bad)
			return every
		}
		if gpu.busy(c) {
			set(fmt.Sprintf("GPU busy (%d%%, %d MB)", gpu.Util, gpu.UsedMB), warn)
			return every
		}
		job, err := cl.claim(ctx)
		if err != nil {
			set(shorten(err.Error()), bad)
			logf("claim: %v", err)
			return every
		}
		if job == nil {
			set("Nothing to do", idle)
			return every
		}
		force = false
		current.mu.Lock()
		current.working = true
		current.mu.Unlock()
		set("Making: "+job.Title, active)
		err = cl.run(ctx, job, logf)
		current.mu.Lock()
		current.working = false
		current.mu.Unlock()
		if err != nil {
			logf("%s: %v", job.Title, err)
			set(shorten(job.Title+": "+err.Error()), bad)
		} else {
			set("Done: "+job.Title, idle)
		}
	}
	return every
}

func set(text string, t tone) {
	current.mu.Lock()
	changed := current.status != text || current.tone != t
	current.status, current.tone = text, t
	current.mu.Unlock()
	if !changed {
		return
	}
	if status != nil {
		status.SetTitle(shorten(text))
	}
	systray.SetTooltip(shorten("tk.box subtitles: " + text))
	systray.SetIcon(icon(t))
	logf("%s", text)
}

func logf(format string, args ...any) {
	if logger != nil {
		logger.Printf(format, args...)
	}
}

func shorten(s string) string {
	if r := []rune(s); len(r) > 100 {
		return string(r[:99]) + "…"
	}
	return s
}

func startsWithWindows() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValue)
	return err == nil
}

func setStartWithWindows(on bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if on {
		return k.SetStringValue(runValue, `"`+dir+`"`)
	}
	if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}
