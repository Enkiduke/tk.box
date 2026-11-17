package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
)

// The tray icon: a rounded square in the state's colour with two white subtitle lines, drawn here and wrapped as an
// .ico (PNG inside), so the exe needs no image files.

type tone int

const (
	idle tone = iota
	active
	warn
	bad
)

var tones = map[tone]color.RGBA{
	idle:   {0x6b, 0x72, 0x80, 0xff}, // grey
	active: {0x3b, 0x82, 0xf6, 0xff}, // blue
	warn:   {0xf5, 0x9e, 0x0b, 0xff}, // amber
	bad:    {0xef, 0x44, 0x44, 0xff}, // red
}

// Drawn once at start, so set() can read them from any goroutine.
var icons = func() map[tone][]byte {
	m := map[tone][]byte{}
	for t := range tones {
		m[t] = draw(t)
	}
	return m
}()

func icon(t tone) []byte { return icons[t] }

func draw(t tone) []byte {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	white := color.RGBA{0xff, 0xff, 0xff, 0xff}
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			// Rounded corners (radius 6).
			cx, cy := clamp(x, 6, n-7), clamp(y, 6, n-7)
			if (x-cx)*(x-cx)+(y-cy)*(y-cy) > 36 {
				continue
			}
			img.Set(x, y, tones[t])
		}
	}
	for _, line := range [][3]int{{18, 7, 25}, {23, 10, 22}} { // y, from x, to x
		for y := line[0]; y < line[0]+3; y++ {
			for x := line[1]; x < line[2]; x++ {
				img.Set(x, y, white)
			}
		}
	}
	var p bytes.Buffer
	_ = png.Encode(&p, img)
	var ico bytes.Buffer
	_ = binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, 1})                 // reserved, type icon, one image
	ico.Write([]byte{n, n, 0, 0})                                                  // width, height, colours, reserved
	_ = binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})                   // planes, bits per pixel
	_ = binary.Write(&ico, binary.LittleEndian, []uint32{uint32(p.Len()), 6 + 16}) // size, offset
	ico.Write(p.Bytes())
	return ico.Bytes()
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
