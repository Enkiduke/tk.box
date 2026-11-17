package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// One job from tk.box (docs/PHASE-5.md): claim, download the audio, run whisper-cli, heartbeat while it runs, upload.

type Job struct {
	ID          int     `json:"id"`
	Title       string  `json:"title"`
	DurationSec float64 `json:"durationSec"`
	Audio       string  `json:"audio"`
}

type GPU struct{ Util, UsedMB int }

// nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits → the first GPU's line.
func parseGPU(out string) (GPU, error) {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(out), "\n", 2)[0])
	f := strings.Split(line, ",")
	if len(f) != 2 {
		return GPU{}, fmt.Errorf("nvidia-smi said %q", line)
	}
	util, e1 := strconv.Atoi(strings.TrimSpace(f[0]))
	used, e2 := strconv.Atoi(strings.TrimSpace(f[1]))
	if e1 != nil || e2 != nil {
		return GPU{}, fmt.Errorf("nvidia-smi said %q", line)
	}
	return GPU{util, used}, nil
}

func readGPU(ctx context.Context) (GPU, error) {
	out, err := hidden(exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits")).Output()
	if err != nil {
		return GPU{}, fmt.Errorf("nvidia-smi: %w", err)
	}
	return parseGPU(string(out))
}

// Busy when something else is using the GPU: over maxGpu % or over maxVram MB in use (the desktop alone holds a few
// hundred MB, so the default is 1536).
func (g GPU) busy(c Config) bool { return g.Util > c.MaxGPU || g.UsedMB > c.MaxVRAM }

// No console window for child processes (worker.exe is a tray app).
func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return cmd
}

type Client struct {
	c    Config
	http *http.Client
}

var errNotHeld = errors.New("tk.box says this worker no longer holds the job")

func (cl *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cl.c.Server+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cl.c.Token)
	req.Header.Set("User-Agent", "tk.box-subtitle-worker")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := cl.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusConflict {
		res.Body.Close()
		return nil, errNotHeld
	}
	if res.StatusCode >= 400 {
		defer res.Body.Close()
		var e struct{ Message string }
		_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&e)
		return nil, fmt.Errorf("tk.box %s %s: %d %s", method, path, res.StatusCode, e.Message)
	}
	return res, nil
}

func (cl *Client) claim(ctx context.Context) (*Job, error) {
	res, err := cl.do(ctx, "POST", "/api/v1/subtitle-worker/claim", map[string]any{})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	var j Job
	if err := json.NewDecoder(res.Body).Decode(&j); err != nil {
		return nil, err
	}
	return &j, nil
}

func (cl *Client) post(ctx context.Context, path string, body any) error {
	res, err := cl.do(ctx, "POST", path, body)
	if err == nil {
		res.Body.Close()
	}
	return err
}

func (cl *Client) download(ctx context.Context, path, dest string) error {
	res, err := cl.do(ctx, "GET", path, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err = io.Copy(f, res.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// run does one job start to finish. A job that's started always finishes (window or GPU changes don't stop it); only
// stop (quitting the tray app) does, and then the job is handed back as failed.
func (cl *Client) run(ctx context.Context, job *Job, log func(string, ...any)) error {
	dir, err := os.MkdirTemp("", "tkbox-subtitle-*")
	if err != nil {
		return cl.fail(job, "temp folder: "+err.Error())
	}
	defer os.RemoveAll(dir)

	// The lease is 30 minutes: keep it from now until the job is done.
	beat, stopBeat := context.WithCancel(ctx)
	defer stopBeat()
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-beat.Done():
				return
			case <-t.C:
				if err := cl.post(beat, fmt.Sprintf("/api/v1/subtitle-worker/jobs/%d/heartbeat", job.ID), map[string]any{}); err != nil {
					log("heartbeat: %v", err)
				}
			}
		}
	}()

	audio := filepath.Join(dir, "audio.flac")
	log("%s: downloading audio", job.Title)
	if err := cl.download(ctx, job.Audio, audio); err != nil {
		return cl.failUnlessGone(ctx, job, "audio download: "+err.Error())
	}

	base := filepath.Join(dir, "out")
	args := []string{"-m", cl.c.Model, "-f", audio, "-l", "en", "-osrt", "-of", base, "-np"}
	if cl.c.VAD != "" {
		args = append(args, "--vad", "--vad-model", cl.c.VAD)
	}
	if cl.c.Threads > 0 {
		args = append(args, "-t", strconv.Itoa(cl.c.Threads))
	}
	log("%s: running whisper (%.0f min of audio)", job.Title, job.DurationSec/60)
	started := time.Now()
	var stderr bytes.Buffer
	cmd := hidden(exec.CommandContext(ctx, cl.c.Whisper, args...))
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return cl.fail(job, "The worker was closed.")
		}
		return cl.fail(job, "whisper-cli: "+err.Error()+": "+tail(stderr.String(), 300))
	}
	srt, err := os.ReadFile(base + ".srt")
	if err != nil {
		return cl.fail(job, "whisper-cli made no SRT")
	}
	log("%s: whisper took %s", job.Title, time.Since(started).Round(time.Second))
	model := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(cl.c.Model), "ggml-"), ".bin")
	err = cl.post(ctx, fmt.Sprintf("/api/v1/subtitle-worker/jobs/%d/result", job.ID), map[string]any{"srt": string(srt), "model": model})
	if err != nil {
		return err // a 422 (the checks) already counted as a failed attempt on tk.box
	}
	log("%s: uploaded", job.Title)
	return nil
}

func (cl *Client) fail(job *Job, reason string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := cl.post(ctx, fmt.Sprintf("/api/v1/subtitle-worker/jobs/%d/fail", job.ID), map[string]string{"reason": tail(reason, 480)}); err != nil && !errors.Is(err, errNotHeld) {
		return fmt.Errorf("%s (and reporting it failed: %v)", reason, err)
	}
	return errors.New(reason)
}

func (cl *Client) failUnlessGone(ctx context.Context, job *Job, reason string) error {
	if ctx.Err() != nil {
		reason = "The worker was closed."
	}
	return cl.fail(job, reason)
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return "…" + s[len(s)-n:]
	}
	return s
}
