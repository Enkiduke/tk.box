package main

import (
	"testing"
	"time"
)

func at(h, m int) time.Time { return time.Date(2026, 11, 16, h, m, 0, 0, time.Local) }

func TestWindow(t *testing.T) {
	cases := []struct {
		window string
		h, m   int
		want   bool
	}{
		{"01:00-08:00", 0, 59, false}, {"01:00-08:00", 1, 0, true}, {"01:00-08:00", 7, 59, true}, {"01:00-08:00", 8, 0, false},
		{"22:00-06:00", 23, 0, true}, {"22:00-06:00", 5, 59, true}, {"22:00-06:00", 6, 0, false}, {"22:00-06:00", 21, 59, false},
		{"", 13, 0, true}, {"00:00-24:00", 23, 59, true}, {"bad", 3, 0, false},
	}
	for _, c := range cases {
		if got := inWindow(c.window, at(c.h, c.m)); got != c.want {
			t.Errorf("%q at %02d:%02d = %v, want %v", c.window, c.h, c.m, got, c.want)
		}
	}
	for _, bad := range []string{"1-8", "01:00", "25:00-08:00", "01:60-08:00", "01:00-08:00-09:00"} {
		if _, _, err := parseWindow(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestGPU(t *testing.T) {
	g, err := parseGPU("7, 812\n3, 100\n")
	if err != nil || g != (GPU{7, 812}) {
		t.Fatalf("got %v %v", g, err)
	}
	for _, bad := range []string{"", "[N/A], 812", "7"} {
		if _, err := parseGPU(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	c := Config{MaxGPU: 15, MaxVRAM: 1536}
	if (GPU{15, 1536}).busy(c) || !(GPU{16, 0}).busy(c) || !(GPU{0, 1537}).busy(c) {
		t.Error("busy is over the limits, not at them")
	}
}

func TestIcon(t *testing.T) {
	b := icon(active)
	if len(b) < 22 || b[2] != 1 || b[4] != 1 || string(b[22:26]) != "\x89PNG" {
		t.Fatalf("not an .ico wrapping a PNG: % x", b[:26])
	}
}
