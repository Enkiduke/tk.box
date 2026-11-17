# tk.box subtitle worker

`worker.exe` is a small tray app for a Windows PC with an NVIDIA GPU. tk.box gives it the files that OpenSubtitles had
no English subtitles for. During the hours you set, and only while the GPU is idle, it runs whisper.cpp on each file's
audio and sends back an English `.srt`. It only connects out to tk.box, so the PC needs no open ports.

## Build

Needs Go. From the repo root:

```
npm run build:worker
```

This makes `apps/subtitle-worker/dist/worker.exe`, about 7 MB with nothing else to install.

## Set up on the PC

1. Make a folder, for example `C:\tkbox-worker`, and put `worker.exe` in it.
2. Download whisper.cpp's Windows CUDA build from the whisper.cpp releases page (`whisper-bin-win-cuda-12.4.0-x64.zip`;
   older releases name it `whisper-cublas-12.4.0-bin-x64.zip`). Unzip it into a folder so `whisper-cli.exe` sits with
   its DLLs, for example `C:\whisper`.
3. Download the models into the same folder:
   - `ggml-large-v3-turbo.bin` from the `ggerganov/whisper.cpp` models on Hugging Face (large-v3 also works, but
     it's slower);
   - the Silero VAD model `ggml-silero-v5.1.2.bin` (skips silence, which keeps Whisper from making up lines).
4. In tk.box, go to Admin › Downloads › Subtitles › Workers › New token and copy the token.
5. Start `worker.exe`. It writes a `worker.json` next to itself and shows "Fill in worker.json". Use Open folder from
   the tray menu and fill it in:

| Field | |
| --- | --- |
| `server` | tk.box's HTTPS address |
| `token` | the worker token |
| `whisper`, `model`, `vad` | full paths to `whisper-cli.exe` and the two models (`vad` can be empty) |
| `window` | the hours it may take jobs, such as `01:00-08:00`; it can run past midnight (`22:00-06:00`); empty means any time |
| `maxGpu`, `maxVram` | the GPU counts as busy above this utilization (%) or this much VRAM in use (MB). The desktop alone holds about 1.2 GB, so the default is 1536. |
| `threads` | CPU threads for whisper-cli; 0 uses its default |
| `everyMin` | minutes between checks |

The worker reads `worker.json` again on every check, so edits apply without a restart.

6. Tick **Start with Windows** in the tray menu.

## The tray

The icon's colour shows its state: grey when idle or waiting, blue while it makes a subtitle, amber when paused or
the GPU is busy, red when something needs fixing. The menu shows what it's doing now, plus Pause, Run now (takes a
job outside the hours, but the GPU must still be idle), Start with Windows, Open folder (`worker.json`,
`worker.log`), and Quit.

A job that has started always finishes, even if the hours end or the GPU gets busy. Quitting hands the running job
back to tk.box, which counts that as a failed attempt; after 3 failed attempts tk.box stops trying that file. To stop
the worker for good, revoke its token in tk.box.
