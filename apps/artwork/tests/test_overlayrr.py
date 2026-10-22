"""Renderer parity, offline provider fixtures, and real HTTP/cache/CLI checks for tk.box's artwork engine.

Run from the repository root: py -3 -m unittest discover -s apps/artwork/tests"""

import ast
from contextlib import contextmanager, redirect_stdout, redirect_stderr
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

STANDALONE = Path(__file__).resolve().parents[1]
ROOT = STANDALONE.parent
needs_parent_app = unittest.skipUnless((ROOT / "backend").is_dir(), "compares against the parent app in ../backend")
sys.path.insert(0, str(STANDALONE))
import engine_common as common
import overlayrr as sp
import plex_cleanup as cleanup
import plex_collections as pc


def example_config():
    """Overlayrr's example layouts (overlayrr-main, tk-movies, tk-tv...), which these tests pin down; tk.box seeds its own from defaults.json."""
    return sp.read_config(STANDALONE / "tests" / "example_layouts.json")


def rendered_path(base, rating_key):
    matches = [path.parent / "rendered.jpg" for path in (base / "assets").rglob(".overlayrr.json")
               if str(json.loads(path.read_text())["rating_key"]) == str(rating_key)]
    if len(matches) != 1:
        raise AssertionError(f"Expected one asset folder for Plex ID {rating_key}, got {matches}")
    return matches[0]


def main_style(**changes):
    config = example_config()
    options = dict(config["layouts"][config["default_layout"]])
    options.pop("season_options", None)
    return sp.Style(**{**options, **changes})


def configured(**changes):
    return {"default_layout": "custom", "layouts": {"custom": {}}, **changes}


def original_renderer():
    """Load the real app's image functions without its database/server startup."""
    namespace = {"Image": Image, "ImageDraw": ImageDraw, "ImageFilter": ImageFilter,
                 "np": np, "Dict": dict, "Any": object,
                 "resolve_canvas_size": lambda options: (2000, 3000),
                 "scale_options_for_canvas": lambda options: options,
                 "apply_overlay_config": lambda canvas, *args: canvas}
    class RemoveAppImports(ast.NodeTransformer):
        def visit_ImportFrom(self, node):
            return None if node.level else node
    for filename, names in (
        ("universal.py", {"_resize_cover", "_add_vignette", "_add_grain", "build_base_poster"}),
        ("uniformlogo.py", {"render_uniform_logo"}),
    ):
        tree = ast.parse((ROOT / "backend/templates" / filename).read_text(encoding="utf-8"))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        module = RemoveAppImports().visit(ast.Module(body=functions, type_ignores=[]))
        exec(compile(ast.fix_missing_locations(module), filename, "exec"), namespace)
    return namespace["render_uniform_logo"]


class RendererTests(unittest.TestCase):
    @needs_parent_app
    def test_main_layout_follows_actual_main_preset(self):
        tree = ast.parse((ROOT / "backend/api/presets.py").read_text(encoding="utf-8"))
        assignment = next(n for n in tree.body if isinstance(n, ast.AnnAssign) and n.target.id == "_DEFAULT_PRESETS_TEMPLATE")
        presets = ast.literal_eval(assignment.value)["uniformlogo"]["presets"]
        options = next(p["options"] for p in presets if p["name"] == "simposter-main")
        explicit = example_config()["layouts"]["overlayrr-main"]
        for name, value in asdict(main_style()).items():
            if name in options and name in explicit:
                self.assertEqual(value, options[name], name)

    @needs_parent_app
    def test_exact_pixels_without_grain_against_app(self):
        reference = original_renderer()
        logo = Image.new("RGBA", (403, 79), (255, 220, 65, 170))
        ImageDraw.Draw(logo).rectangle((3, 10, 70, 55), fill=(0, 80, 255, 255))
        background = Image.fromarray(np.random.default_rng(42).integers(0, 256, (383, 301, 4), dtype=np.uint8))
        style = main_style(grain_amount=0)
        actual = sp.Renderer(style).render(background, logo)
        expected = reference(background, logo, asdict(style)).convert("RGB")
        np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

    @needs_parent_app
    def test_grain_matches_app_blending_with_same_noise(self):
        style = main_style(grain_seed=7)
        background = Image.new("RGBA", (200, 300), (34, 98, 150, 255))
        actual = sp.Renderer(style).render(background)
        noise = np.random.default_rng(7).random((3000, 2000), dtype=np.float32)
        noise *= 256 * style.grain_amount
        noise += 128 - 128 * style.grain_amount
        with patch.object(np.random, "uniform", return_value=noise - 128):
            expected = original_renderer()(background, None, asdict(style)).convert("RGB")
        np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
        repeated = sp.Renderer(style).render(background)
        np.testing.assert_array_equal(np.asarray(actual), np.asarray(repeated))

    def test_small_canvas_logo_proportions_and_stock(self):
        style = main_style(width=200, height=300, grain_amount=0, vignette_strength=0)
        renderer = sp.Renderer(style)
        logo = Image.new("RGBA", (1282, 352), "white")
        result = renderer.render(Image.new("RGBA", (200, 300), "black"), logo)
        self.assertEqual(result.getpixel((100, 249)), (255, 255, 255))
        self.assertEqual(result.getpixel((100, 230)), (0, 0, 0))
        stock = renderer.render(Image.new("RGBA", (200, 300), "red"), stock=True)
        self.assertEqual(stock.getpixel((100, 290)), (255, 0, 0))

    def test_generic_defaults_do_not_embed_main_look(self):
        style = sp.Style()
        self.assertEqual((style.poster_shift_y, style.matte_height_ratio, style.fade_height_ratio,
                          style.vignette_strength, style.grain_amount), (0, 0, 0, 0, 0))
        self.assertEqual((style.poster_filter, style.logo_preference), ("all", "any"))

    def test_layouts_share_effect_masks(self):
        styles = sp.layout_styles(example_config())
        movies = sp.Renderer(styles["tk-movies", False])
        tv = sp.Renderer(styles["tk-tv", False])
        self.assertIs(movies.matte, tv.matte)
        self.assertIs(movies.vignette, tv.vignette)

    def test_border_and_logo_alignment(self):
        style = sp.Style(width=200, height=300, uniform_logo_max_w=400, uniform_logo_max_h=400,
                         uniform_logo_h_align="left", uniform_logo_v_align="bottom",
                         border_enabled=True, border_px=20, border_color="#0000FF")
        image = sp.Renderer(style).render(Image.new("RGB", (200, 300), "black"),
                                          Image.new("RGBA", (400, 200), "white"))
        self.assertEqual(image.size, (204, 304))
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 255))
        self.assertEqual(image.getpixel((82, 152)), (255, 255, 255))
        self.assertEqual(image.getpixel((82, 142)), (0, 0, 0))

    def test_season_text_placeholders_and_visible_position(self):
        style = sp.Style(width=200, height=300, logo_mode="none", text_overlay_enabled=True,
                         custom_text="{season}", font_size=150, position_y=0.95, text_transform="uppercase")
        background = Image.new("RGB", (200, 300), "black")
        image = sp.Renderer(style).render(background, item={"season": 1})
        box = ImageChops.difference(image, background).getbbox()
        self.assertIsNotNone(box)
        self.assertTrue(270 < box[1] < box[3] < 300)
        specials = sp.Renderer(style).render(background, item={"season": 0})
        self.assertNotEqual(image.tobytes(), specials.tobytes())


class LayoutTests(unittest.TestCase):
    def test_selection_precedence_and_season_override(self):
        config = example_config()
        styles = sp.layout_styles(config)
        self.assertEqual(sp.item_layout({"type": "movie"}, config, styles), ("overlayrr-main", False))
        config["layout_by_type"] = {"movie": "tk-movies", "tv": "tk-tv"}
        self.assertEqual(sp.item_layout({"type": "movie"}, config, styles), ("tk-movies", False))
        self.assertEqual(sp.item_layout({"type": "tv", "season": 1}, config, styles), ("tk-tv", True))
        self.assertEqual(sp.item_layout({"type": "movie", "layout": "tk-tv"}, config, styles), ("tk-tv", False))
        config["layout_by_library"] = {"Anime": "tk-tv"}
        self.assertEqual(sp.item_layout({"type": "movie", "library": "Anime"}, config, styles), ("tk-tv", False))
        self.assertEqual(sp.item_layout({"type": "movie", "library": "Other"}, config, styles), ("tk-movies", False))
        self.assertEqual((styles["tk-movies", False].grain_amount, styles["tk-movies", False].uniform_logo_max_w), (0.12, 1500))
        self.assertEqual((styles["tk-tv", False].uniform_logo_max_w, styles["tk-tv", False].uniform_logo_offset_y), (1700, 0.86))
        seasonal = styles["tk-tv", True]
        self.assertEqual((seasonal.uniform_logo_max_w, seasonal.uniform_logo_max_h, seasonal.uniform_logo_offset_y), (1500, 500, 0.83))
        self.assertEqual((seasonal.logo_preference, seasonal.custom_text, seasonal.position_y), ("any", "{season}", 0.95))

    def test_arbitrary_names_and_invalid_config(self):
        config = configured()
        self.assertIn(("custom", False), sp.layout_styles(config))
        for bad in ({"default_layout": "missing", "layouts": {"custom": {}}},
                    configured(layout_by_type={"tv": "missing"}),
                    configured(layouts={"custom": {"season_options": {"unknown": 1}}}),
                    configured(layouts={"custom": {"season_options": {"font_size": -1}}})):
            with self.assertRaises(ValueError):
                sp.layout_styles(bad)
        styles = sp.layout_styles(config)
        with self.assertRaisesRegex(ValueError, "Undefined"):
            sp.item_layout({"type": "tv", "layout": "missing"}, config, styles)

    def test_episode_layout_needs_episode_options(self):
        episode = {"type": "tv", "season": 1, "episode": 2}
        config = configured()
        with self.assertRaisesRegex(ValueError, "episode_options"):
            sp.item_layout(episode, config, sp.layout_styles(config))
        config = configured(layouts={"custom": {"episode_options": {"width": 320, "height": 180}}})
        styles = sp.layout_styles(config)
        self.assertEqual(sp.item_layout(episode, config, styles), ("custom", "episode"))
        self.assertEqual(sp.item_layout({"type": "tv", "season": 1}, config, styles), ("custom", True))
        self.assertEqual(styles["custom", "episode"].width, 320)

class TitleCardTests(unittest.TestCase):
    def test_title_split_matches_titlecardmaker_bottom_style(self):
        self.assertEqual(sp.split_title("The One Where Rachel's Sister Babysits", 25, 2),
                         ["The One Where", "Rachel's Sister Babysits"])
        self.assertEqual(sp.split_title("Short", 25, 2), ["Short"])
        self.assertEqual(sp.split_title("One Two Three Four Five Six", 8, 1), ["One Two Three Four Five Six"])

    def test_logo_color_skips_transparent_white_and_black_and_picks_stroke(self):
        def logo(color):
            image = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
            image.paste(Image.new("RGBA", (30, 10), color), (5, 5))
            return image
        self.assertEqual(sp.logo_colors(logo((255, 255, 255, 255))), (sp.CARD_DEFAULT_COLOR, "black"))
        self.assertEqual(sp.logo_colors(logo((200, 0, 0, 255)))[1], "black")
        color, stroke = sp.logo_colors(logo((0, 0, 200, 255)))
        self.assertEqual((color, stroke), ("#0000c8", "white"))

    def test_title_min_brightness_skips_dark_dominant_logo_colors(self):
        logo = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
        logo.paste(Image.new("RGBA", (30, 8), (20, 30, 90, 255)), (5, 2))    # Large, dark navy
        logo.paste(Image.new("RGBA", (30, 4), (240, 160, 40, 255)), (5, 12))  # Smaller, bright orange
        self.assertEqual(sp.logo_colors(logo)[0], "#141e5a")
        self.assertEqual(sp.logo_colors(logo, 80), ("#f0a028", "black"))
        dark = Image.new("RGBA", (40, 20), (20, 30, 90, 255))
        self.assertEqual(sp.logo_colors(dark, 80), (sp.CARD_DEFAULT_COLOR, "black"))  # Nothing bright enough: the default
        self.assertEqual(sp.Style(title_min_brightness=80).title_min_brightness, 80)
        with self.assertRaises(ValueError):
            sp.Style(title_min_brightness=300)

    def test_text_shadow_darkens_around_the_text_only_and_is_off_by_default(self):
        still = Image.new("RGBA", (64, 36), (200, 200, 200, 255))
        item = {"season": 1, "episode": 3, "episode_title": "Welcome to the Playground"}
        def render(**changes):
            style = sp.Style(width=640, height=360, logo_mode="none", title_font_size=60, index_font_size=30, **changes)
            return np.asarray(sp.CardRenderer(style).render(still, None, False, item).convert("RGB")).astype(int)
        plain, soft = render(), render(shadow_strength=0.8, shadow_blur=10)
        self.assertEqual(plain.tobytes(), render(shadow_strength=0).tobytes())
        changed = np.argwhere((plain != soft).any(axis=2))
        self.assertGreater(len(changed), 1000)
        self.assertGreater(changed[:, 0].min(), 360 * 0.4)    # Only the lower-left, around the text
        self.assertLess(changed[:, 1].max(), 640 * 0.95)
        self.assertTrue((soft <= plain + 1).all())             # Only ever darkens (the text itself is drawn on top)
        self.assertLess(soft[330:350, 5:200].mean(), plain[330:350, 5:200].mean())
        self.assertGreater(len(np.unique(soft[300:360, 100:300, 0])), 20)  # Smooth falloff, not a hard box
        with self.assertRaises(ValueError):
            sp.Style(shadow_strength=2)

    def test_text_outline_width_and_opacity_are_settings(self):
        still = Image.new("RGBA", (64, 36), (200, 200, 200, 255))
        item = {"season": 1, "episode": 3, "episode_title": "Welcome to the Playground"}
        def render(**changes):
            style = sp.Style(width=640, height=360, logo_mode="none", title_font_size=60, index_font_size=30, **changes)
            return np.asarray(sp.CardRenderer(style).render(still, None, False, item).convert("RGB")).astype(int)
        default = render()
        self.assertEqual(default.tobytes(), render(stroke_opacity=1, title_stroke_width=3, index_stroke_width=6).tobytes())
        none, solid, ninety, wide = render(stroke_opacity=0), render(), render(stroke_opacity=0.9), render(stroke_opacity=0.9, title_stroke_width=14)
        self.assertGreaterEqual(none.min(), 190)                   # No outline: nothing darker than the picture
        self.assertLess(solid.min(), 10)                           # Solid black outline
        self.assertTrue(15 < ninety.min() < 40)                    # 90% black over 200 leaves ~20: the picture shows through
        self.assertGreater((wide < 100).sum(), (ninety < 100).sum() * 1.3)  # A wider outline covers more
        with self.assertRaises(ValueError):
            sp.Style(stroke_opacity=2)

    def test_card_renders_logo_title_and_index_text(self):
        style = sp.Style(width=320, height=180, uniform_logo_max_w=1155, uniform_logo_max_h=650,
                         text_transform="uppercase", title_font_size=60, index_font_size=30)
        still = Image.new("RGBA", (64, 36), "black")
        logo = Image.new("RGBA", (50, 20), (0, 0, 0, 0))
        logo.paste(Image.new("RGBA", (30, 10), (200, 0, 0, 255)), (10, 5))
        item = {"season": 1, "episode": 3, "episode_title": "Welcome to the Playground"}
        image = sp.CardRenderer(style).render(still, logo, False, item)
        self.assertEqual(image.size, (320, 180))
        # Logo is trimmed and anchored at the 50px (scaled) margin; text sits in the lower half.
        top = np.asarray(image.crop((0, 0, 320, 90)).convert("RGB")).sum(axis=2)
        bottom = np.asarray(image.crop((0, 90, 320, 180)).convert("RGB")).sum(axis=2)
        self.assertGreater(top.max(), 0)
        self.assertGreater(bottom.max(), 0)
        self.assertEqual(int(np.asarray(image.convert("RGB"))[4, 4].sum()), 0)
        plain = sp.CardRenderer(style).render(still, None, False, {**item, "episode_title": ""})
        self.assertNotEqual(image.tobytes(), plain.tobytes())

    def test_card_logo_position_shadow_and_text_placement_are_settings(self):
        still = Image.new("RGBA", (64, 36), (200, 200, 200, 255))
        logo = Image.new("RGBA", (100, 40), (255, 0, 0, 255))
        item = {"season": 1, "episode": 3, "episode_title": "Welcome to the Playground"}
        def render(logo=logo, **changes):
            style = sp.Style(width=640, height=360, uniform_logo_max_w=1000, uniform_logo_max_h=300, title_font_size=60, index_font_size=30,
                             title_color="#FFFFFF", index_color="#FFFFFF", stroke_opacity=0, **changes)
            return np.asarray(sp.CardRenderer(style).render(still, logo, False, item).convert("RGB")).astype(int)
        def box(pixels, wanted):
            found = np.argwhere(wanted(pixels))
            return found[:, 1].min(), found[:, 0].min(), found[:, 1].max(), found[:, 0].max()  # left, top, right, bottom
        red, white = (lambda p: (p[..., 0] > 200) & (p[..., 1] < 50)), (lambda p: (p > 240).all(axis=2))
        self.assertEqual(box(render(), red)[:2], (10, 10))                                  # Against the top left margin, as the card always had
        self.assertEqual(box(render(card_logo_offset_x=1, card_logo_offset_y=1, card_logo_h_align="right", card_logo_v_align="bottom"), red)[2:], (629, 349))
        centered = box(render(card_logo_offset_x=0.5, card_logo_h_align="center"), red)
        self.assertLess(abs((centered[0] + centered[2]) / 2 - 320), 2)
        padded = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
        padded.paste(logo, (50, 30))
        self.assertEqual(box(render(padded), red)[:2], (10, 10))                            # Trimmed (the default)...
        self.assertGreater(box(render(padded, card_logo_trim=False), red)[0], 10)           # ...or kept with its padding
        middle = {"card_logo_offset_y": 0.5}                                                # The logo's rows are 150 to 209
        plain, shadowed = render(**middle), render(card_logo_shadow_enabled=True, card_logo_shadow_opacity=80, card_logo_shadow_angle=-90,
                                                   card_logo_shadow_distance=20, **middle)
        self.assertEqual(plain.tobytes(), render(card_logo_shadow_enabled=False, card_logo_shadow_size=99, **middle).tobytes())
        change = np.abs(shadowed - plain).sum(axis=2)
        self.assertGreater(change[130:150, 20:200].sum(), change[210:230, 20:200].sum() * 1.3)  # The light is below, so the shadow falls above
        self.assertEqual(shadowed[180, 30].tolist(), plain[180, 30].tolist())               # The logo itself is drawn on top
        self.assertGreaterEqual(box(render(logo=None, title_x=400, index_x=300), white)[0], 60)
        self.assertGreater(np.ptp(np.argwhere(white(render(logo=None, title_letter_spacing=20)))[:, 1]),
                           np.ptp(np.argwhere(white(render(logo=None)))[:, 1]))             # Letter spacing widens the title
        self.assertLess(box(render(logo=None, title_bottom=300), white)[1], box(render(logo=None), white)[1] - 20)  # Raised off the bottom
        tinted = render(logo=None, shadow_strength=1, shadow_blur=10, shadow_color="#FF0000")
        self.assertGreater((tinted[..., 0] - tinted[..., 1]).max(), 30)
        for bad in ({"card_logo_h_align": "middle"}, {"card_logo_offset_x": 2}, {"title_stroke_color": "red"}, {"shadow_color": "auto"}, {"card_logo_trim": 1}):
            with self.assertRaises(ValueError):
                sp.Style(**bad)

    def test_badge_gradients_are_generated_smooth_and_follow_settings(self):
        background = Image.new("RGBA", (40, 60), (200, 200, 200, 255))
        def render(**changes):
            style = sp.Style(width=400, height=600, logo_mode="none", badges=("gradients",), **changes)
            return np.asarray(sp.Renderer(style).render(background, item={}).convert("RGB")).astype(int)
        pixels = render()
        self.assertEqual(pixels.tobytes(), render().tobytes())
        self.assertLess(pixels[0].mean(), 200 * 0.45)          # strong at the edges (default 0.67 strength)
        self.assertLess(pixels[-1].mean(), 200 * 0.45)
        self.assertGreater(pixels[300].mean(), 195)             # untouched in the middle
        self.assertGreater(len(np.unique(pixels[:150, 200, 0])), 40)  # a smooth ramp, not a few steps
        weaker = render(badge_gradient_strength=0.2)
        self.assertGreater(weaker[0].mean(), pixels[0].mean() + 50)
        shorter = render(badge_gradient_height=0.1)
        self.assertGreater(shorter[100].mean(), pixels[100].mean())
        with self.assertRaises(ValueError):
            sp.Style(badge_gradient_strength=2)

    def test_radial_gradient_darkens_the_left_without_banding_and_is_repeatable(self):
        style = sp.Style(width=640, height=360, card_gradient="RADIAL", logo_mode="none")
        self.assertEqual(style.card_gradient, "radial")
        still = Image.new("RGBA", (64, 36), (200, 200, 200, 255))
        renderer = sp.CardRenderer(style)
        first, second = (renderer.render(still, None, False, {}) for _ in range(2))
        self.assertEqual(first.tobytes(), second.tobytes())
        pixels = np.asarray(first.convert("RGB")).astype(int)
        self.assertLess(pixels[180, :20].mean(), 10)           # solid black at the far left
        self.assertGreater(pixels[180, 300:500].mean(), 190)    # photo untouched near the centre
        self.assertGreater(len(np.unique(pixels[180, :, 0])), 40)  # a fade, with dither, not a few flat steps
        # The corner term touches the right-hand corners, but hardly the middle of the right edge.
        flat = np.asarray(sp.CardRenderer(sp.Style(width=640, height=360, card_gradient="radial", logo_mode="none",
                                                   gradient_corner_strength=0)).render(still, None, False, {}).convert("RGB")).astype(int)
        corner_loss = 1 - pixels[2, 637].mean() / flat[2, 637].mean()
        edge_loss = 1 - pixels[180, 637].mean() / flat[180, 637].mean()
        self.assertGreater(corner_loss, 0.2)
        self.assertLess(edge_loss, 0.08)
        with self.assertRaises(ValueError):
            sp.Style(card_gradient="x.png")
        with self.assertRaises(ValueError):
            sp.Style(gradient_strength=2)


class Response:
    def __init__(self, data):
        self.data = data
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def json(self):
        return self.data


class FixtureHTTP(sp.HTTP):
    def __init__(self, directory):
        super().__init__(directory / "cache")
        self.calls = []
        self.replies = {}
        self.images = {}
        self.label_data = {}
    def json(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        reply = self.replies[url]
        if isinstance(reply, Exception):
            raise reply
        return reply
    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        if url in self.label_data:
            entry = self.label_data[url]
            root = ET.Element("MediaContainer")
            element = ET.SubElement(root, "Video" if entry["type"] == "movie" else "Directory",
                                    {"ratingKey": entry["rating_key"], "type": entry["type"]})
            for label in entry["labels"]:
                ET.SubElement(element, "Label", {"tag": label})
            return ET.tostring(root)
        return self.replies[url]
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if method == "PUT" and url in self.label_data:
            self.label_data[url]["labels"] = [value for key, value in kwargs["params"].items() if key.startswith("label[")]
        return Response({"data": {"token": "fixture-token"}})
    def image(self, source, base, headers=None):
        if source in self.images:
            return self.images[source].copy()
        return super().image(source, base, headers)


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        # Bundled resources/ resolve beside the engine; these tests supply their own (or none) in the temporary folder.
        engine = patch.object(common, "ENGINE_DIR", self.base)
        engine.start()
        self.addCleanup(engine.stop)
        self.http = FixtureHTTP(self.base)
        self.config = configured(api={"tmdb_key": "fixture-key", "tvdb_key": "fixture-tvdb", "fanart_key": "fixture-fanart"},
                                 plex={"url": "http://plex.invalid:32400", "token": "fixture-plex", "libraries": ["Movies"], "completion_label": ""})
        self.artwork = sp.Artwork(self.http, self.config, self.base)
        self.http.replies[self.artwork.plex.url + "/"] = b'<MediaContainer machineIdentifier="fixture-server"/>'
        self.poster_url = "https://art.invalid/textless.jpg"
        self.logo_url = "https://art.invalid/logo.png"
        self.http.images[self.poster_url] = Image.new("RGBA", (20, 30), "red")
        self.http.images[self.logo_url] = Image.new("RGBA", (20, 5), "white")

    def tearDown(self):
        self.temp.cleanup()

    def folder_job(self, upload=False, logo=False):
        self.config["plex"].update(libraries=[], upload=upload, upload_logo=logo)
        self.config["layouts"]["custom"] = {"width": 200, "height": 300}
        self.config["items"] = [{"type": "movie", "tmdb_id": 603, "rating_key": "9", "output": "render.png"}]
        self.http.replies[common.TMDB + "/movie/603"] = {"title": "The Matrix", "release_date": "1999-03-31", "images": {
            "posters": [{"file_path": "/poster.jpg", "iso_639_1": None}],
            "logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]}}
        self.http.images[sp.IMAGE_BASE + "/poster.jpg"] = self.http.images[self.poster_url]
        self.http.images[sp.IMAGE_BASE + "/logo.png"] = self.http.images[self.logo_url]
        self.http.images["https://image.tmdb.org/t/p/w300/logo.png"] = self.http.images[self.logo_url]
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        return path

    def run_folder_job(self, path, **kwargs):
        output = io.StringIO()
        with patch.object(sp, "HTTP", return_value=self.http), redirect_stdout(output), redirect_stderr(output):
            result = sp.run(path, **kwargs)
        return result, output.getvalue()

    def test_outputs_carry_the_overlay_marker_imagemaid_looks_for_unless_disabled(self):
        def marked(path):
            # The check ImageMaid's --overlays-only applies to every candidate file.
            with Image.open(path) as image:
                tags = image.getexif()
                return tags.get(0x04BC) == "overlay" and tags.get(0x0131) == "Overlayrr"
        path = self.folder_job()
        config = json.loads(path.read_text(encoding="utf-8"))
        config["items"].append({**config["items"][0], "output": "render.jpg"})
        path.write_text(json.dumps(config), encoding="utf-8")
        self.assertEqual(self.run_folder_job(path)[0], 0)
        outputs = {item.suffix: item for item in (self.base / "assets").rglob("render.*")}
        self.assertEqual(set(outputs), {".png", ".jpg"})
        self.assertTrue(all(marked(output) for output in outputs.values()))
        # Turning it off changes the output, so --changed-only rebuilds instead of skipping.
        config["overlay_marker"] = False
        path.write_text(json.dumps(config), encoding="utf-8")
        result, text = self.run_folder_job(path, changed_only=True)
        self.assertEqual(result, 0, text)
        self.assertNotIn("UNCHANGED", text)
        self.assertFalse(any(marked(output) for output in outputs.values()))
        config["overlay_marker"] = "yes"
        path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "overlay_marker"):
            self.run_folder_job(path)

    def test_folder_inputs_are_saved_reused_and_replaced_without_config_edits(self):
        path = self.folder_job()
        self.assertEqual(self.run_folder_job(path)[0], 0)
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        self.assertTrue((folder / "poster.png").is_file())
        self.assertTrue((folder / "logo.png").is_file())
        poster_bytes = (folder / "poster.png").read_bytes()
        self.http.calls.clear()
        self.http.replies.clear()
        self.assertEqual(self.run_folder_job(path)[0], 0)
        self.assertEqual(self.http.calls, [])
        self.assertEqual((folder / "poster.png").read_bytes(), poster_bytes)
        Image.new("RGBA", (20, 30), "blue").save(folder / "poster.png")
        Image.new("RGBA", (20, 5), "lime").save(folder / "logo.png")
        replacement = (folder / "poster.png").read_bytes()
        self.assertEqual(self.run_folder_job(path)[0], 0)
        self.assertEqual(self.http.calls, [])
        self.assertEqual((folder / "poster.png").read_bytes(), replacement)
        with Image.open(folder / "render.png") as image:
            self.assertEqual(image.getpixel((10, 10)), (0, 0, 255))
            self.assertEqual(image.getpixel((100, 150)), (0, 255, 0))

    def test_changed_only_skips_upload_and_detects_artwork_and_layout_changes(self):
        path = self.folder_job(upload=True)
        self.assertEqual(self.run_folder_job(path)[0], 0)
        self.http.calls.clear()
        result, text = self.run_folder_job(path, changed_only=True)
        self.assertEqual(result, 0)
        self.assertIn("UNCHANGED", text)
        self.assertEqual(self.http.calls, [])
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        Image.new("RGBA", (20, 30), "blue").save(folder / "poster.png")
        self.assertEqual(self.run_folder_job(path, changed_only=True)[0], 0)
        self.assertEqual([c[0] for c in self.http.calls], ["POST"])
        self.http.calls.clear()
        self.assertIn("UNCHANGED", self.run_folder_job(path, changed_only=True)[1])
        self.config["layouts"]["custom"]["poster_shift_y"] = 0.05
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertIn("LAYOUT", self.run_folder_job(path, changed_only=True)[1])
        self.assertEqual([c[0] for c in self.http.calls], ["POST"])

    def test_changed_only_retries_failed_upload(self):
        path = self.folder_job(upload=True)
        self.assertEqual(self.run_folder_job(path)[0], 0)
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        Image.new("RGBA", (20, 30), "blue").save(folder / "poster.png")
        with patch.object(self.http, "request", side_effect=RuntimeError("upload unavailable")):
            self.assertEqual(self.run_folder_job(path, changed_only=True)[0], 1)
        self.http.calls.clear()
        result, text = self.run_folder_job(path, changed_only=True)
        self.assertEqual(result, 0)
        self.assertIn("LAYOUT", text)
        self.assertEqual([c[0] for c in self.http.calls], ["POST"])

    def test_missing_folder_logo_is_downloaded_without_replacing_poster(self):
        path = self.folder_job()
        self.assertEqual(self.run_folder_job(path)[0], 0)
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        Image.new("RGBA", (20, 30), "blue").save(folder / "poster.png")
        poster_bytes = (folder / "poster.png").read_bytes()
        (folder / "logo.png").unlink()
        self.http.calls.clear()
        self.assertEqual(self.run_folder_job(path, changed_only=True)[0], 0)
        self.assertTrue(self.http.calls)
        self.assertEqual((folder / "poster.png").read_bytes(), poster_bytes)
        self.assertTrue((folder / "logo.png").is_file())

    def test_initially_missing_logo_recovers_with_existing_textless_poster(self):
        path = self.folder_job()
        data = self.http.replies[common.TMDB + "/movie/603"]
        logos = data["images"].pop("logos")
        self.http.replies[sp.FANART + "/movies/603"] = {}
        self.assertIn("STOCK", self.run_folder_job(path)[1])
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        poster_bytes = (folder / "poster.png").read_bytes()
        self.assertNotIn("stock_poster", sp.ArtworkFiles.metadata(folder))
        self.assertIn("UNCHANGED", self.run_folder_job(path, changed_only=True)[1])  # Still no logo: not rebuilt every run
        data["images"]["logos"] = logos
        self.assertIn("LAYOUT", self.run_folder_job(path, changed_only=True)[1])
        self.assertEqual((folder / "poster.png").read_bytes(), poster_bytes)

    def test_backdrop_is_cropped_into_the_poster_when_no_poster_fits_the_filter(self):
        data = {"title": "Matrix", "images": {
            "posters": [{"file_path": "/original.jpg", "iso_639_1": "en"}],
            "backdrops": [{"file_path": "/small.jpg", "iso_639_1": None, "width": 800},
                          {"file_path": "/wide.jpg", "iso_639_1": None, "width": 1920},
                          {"file_path": "/titled.jpg", "iso_639_1": "en", "width": 3840}],
            "logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]}}
        self.http.replies[common.TMDB + "/movie/603"] = data
        self.http.replies[sp.FANART + "/movies/603"] = {}
        self.http.images[sp.IMAGE_BASE + "/original.jpg"] = Image.new("RGBA", (20, 30), "blue")
        self.http.images[sp.IMAGE_BASE + "/wide.jpg"] = Image.new("RGBA", (60, 40), "green")
        self.http.images[sp.IMAGE_BASE + "/logo.png"] = self.http.images[self.logo_url]
        self.http.images["https://image.tmdb.org/t/p/w300/logo.png"] = self.http.images[self.logo_url]
        textless = sp.Style(poster_filter="textless")
        background, logo, stock = self.artwork.select({"type": "movie", "tmdb_id": 603}, textless)
        self.assertEqual((background.size, stock), ((60, 40), False))  # The widest textless backdrop, not the titled 3840px one
        self.assertIsNotNone(logo)
        # A layout that wants posters with text keeps its poster; so does a title with no logo, which is stock anyway.
        background, _, stock = self.artwork.select({"type": "movie", "tmdb_id": 603}, sp.Style(poster_filter="text"))
        self.assertEqual((background.size, stock), ((20, 30), False))
        del data["images"]["logos"]
        background, logo, stock = self.artwork.select({"type": "movie", "tmdb_id": 603}, textless)
        self.assertEqual((background.size, logo, stock), ((20, 30), None, True))

    def test_saved_stock_poster_is_replaced_once_a_poster_that_fits_turns_up(self):
        path = self.folder_job()
        self.config["layouts"]["custom"]["poster_filter"] = "textless"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        data = self.http.replies[common.TMDB + "/movie/603"]
        data["images"]["posters"] = [{"file_path": "/poster.jpg", "iso_639_1": "en"}]
        self.http.replies[sp.FANART + "/movies/603"] = {}
        self.http.images[sp.IMAGE_BASE + "/wide.jpg"] = Image.new("RGBA", (60, 40), "green")
        self.assertIn("STOCK", self.run_folder_job(path)[1])
        folder = self.base / "assets/movies/The Matrix (1999) {tmdb-603}"
        self.assertIn("stock_poster", sp.ArtworkFiles.metadata(folder))
        self.assertIn("UNCHANGED", self.run_folder_job(path, changed_only=True)[1])  # Still nothing better: not rebuilt every run
        data["images"]["backdrops"] = [{"file_path": "/wide.jpg", "iso_639_1": None, "width": 1920}]
        self.assertIn("LAYOUT", self.run_folder_job(path, changed_only=True)[1])
        self.assertNotIn("stock_poster", sp.ArtworkFiles.metadata(folder))
        with Image.open(folder / "poster.png") as poster:
            self.assertEqual(poster.size, (60, 40))
        self.assertIn("UNCHANGED", self.run_folder_job(path, changed_only=True)[1])

    def test_plex_pagination_and_guids(self):
        self.http.replies[self.artwork.plex.url + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="movie"/></MediaContainer>'
        pages = [b'<MediaContainer totalSize="2"><Video ratingKey="9" type="movie" title="A"><Guid id="tmdb://603"/></Video></MediaContainer>',
                 b'<MediaContainer totalSize="2"><Video ratingKey="10" type="movie" title="B" guid="com.plexapp.agents.imdb://tt1234?lang=en"/></MediaContainer>']
        original_get = self.http.get
        def get(url, **kwargs):
            if url.endswith("/all"):
                self.assertEqual(kwargs["params"]["X-Plex-Container-Start"], 2 - len(pages))
                return pages.pop(0)
            return original_get(url, **kwargs)
        with patch.object(self.http, "get", side_effect=get):
            items = self.artwork.plex.scan()
        self.assertEqual([item["rating_key"] for item in items], ["9", "10"])
        self.assertEqual(items[0]["tmdb_id"], 603)
        self.assertEqual(items[1]["imdb_id"], "tt1234")

    def test_typed_movie_title_lookup_ignores_missing_tv_library(self):
        self.config["plex"]["libraries"] = ["Movies", "TV Shows"]
        self.config["layouts"]["custom"] = {"width": 200, "height": 300}
        self.config["overrides"] = {"9": {"poster": self.poster_url, "logo": self.logo_url}}
        url = self.artwork.plex.url
        self.http.replies[url + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="movie"/><Directory key="2" title="Television" type="show"/></MediaContainer>'
        self.http.replies[url + "/library/sections/1/all"] = b'<MediaContainer totalSize="1"><Video type="movie" ratingKey="9" title="The Matrix" year="1999"/></MediaContainer>'
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(self.run_folder_job(path, title="The Matrix", media_type="movie", year=1999)[0], 0)
        self.assertTrue(rendered_path(self.base, 9).exists())
        self.assertFalse(any("/sections/2/all" in call[1] for call in self.http.calls))
        with self.assertRaisesRegex(ValueError, "TV Shows.*Available libraries.*Television"):
            self.artwork.plex.scan()

    def test_typed_scans_skip_existing_other_type_and_report_missing_matching_library(self):
        self.config["plex"]["libraries"] = ["Movies", "Television", "Obsolete"]
        url = self.artwork.plex.url
        self.http.replies[url + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="movie"/><Directory key="2" title="Television" type="show"/></MediaContainer>'
        self.http.replies[url + "/library/sections/2/all"] = b'<MediaContainer totalSize="1"><Directory type="show" ratingKey="10" title="Show"/></MediaContainer>'
        self.assertEqual([item["rating_key"] for item in self.artwork.plex.scan(media_type="show")], ["10"])
        self.assertFalse(any("/sections/1/all" in call[1] for call in self.http.calls))
        self.config["plex"]["libraries"] = ["Movies", "TV Shows"]
        with self.assertRaisesRegex(ValueError, "No configured show.*Television"):
            self.artwork.plex.scan(media_type="show")

    def test_tmdb_find_and_fanart_auto_selection(self):
        self.http.replies[common.TMDB + "/find/81189"] = {"tv_results": [{"id": 1396}]}
        self.http.replies[common.TMDB + "/tv/1396"] = {"name": "Breaking Bad", "external_ids": {"tvdb_id": 81189}, "images": {}}
        self.http.replies[sp.FANART + "/tv/81189"] = {"tvposter": [{"url": self.poster_url, "lang": "00"}],
                                                     "hdtvlogo": [{"url": self.logo_url, "lang": "en"}]}
        background, logo, stock = self.artwork.select({"type": "tv", "tvdb_id": 81189})
        self.assertFalse(stock)
        self.assertEqual(background.getpixel((0, 0)), (255, 0, 0, 255))
        self.assertEqual(logo.getpixel((0, 0)), (255, 255, 255, 255))
        self.assertFalse(any("thetvdb" in call[1] for call in self.http.calls))

    def test_tvdb_movie_types_and_explicit_text_flag(self):
        self.http.replies[common.TVDB + "/search/remoteid/tt0133093"] = {"data": [{"movie": {"id": 123}}]}
        self.http.replies[common.TVDB + "/movies/123/extended"] = {"data": {"name": "The Matrix", "artworks": [
            {"type": 14, "image": self.poster_url, "language": "eng", "includesText": False},
            {"type": 16, "image": self.logo_url, "language": "eng"}]}}
        self.http.replies[common.TVDB + "/artwork/types"] = {"data": [{"id": 14, "name": "Movie - Poster"}, {"id": 16, "name": "Movie - ClearLogo"}]}
        posters, logos = self.artwork.tvdb_art({"type": "movie", "imdb_id": "tt0133093"})
        self.assertFalse(posters[0]["has_text"])
        self.assertEqual(logos[0]["url"], self.logo_url)
        login = [c for c in self.http.calls if c[0] == "POST"]
        self.assertEqual(len(login), 1)
        self.assertEqual(login[0][2]["json"], {"apikey": "fixture-tvdb"})

    def test_both_manual_overrides_bypass_apis(self):
        background, logo, stock = self.artwork.select({"poster": self.poster_url, "logo": self.logo_url})
        self.assertFalse(stock)
        self.assertEqual(self.http.calls, [])

    def test_manual_poster_with_disabled_logo_bypasses_apis(self):
        _, logo, stock = self.artwork.select({"poster": self.poster_url}, sp.Style(logo_mode="none"))
        self.assertIsNone(logo)
        self.assertFalse(stock)
        self.assertEqual(self.http.calls, [])

    def test_single_override_keeps_automatic_other_asset(self):
        self.http.replies[common.TMDB + "/movie/603"] = {"title": "Matrix", "images": {}}
        self.http.replies[sp.FANART + "/movies/603"] = {"hdmovielogo": [{"url": self.logo_url, "lang": "en"}]}
        _, logo, stock = self.artwork.select({"type": "movie", "tmdb_id": 603, "poster": self.poster_url})
        self.assertFalse(stock)
        self.assertIsNotNone(logo)

    def test_missing_logo_stock_and_skip(self):
        self.http.replies[common.TMDB + "/movie/603"] = {"title": "Matrix", "images": {"posters": [
            {"file_path": "/original.jpg", "iso_639_1": "en"},
            {"file_path": "/textless.jpg", "iso_639_1": None}]}}
        self.http.replies[sp.FANART + "/movies/603"] = {}
        self.http.images[sp.IMAGE_BASE + "/original.jpg"] = Image.new("RGBA", (20, 30), "blue")
        background, logo, stock = self.artwork.select({"type": "movie", "tmdb_id": 603})
        self.assertTrue(stock)
        self.assertIsNone(logo)
        self.assertEqual(background.getpixel((0, 0)), (0, 0, 255, 255))
        self.config["missing_art"] = "skip"
        self.assertEqual(self.artwork.select({"type": "movie", "tmdb_id": 603}), (None, None, True))

    def test_tmdb_failure_still_allows_tvdb_art(self):
        item = {"type": "tv", "tvdb_id": 42}
        self.http.replies[common.TMDB + "/find/42"] = RuntimeError("fixture outage")
        self.http.replies[common.TVDB + "/series/42/extended"] = {"data": {"artworks": [
            {"type": 2, "image": self.poster_url, "includesText": False},
            {"type": 23, "image": self.logo_url, "language": "eng"}]}}
        self.http.replies[common.TVDB + "/artwork/types"] = {"data": [{"id": 2, "name": "Series - Poster"}, {"id": 23, "name": "Series - ClearLogo"}]}
        self.http.replies[sp.FANART + "/tv/42"] = {}
        with redirect_stderr(io.StringIO()):
            _, logo, stock = self.artwork.select(item)
        self.assertFalse(stock)
        self.assertIsNotNone(logo)

    def test_upload_uses_expected_path_headers_and_binary(self):
        self.artwork.plex.upload({"rating_key": 9}, b"jpeg-bytes", "image/jpeg")
        method, url, kwargs = self.http.calls[-1]
        self.assertEqual((method, url), ("POST", self.artwork.plex.url + "/library/metadata/9/posters"))
        self.assertEqual(kwargs["headers"]["Content-Type"], "image/jpeg")
        self.assertEqual(kwargs["data"], b"jpeg-bytes")

    def test_server_completion_labels_preserve_other_labels_and_switch_stock(self):
        self.artwork.plex.settings.pop("completion_label")  # Test the default name.
        item = {"type": "movie", "rating_key": "9"}
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.label_data[url] = {"type": "movie", "rating_key": "9", "labels": ["4K", "Kids & Family"]}
        self.assertEqual(self.artwork.plex.mark_uploaded(item), "Overlayrr")
        self.assertEqual(self.http.label_data[url]["labels"], ["4K", "Kids & Family", "Overlayrr"])
        put = next(call for call in self.http.calls if call[0] == "PUT")
        self.assertEqual(put[2]["params"], {"type": 1, "label.locked": 1, "label[0].tag.tag": "4K",
                                          "label[1].tag.tag": "Kids & Family", "label[2].tag.tag": "Overlayrr"})
        self.http.calls.clear()
        self.artwork.plex.mark_uploaded(item)
        self.assertEqual([call[0] for call in self.http.calls], ["GET"])
        self.assertEqual(self.artwork.plex.mark_uploaded(item, stock=True), "Overlayrr: Stock")
        self.assertEqual(self.http.label_data[url]["labels"], ["4K", "Kids & Family", "Overlayrr: Stock"])
        self.artwork.plex.mark_uploaded(item)
        self.assertEqual(self.http.label_data[url]["labels"], ["4K", "Kids & Family", "Overlayrr"])

    def test_shows_and_seasons_label_their_own_rating_keys(self):
        self.artwork.plex.settings["completion_label"] = "My Posters"
        for item, kind, type_id in (({"type": "tv", "rating_key": "10"}, "show", 2),
                                    ({"type": "tv", "rating_key": "11", "parent_rating_key": "10", "season": 1}, "season", 3)):
            url = self.artwork.plex.url + f"/library/metadata/{item['rating_key']}"
            self.http.label_data[url] = {"type": kind, "rating_key": item["rating_key"], "labels": []}
            self.http.calls.clear()
            self.assertEqual(self.artwork.plex.mark_uploaded(item), "My Posters")
            self.assertEqual({call[1] for call in self.http.calls}, {url})
            self.assertEqual(next(call for call in self.http.calls if call[0] == "PUT")[2]["params"]["type"], type_id)

    def test_label_read_failure_never_replaces_existing_labels(self):
        self.artwork.plex.settings["completion_label"] = "Overlayrr"
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.replies[url] = b'<MediaContainer><Video ratingKey="8" type="movie"/></MediaContainer>'
        with self.assertRaisesRegex(ValueError, "requested movie 9"):
            self.artwork.plex.mark_uploaded({"type": "movie", "rating_key": "9"})
        self.assertEqual([call[0] for call in self.http.calls], ["GET"])

    def test_label_added_only_after_successful_upload_and_verified_before_cache(self):
        path = self.folder_job(upload=True)
        self.config["plex"]["completion_label"] = "Overlayrr"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.label_data[url] = {"type": "movie", "rating_key": "9", "labels": ["Keep"]}
        self.assertEqual(self.run_folder_job(path)[0], 0)
        server_calls = [call[0] for call in self.http.calls if call[1].startswith(self.artwork.plex.url)]
        self.assertEqual(server_calls, ["GET", "POST", "GET", "PUT", "GET"])  # The server's ID (once, then remembered), then upload and label
        self.http.calls.clear()
        self.assertIn("UNCHANGED", self.run_folder_job(path, changed_only=True)[1])
        self.assertEqual(self.http.calls, [])
        # Even a forced resend with the same inputs must retry after a failed upload.
        with patch.object(self.http, "request", side_effect=RuntimeError("upload failed")):
            self.assertEqual(self.run_folder_job(path)[0], 1)
        self.assertFalse(any(call[0] == "GET" for call in self.http.calls))
        self.http.calls.clear()
        self.assertIn("LAYOUT", self.run_folder_job(path, changed_only=True)[1])
        self.assertEqual([call[0] for call in self.http.calls], ["POST", "GET"])

    def test_upload_also_sends_and_selects_the_logo(self):
        path = self.folder_job(upload=True, logo=True)
        listing, select = (self.artwork.plex.url + "/library/metadata/9/" + name for name in ("clearLogos", "clearLogo"))
        self.http.replies[listing] = b"<MediaContainer/>"
        self.assertEqual(self.run_folder_job(path)[0], 0)
        posts = [call for call in self.http.calls if call[:2] == ("POST", listing)]
        self.assertEqual(len(posts), 1)
        key = "upload://clearLogos/" + sp.hashlib.sha1(posts[0][2]["data"]).hexdigest()
        self.http.replies[listing] = f'<MediaContainer><Photo ratingKey="{key}"/></MediaContainer>'.encode()
        self.http.calls.clear()
        self.assertEqual(self.run_folder_job(path)[0], 0)  # Plex already has it: selected, not uploaded again
        self.assertFalse(any(call[:2] == ("POST", listing) for call in self.http.calls))
        self.assertEqual([call[2]["params"] for call in self.http.calls if call[:2] == ("PUT", select)], [{"url": key}])

    def test_unconfirmed_label_errors_and_retries_instead_of_marking_complete(self):
        path = self.folder_job(upload=True)
        self.config["plex"]["completion_label"] = "Overlayrr"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.label_data[url] = {"type": "movie", "rating_key": "9", "labels": ["Keep"]}
        original_request = self.http.request
        def silent_put(method, request_url, **kwargs):
            if method == "PUT":
                return Response({})  # Success response but the server ignored the edit.
            return original_request(method, request_url, **kwargs)
        with patch.object(self.http, "request", side_effect=silent_put):
            result, output = self.run_folder_job(path)
        self.assertEqual(result, 1)
        self.assertIn("did not confirm", output)
        self.assertFalse((self.http.cache / "renders").exists())
        result, output = self.run_folder_job(path, changed_only=True)
        self.assertEqual(result, 0)
        self.assertIn("Plex: Overlayrr", output)
        self.assertEqual(self.http.label_data[url]["labels"], ["Keep", "Overlayrr"])

    def test_local_only_run_does_not_add_server_labels(self):
        path = self.folder_job(upload=False)
        self.config["plex"]["completion_label"] = "Overlayrr"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(self.run_folder_job(path)[0], 0)
        self.assertFalse(any(call[1].startswith(self.artwork.plex.url) for call in self.http.calls))

    def test_added_sends_what_plex_lacks_and_skips_what_it_has(self):
        path = self.folder_job(upload=True)
        self.config["plex"]["completion_label"] = "Overlayrr"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.label_data[url] = {"type": "movie", "rating_key": "9", "labels": []}
        posts = lambda: [call[1] for call in self.http.calls if call[0] == "POST"]
        with patch.object(self.http, "request", side_effect=RuntimeError("upload failed")):
            self.assertEqual(self.run_folder_job(path, rating_key=9, added=True)[0], 1)  # Rendered, never sent
        self.http.calls.clear()
        result, output = self.run_folder_job(path, rating_key=9, added=True)
        self.assertEqual(result, 0)
        self.assertIn("LAYOUT", output)  # The file was there, but Plex had nothing: built again and sent
        self.assertEqual((posts(), self.http.label_data[url]["labels"]), ([url + "/posters"], ["Overlayrr"]))
        self.http.calls.clear()
        self.assertIn("EXISTS", self.run_folder_job(path, rating_key=9, added=True)[1])  # Plex has it: nothing to do
        self.assertEqual(posts(), [])
        self.http.label_data[url]["labels"] = []  # The same file for a title Plex knows afresh
        self.http.calls.clear()
        result, output = self.run_folder_job(path, rating_key=9, added=True)
        self.assertIn("RELOAD", output)  # Sent as it is, not rendered again
        self.assertEqual((posts(), self.http.label_data[url]["labels"]), ([url + "/posters"], ["Overlayrr"]))

    def test_added_key_of_a_season_or_episode_becomes_its_show_and_numbers(self):
        base = self.artwork.plex.url + "/library/metadata/"
        self.http.replies[base + "9"] = b'<MediaContainer><Video ratingKey="9" type="movie"/></MediaContainer>'
        self.http.replies[base + "21"] = b'<MediaContainer><Directory ratingKey="21" type="season" parentRatingKey="20" index="2"/></MediaContainer>'
        self.http.replies[base + "22"] = (b'<MediaContainer><Video ratingKey="22" type="episode" parentRatingKey="21" '
                                          b'grandparentRatingKey="20" parentIndex="2" index="5"/></MediaContainer>')
        plex = self.artwork.plex
        self.assertEqual([plex.added_target(key) for key in (9, 21, 22)], [(9, None, None), (20, 2, None), (20, 2, 5)])

    def test_force_one_plex_id_bypasses_changed_only_and_updates_only_target(self):
        self.config["plex"].update(upload=True, completion_label="Overlayrr")
        self.config["layouts"]["custom"] = {"width": 200, "height": 300}
        self.config["items"] = [{"rating_key": "10", "poster": "unrelated-missing.jpg", "logo": "unrelated-missing.png"}]
        self.config["overrides"] = {"9": {"poster": self.poster_url, "logo": self.logo_url}}
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.label_data[url] = {"type": "movie", "rating_key": "9", "labels": []}
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(self.run_folder_job(path, rating_key=9, force=True)[0], 0)
        other = self.base / "assets/movies/Other {plex-10}/rendered.jpg"
        other.parent.mkdir(parents=True)
        other.write_bytes(b"unrelated output stays untouched")
        self.http.calls.clear()
        result, output = self.run_folder_job(path, rating_key=9, force=True, changed_only=True)
        self.assertEqual(result, 0)
        self.assertIn("LAYOUT", output)
        self.assertNotIn("UNCHANGED", output)
        self.assertEqual(other.read_bytes(), b"unrelated output stays untouched")
        self.assertEqual([call[1] for call in self.http.calls if call[0] == "POST"], [url + "/posters"])
        self.assertFalse(any("/library/sections" in call[1] or "/metadata/10" in call[1] for call in self.http.calls))
        self.assertEqual(self.http.label_data[url]["labels"], ["Overlayrr"])

    def test_exact_title_filters_and_ambiguity_never_process_other_titles(self):
        self.config["layouts"]["custom"] = {"width": 200, "height": 300}
        candidates = [{"type": kind, "title": "The Matrix", "year": str(year), "rating_key": key,
                       "poster": self.poster_url, "logo": self.logo_url}
                      for kind, year, key in (("movie", 1999, "9"), ("movie", 2021, "10"), ("tv", 1999, "11"))]
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        with patch.object(sp.Plex, "scan", return_value=candidates):
            with self.assertRaisesRegex(ValueError, "Ambiguous.*Plex ID 9.*Plex ID 10"):
                self.run_folder_job(path, title="The Matrix", force=True)
            with self.assertRaisesRegex(ValueError, "No movie/show matches"):
                self.run_folder_job(path, title="Not The Matrix", force=True)
            self.assertFalse((self.base / "output").exists())
            self.assertFalse((self.base / "assets").exists())
            self.assertEqual(self.http.calls, [])
            self.assertEqual(self.run_folder_job(path, title="the matrix", media_type="movie", year=1999, force=True)[0], 0)
        self.assertEqual(list((self.base / "assets").rglob("rendered.jpg")), [rendered_path(self.base, 9)])
        self.assertFalse((self.base / "output").exists())

    def test_targeted_show_defaults_to_series_and_expands_only_its_seasons_on_request(self):
        self.config["plex"].update(include_seasons=True, upload=True)
        self.config["layouts"]["custom"] = {"width": 200, "height": 300}
        self.config["items"] = [{"type": "tv", "rating_key": "20", "title": "Other show", "poster": "missing.jpg"}]
        self.config["overrides"] = {"10": {"poster": self.poster_url, "logo": self.logo_url},
                                    "11": {"poster": self.poster_url}, "12": {"poster": self.poster_url}}
        url = self.artwork.plex.url + "/library/metadata/10"
        self.http.replies[url] = b'<MediaContainer><Directory type="show" ratingKey="10" title="Target"><Guid id="tmdb://1396"/></Directory></MediaContainer>'
        self.http.replies[url + "/children"] = b'<MediaContainer><Directory type="season" ratingKey="11" index="1"/><Directory type="season" ratingKey="12" index="0"/></MediaContainer>'
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(self.run_folder_job(path, rating_key=10, force=True)[0], 0)
        self.assertFalse(any(call[1].endswith("/children") for call in self.http.calls))
        self.assertEqual([call[1] for call in self.http.calls if call[0] == "POST"], [url + "/posters"])
        self.http.calls.clear()
        self.assertEqual(self.run_folder_job(path, rating_key=10, force=True, with_seasons=True)[0], 0)
        uploads = {call[1] for call in self.http.calls if call[0] == "POST"}
        self.assertEqual(uploads, {f"{self.artwork.plex.url}/library/metadata/{key}/posters" for key in (10, 11, 12)})
        self.assertFalse(any("/library/sections" in call[1] or "/metadata/20" in call[1] for call in self.http.calls))

    def test_invalid_direct_target_and_selector_combinations_fail_before_writes(self):
        path = self.folder_job()
        self.config["items"] = []
        path.write_text(json.dumps(self.config), encoding="utf-8")
        url = self.artwork.plex.url + "/library/metadata/9"
        self.http.replies[url] = b'<MediaContainer><Directory type="season" ratingKey="9"/></MediaContainer>'
        with self.assertRaisesRegex(ValueError, "not a movie, show or collection"):
            self.run_folder_job(path, rating_key=9, force=True)
        self.http.replies[url] = b'<MediaContainer><Video type="movie" ratingKey="8"/></MediaContainer>'
        with self.assertRaisesRegex(ValueError, "not found"):
            self.run_folder_job(path, rating_key=9, force=True)
        for options in ({"force": True}, {"with_seasons": True}, {"rating_key": 9, "limit": 1},
                        {"rating_key": 0}, {"title": ""}, {"title": "Matrix", "year": 99}):
            with self.assertRaises(ValueError):
                self.run_folder_job(path, **options)
        self.assertFalse((self.base / "output").exists())
        self.assertFalse(any(call[0] == "POST" for call in self.http.calls))

    def test_complete_scan_lookup_render_save_upload_pipeline(self):
        self.config["plex"]["upload"] = True
        self.config["layouts"]["custom"] = {"width": 200, "height": 300, "grain_seed": 42}
        self.http.replies[self.artwork.plex.url + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="movie"/></MediaContainer>'
        self.http.replies[self.artwork.plex.url + "/library/sections/1/all"] = b'<MediaContainer totalSize="1"><Video ratingKey="9" type="movie" title="Matrix"><Guid id="tmdb://603"/></Video></MediaContainer>'
        self.http.replies[common.TMDB + "/movie/603"] = {"images": {
            "posters": [{"file_path": "/poster.jpg", "iso_639_1": None}],
            "logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]}}
        self.http.images[sp.IMAGE_BASE + "/poster.jpg"] = self.http.images[self.poster_url]
        self.http.images[sp.IMAGE_BASE + "/logo.png"] = self.http.images[self.logo_url]
        self.http.images["https://image.tmdb.org/t/p/w300/logo.png"] = self.http.images[self.logo_url]
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        with patch.object(sp, "HTTP", return_value=self.http), redirect_stdout(io.StringIO()):
            result = sp.run(path)
        self.assertEqual(result, 0)
        output = rendered_path(self.base, 9)
        self.assertTrue(output.is_file())
        uploads = [call for call in self.http.calls if call[0] == "POST"]
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0][2]["data"], output.read_bytes())
        self.assertFalse(any("fanart" in call[1] or "thetvdb" in call[1] for call in self.http.calls))

    def test_transparent_logo_is_not_selected(self):
        self.http.images[self.logo_url] = Image.new("RGBA", (20, 5), (255, 255, 255, 0))
        self.assertEqual(self.artwork.pick_logo([{"url": self.logo_url, "language": "en"}]), (None, False))

    def test_logo_min_brightness_skips_black_and_dark_logos_but_keeps_colored_ones(self):
        urls = {"black": (10, 10, 10, 255), "navy": (20, 30, 90, 255), "red": (210, 40, 40, 255)}
        logos = []
        for index, (name, color) in enumerate(urls.items()):
            url = f"https://art.invalid/{name}.png"
            self.http.images[url] = Image.new("RGBA", (20, 5), color)
            logos.append({"url": url, "language": "en", "width": 1000 - index})  # Black ranks first, then navy, then red
        for preference in ("any", "white"):
            # Without a floor both pick black: "any" takes the first, "white" falls back to the first when none is white.
            self.assertEqual(self.artwork.pick_logo(logos, preference)[0]["url"].rsplit("/", 1)[1], "black.png")
            self.assertEqual(self.artwork.pick_logo(logos, preference, 60)[0]["url"].rsplit("/", 1)[1], "red.png")
            self.assertEqual(self.artwork.pick_logo(logos[:2], preference, 60), (None, False))
        self.assertEqual(sp.Style(logo_min_brightness=60).logo_min_brightness, 60)
        with self.assertRaises(ValueError):
            sp.Style(logo_min_brightness=300)

    def test_seasons_and_episodes_use_the_series_logo_chosen_with_the_series_layout(self):
        self.http.replies[common.TMDB + "/tv/1396"] = {"name": "Show", "images": {"posters": [], "logos": [
            {"file_path": "/black.png", "iso_639_1": "en", "width": 900},
            {"file_path": "/red.png", "iso_639_1": "en", "width": 800}]}}
        self.http.replies[common.TMDB + "/tv/1396/season/1"] = {"episodes": [{"episode_number": 1, "name": "Pilot", "still_path": "/still.jpg"}]}
        for name, color in (("black", (10, 10, 10, 255)), ("red", (210, 40, 40, 255))):
            for base in (sp.IMAGE_BASE, "https://image.tmdb.org/t/p/w300"):
                self.http.images[f"{base}/{name}.png"] = Image.new("RGBA", (20, 5), color)
        self.http.images[sp.IMAGE_BASE + "/still.jpg"] = Image.new("RGBA", (64, 36), "blue")
        # Season/episode styles that would pick black if they chose for themselves; the series layout wants color.
        series = sp.Style(logo_preference="color")
        child = sp.Style(logo_preference="any")
        show = {"type": "tv", "title": "Show", "tmdb_id": 1396, "poster": self.poster_url}
        _, logo, _ = self.artwork.select({**show, "season": 1}, child, False, series)
        self.assertEqual(logo.getpixel((0, 0)), (210, 40, 40, 255))
        _, logo, _ = self.artwork.select({**show, "season": 1, "episode": 1, "episode_title": "Pilot"}, child, False, series)
        self.assertEqual(logo.getpixel((0, 0)), (210, 40, 40, 255))
        # One choice per series per run, however many seasons and episodes ask.
        self.assertEqual(len([call for call in self.http.calls if call[1] == common.TMDB + "/tv/1396"]), 1)
        # A season with its own poster doesn't search any provider for artwork it won't use.
        calls = len(self.http.calls)
        self.artwork.select({**show, "season": 2}, child, False, series)
        self.assertEqual([call[1] for call in self.http.calls[calls:]], [])

    def test_season_and_episode_options_cannot_override_logo_choice(self):
        for kind in ("season_options", "episode_options"):
            for setting in ({"logo_preference": "color"}, {"logo_min_brightness": 10}):
                with self.assertRaisesRegex(ValueError, "series' logo"):
                    sp.layout_styles(configured(layouts={"custom": {kind: setting}}))
        sp.layout_styles(configured(layouts={"custom": {"logo_preference": "color", "season_options": {"logo_mode": "none"}}}))

    def test_color_preference_avoids_black_and_does_not_favor_white(self):
        colors = {"black": (10, 10, 10, 255), "white": (250, 250, 250, 255), "pale": (230, 180, 180, 255),
                  "vivid": (210, 40, 40, 255), "navy": (20, 30, 90, 255)}
        logos = {}
        for index, (name, color) in enumerate(colors.items()):
            url = f"https://art.invalid/{name}.png"
            self.http.images[url] = Image.new("RGBA", (20, 5), color)
            logos[name] = {"url": url, "language": "en", "width": 1000 - index}  # Ranked in the order above
        def pick(*names, minimum=0):
            art, ideal = self.artwork.pick_logo([logos[name] for name in names], "color", minimum)
            return (art["url"].rsplit("/", 1)[1][:-4] if art else None), ideal
        # Black is never chosen and white doesn't win over a colored logo, even when it ranks first.
        self.assertEqual(pick("black", "white", "pale", "vivid"), ("pale", True))    # the higher-ranked colored logo wins, however vivid the other        self.assertEqual(pick("white", "black", "navy", "pale"), ("pale", True))     # navy is too dark to count
        self.assertEqual(pick("black", "white"), ("white", False))                   # white only as a fallback
        self.assertEqual(pick("black", "navy"), (None, False))                       # nothing acceptable
        self.assertEqual(pick("black", "pale", minimum=200), (None, False))          # an explicit floor still applies
        self.assertEqual(sp.Style(logo_preference="COLOR").logo_preference, "color")

    def test_any_and_white_logo_preferences(self):
        red = "https://art.invalid/red.png"
        self.http.images[red] = Image.new("RGBA", (20, 5), "red")
        logos = [{"url": red, "language": "en"}, {"url": self.logo_url, "language": "en"}]
        self.assertEqual(self.artwork.pick_logo(logos, "any")[0]["url"], red)
        self.assertEqual(self.artwork.pick_logo(logos, "white")[0]["url"], self.logo_url)
        self.assertEqual(sp.Style(logo_preference="Any").logo_preference, "any")

    def test_poster_filter_text_and_disabled_logo(self):
        self.http.replies[common.TMDB + "/movie/603"] = {"images": {"posters": [
            {"file_path": "/neutral.jpg", "iso_639_1": None},
            {"file_path": "/title.jpg", "iso_639_1": "en"}]}}
        self.http.images[sp.IMAGE_BASE + "/title.jpg"] = Image.new("RGBA", (20, 30), "blue")
        background, logo, stock = self.artwork.select({"type": "movie", "tmdb_id": 603},
                                                      sp.Style(poster_filter="text", logo_mode="none"))
        self.assertEqual(background.getpixel((0, 0)), (0, 0, 255, 255))
        self.assertIsNone(logo)
        self.assertFalse(stock)

    def test_tmdb_season_artwork_precedes_series_and_keeps_series_logo(self):
        self.http.replies[common.TMDB + "/tv/1396"] = {"images": {"posters": [{"file_path": "/series.jpg"}],
                                                               "logos": [{"file_path": "/logo.png"}]}}
        self.http.replies[common.TMDB + "/tv/1396/season/1/images"] = {"posters": [{"file_path": "/season.jpg"}]}
        posters, logos = self.artwork.tmdb_art({"type": "tv", "tmdb_id": 1396, "season": 1})
        self.assertTrue(posters[0]["url"].endswith("/season.jpg"))
        self.assertTrue(logos[0]["url"].endswith("/logo.png"))
        self.http.replies[common.TMDB + "/tv/1396/season/1/images"] = RuntimeError("HTTP 404")
        with redirect_stderr(io.StringIO()):
            posters, _ = self.artwork.tmdb_art({"type": "tv", "tmdb_id": 1396, "season": 1})
        self.assertTrue(posters[0]["url"].endswith("/series.jpg"))

    def test_fanart_season_filter(self):
        self.http.replies[sp.FANART + "/tv/81189"] = {"seasonposter": [
            {"season": "2", "url": "https://art.invalid/wrong.jpg"},
            {"season": "1", "url": self.poster_url}], "tvposter": [{"url": "https://art.invalid/series.jpg"}]}
        posters, _ = self.artwork.fanart_art({"type": "tv", "tvdb_id": 81189, "season": 1})
        self.assertEqual(posters[0]["url"], self.poster_url)
        self.assertEqual(len(posters), 2)

    def test_tvdb_maps_season_number_to_internal_official_season_id(self):
        self.http.replies[common.TVDB + "/series/81189/extended"] = {"data": {"seasons": [
            {"id": 9876, "number": 1, "type": {"type": "official"}},
            {"id": 5555, "number": 1, "type": {"type": "dvd"}}], "artworks": [
            {"type": 23, "image": self.logo_url}]}}
        self.http.replies[common.TVDB + "/seasons/9876/extended"] = {"data": {"artwork": [
            {"type": 7, "image": self.poster_url, "includesText": False}]}}
        self.http.replies[common.TVDB + "/artwork/types"] = {"data": [
            {"id": 7, "name": "Season - Poster"}, {"id": 23, "name": "Series - ClearLogo"}]}
        posters, logos = self.artwork.tvdb_art({"type": "tv", "tvdb_id": 81189, "season": 1})
        self.assertEqual(posters[0]["url"], self.poster_url)
        self.assertEqual(logos[0]["url"], self.logo_url)
        self.assertFalse(any("/seasons/1/" in call[1] or "/seasons/5555/" in call[1] for call in self.http.calls))

    def test_season_pipeline_inherits_layout_and_uses_own_plex_upload_id(self):
        self.config["plex"].update(include_seasons=True, upload=True)
        self.config["layout_by_type"] = {"tv": "show-look"}
        self.config["layouts"]["show-look"] = {"width": 200, "height": 300, "grain_amount": 0,
            "uniform_logo_max_w": 1500, "uniform_logo_max_h": 500,
            "season_options": {"text_overlay_enabled": True, "custom_text": "{season}", "font_size": 150, "position_y": 0.95}}
        self.http.replies[self.artwork.plex.url + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="show"/></MediaContainer>'
        self.http.replies[self.artwork.plex.url + "/library/sections/1/all"] = b'<MediaContainer totalSize="1"><Directory type="show" ratingKey="10" title="Show"><Guid id="tmdb://1396"/></Directory></MediaContainer>'
        self.http.replies[self.artwork.plex.url + "/library/metadata/10/children"] = b'<MediaContainer><Directory type="season" ratingKey="11" index="1" title="Season 1"/><Directory type="season" ratingKey="12" index="0" title="Specials"/></MediaContainer>'
        self.config["overrides"] = {"10": {"poster": self.poster_url, "logo": self.logo_url},
                                    "11": {"poster": self.poster_url}, "12": {"poster": self.poster_url}}
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        with patch.object(sp, "HTTP", return_value=self.http), redirect_stdout(io.StringIO()):
            self.assertEqual(sp.run(path), 0)
        uploads = {call[1] for call in self.http.calls if call[0] == "POST"}
        self.assertEqual(uploads, {f"{self.artwork.plex.url}/library/metadata/{key}/posters" for key in (10, 11, 12)})
        paths = [rendered_path(self.base, key) for key in (10, 11, 12)]
        self.assertEqual([path.parent.name for path in paths[1:]], ["Season 01", "Season 00"])
        self.assertTrue(all(path.parent.parent == paths[0].parent for path in paths[1:]))
        images = [Image.open(path) for path in paths]
        try:
            self.assertNotEqual(images[0].tobytes(), images[1].tobytes())
            self.assertNotEqual(images[1].tobytes(), images[2].tobytes())
        finally:
            for image in images:
                image.close()

    def test_remake_renders_everything_and_refresh_resends_current_files_to_plex(self):
        path = self.folder_job(upload=True)
        posts = lambda: len([call for call in self.http.calls if call[0] == "POST"])
        self.assertEqual(self.run_folder_job(path)[0], 0)
        output = next((self.base / "assets").rglob("render.png"))
        self.assertEqual(posts(), 1)
        # --changed-only alone skips the unchanged item; --remake (no selector needed) overrides that.
        result, text = self.run_folder_job(path, changed_only=True)
        self.assertIn("UNCHANGED", text)
        self.assertEqual(posts(), 1)
        before = output.stat().st_mtime_ns
        result, text = self.run_folder_job(path, changed_only=True, force=True)
        self.assertEqual(result, 0, text)
        self.assertIn("LAYOUT", text)
        self.assertGreater(output.stat().st_mtime_ns, before)
        self.assertEqual(posts(), 2)
        # --refresh uploads the existing file again without rendering it.
        before = output.stat().st_mtime_ns
        result, text = self.run_folder_job(path, refresh=True)
        self.assertEqual(result, 0, text)
        self.assertIn("RELOAD", text)
        self.assertEqual(output.stat().st_mtime_ns, before)
        self.assertEqual(posts(), 3)
        # A stale file is rendered (and uploaded) instead of resent as is.
        config = json.loads(path.read_text(encoding="utf-8"))
        config["quality"] = 80
        path.write_text(json.dumps(config), encoding="utf-8")
        result, text = self.run_folder_job(path, refresh=True)
        self.assertIn("LAYOUT", text)
        self.assertEqual(posts(), 4)
        with self.assertRaises(ValueError):
            self.run_folder_job(path, refresh=True, changed_only=True)
        config["plex"]["upload"] = False
        path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "plex.upload"):
            self.run_folder_job(path, refresh=True)

    def test_poster_and_icons_flags_download_ranked_candidates_without_rendering_or_uploading(self):
        path = self.folder_job(upload=True)
        config = json.loads(path.read_text(encoding="utf-8"))
        config["layouts"]["custom"]["poster_filter"] = "textless"
        path.write_text(json.dumps(config), encoding="utf-8")
        self.http.replies[common.TMDB + "/movie/603"]["images"] = {
            "posters": [{"file_path": "/p1.jpg", "iso_639_1": None, "width": 2000},
                        {"file_path": "/p2.jpg", "iso_639_1": "en", "width": 3000},
                        {"file_path": "/p3.jpg", "iso_639_1": None, "width": 1000}],
            "logos": [{"file_path": "/logo.png", "iso_639_1": "en", "width": 500},
                      {"file_path": "/blank.png", "iso_639_1": "en", "width": 900}]}
        self.http.replies[sp.FANART + "/movies/603"] = {}
        self.http.images["https://image.tmdb.org/t/p/w300/blank.png"] = Image.new("RGBA", (20, 5), (0, 0, 0, 0))
        for name in ("p1", "p2", "p3"):
            buffer = io.BytesIO()
            Image.new("RGB", (20, 30), "red").save(buffer, format="JPEG")
            self.http.replies[sp.IMAGE_BASE + f"/{name}.jpg"] = buffer.getvalue()
        for name in ("logo", "blank"):
            buffer = io.BytesIO()
            Image.new("RGBA", (20, 5), "white").save(buffer, format="PNG")
            self.http.replies[sp.IMAGE_BASE + f"/{name}.png"] = buffer.getvalue()

        def files(stem):
            return sorted(path.name for path in (self.base / "assets").rglob("*") if path.is_file() and path.stem.startswith(stem) and path.stem[len(stem):].isdigit())
        result, output = self.run_folder_job(path, rating_key=9, posters=1, icons=1)
        self.assertEqual(result, 0, output)
        self.assertEqual(files("poster")[0].split(".")[0], "poster2")
        self.assertEqual(len(files("poster")), 1)
        self.assertIn("tmdb, no language, 2000w", output)  # best textless, not the 3000px text poster
        self.assertEqual(len(files("logo")), 1)
        result, output = self.run_folder_job(path, rating_key=9, posters="all", icons="all")
        self.assertEqual(result, 0, output)
        self.assertEqual([name.split(".")[0] for name in files("poster")], ["poster2", "poster3"])
        self.assertEqual(len(files("logo")), 1)  # the blank logo never qualifies
        self.assertIn("3 saved", output)  # two posters and the logo, each overwriting its number
        self.assertFalse(list((self.base / "assets").rglob("render.png")))
        self.assertFalse(list((self.base / "assets").rglob("poster.*")))
        self.assertFalse([call for call in self.http.calls if call[0] == "POST"])
        for bad in ({"posters": 0}, {"icons": "some"}, {"posters": 2}):
            with self.assertRaises(ValueError):
                self.run_folder_job(path, **bad)

    def test_episode_title_cards_use_tmdb_still_show_logo_and_own_plex_upload_id(self):
        self.config["plex"].update(include_episodes=True, upload=True)
        self.config["layouts"]["custom"] = {"width": 200, "height": 300, "episode_options": {
            "width": 320, "height": 180, "uniform_logo_max_w": 1155, "uniform_logo_max_h": 650,
            "text_transform": "uppercase", "title_font_size": 40, "index_font_size": 20}}
        plex = self.artwork.plex.url
        self.http.replies[plex + "/library/sections"] = b'<MediaContainer><Directory key="1" title="Movies" type="show"/></MediaContainer>'
        self.http.replies[plex + "/library/sections/1/all"] = b'<MediaContainer totalSize="1"><Directory type="show" ratingKey="10" title="Show"><Guid id="tmdb://1396"/></Directory></MediaContainer>'
        self.http.replies[plex + "/library/metadata/10/allLeaves"] = (
            b'<MediaContainer totalSize="2"><Video type="episode" ratingKey="21" parentIndex="1" index="1" title="Pilot"/>'
            b'<Video type="episode" ratingKey="22" parentIndex="1" index="2" title=""/></MediaContainer>')
        self.http.replies[common.TMDB + "/tv/1396/season/1"] = {"episodes": [
            {"episode_number": 1, "name": "Pilot", "still_path": "/still1.jpg"},
            {"episode_number": 2, "name": "Cat's in the Bag", "still_path": "/still2.jpg"}]}
        for name, color in (("still1", "blue"), ("still2", "green")):
            self.http.images[sp.IMAGE_BASE + f"/{name}.jpg"] = Image.new("RGBA", (64, 36), color)
        self.config["overrides"] = {"10": {"poster": self.poster_url, "logo": self.logo_url}}
        path = self.base / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        with patch.object(sp, "HTTP", return_value=self.http), redirect_stdout(io.StringIO()):
            self.assertEqual(sp.run(path), 0)
        uploads = {call[1] for call in self.http.calls if call[0] == "POST"}
        self.assertEqual(uploads, {f"{plex}/library/metadata/{key}/posters" for key in (10, 21, 22)})
        cards = [rendered_path(self.base, key) for key in (21, 22)]
        self.assertEqual([card.parent.name for card in cards], ["Episode 01", "Episode 02"])
        self.assertTrue(all(card.parent.parent.name == "Season 01" for card in cards))
        with Image.open(cards[0]) as first, Image.open(cards[1]) as second:
            self.assertEqual(first.size, (320, 180))
            self.assertNotEqual(first.tobytes(), second.tobytes())
        self.assertEqual(json.loads((cards[1].parent / ".overlayrr.json").read_text())["episode_title"], "Cat's in the Bag")
        self.assertTrue(list(cards[0].parent.parent.parent.glob("logo.*")))


    def test_build_collections_plans_creates_adopts_and_trims(self):
        plex = "http://plex.invalid:32400"
        def video(key, title, tmdb):
            return f'<Video ratingKey="{key}" title="{title}" type="movie"><Guid id="tmdb://{tmdb}"/></Video>'
        def container(*parts, **attributes):
            fields = "".join(f' {name}="{value}"' for name, value in attributes.items())
            return f"<MediaContainer{fields}>{''.join(parts)}</MediaContainer>".encode()
        self.http.replies.update({
            plex + "/library/sections": container('<Directory key="1" title="Movies" type="movie"/>'),
            plex + "/library/sections/1/all": container(video(1, "Alien", 10), video(2, "Aliens", 11), video(3, "Heat", 20),
                                                        video(4, "Ronin", 21), video(5, "Solo", 30), totalSize=5),
            plex + "/library/sections/1/collections": container(
                '<Directory ratingKey="900" title="Alien" type="collection" subtype="movie"/>', totalSize=1),
            plex + "/library/metadata/900/children": container(video(1, "Alien", 10), video(7, "Spin-off", 99)),
            plex + "/": container(machineIdentifier="MID"),
            common.TMDB + "/movie/10": {"belongs_to_collection": {"id": 100, "name": "Alien Collection"}},
            common.TMDB + "/movie/11": {"belongs_to_collection": {"id": 100, "name": "Alien Collection"}},
            common.TMDB + "/movie/20": {"belongs_to_collection": {"id": 200, "name": "Heat Collection"}},
            common.TMDB + "/movie/21": {"belongs_to_collection": {"id": 200, "name": "Heat Collection"}},
            common.TMDB + "/movie/30": {"belongs_to_collection": None}})
        calls = []
        class Created(Response):
            content = b'<MediaContainer><Directory ratingKey="950"/></MediaContainer>'
        self.http.request = lambda method, url, **kwargs: (calls.append((method, url.removeprefix(plex), kwargs.get("params"))), Created({}))[1]

        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pc.build_collections(self.artwork, False), 0)
        self.assertEqual(calls, [])  # A plan never writes
        for line in ("PLAN CREATE Heat [Movies]: 2 movies", "PLAN UPDATE Alien [Movies]: +Aliens; -Spin-off"):
            self.assertIn(line, output.getvalue())

        kept = []
        with redirect_stdout(io.StringIO()):
            self.assertEqual(pc.build_collections(self.artwork, True, kept=kept), 0)
        self.assertEqual(kept, [{"name": "Alien", "library": "Movies", "kind": "franchise", "items": 2, "rating_key": "900"},
                                {"name": "Heat", "library": "Movies", "kind": "franchise", "items": 2, "rating_key": "950"}])
        uri = "server://MID/com.plexapp.plugins.library/library/metadata/"
        self.assertIn(("POST", "/library/collections", {"type": 1, "title": "Heat", "smart": 0, "sectionId": "1", "uri": uri + "3,4"}), calls)
        self.assertIn(("PUT", "/library/metadata/950/prefs", {"collectionSort": 0}), calls)
        self.assertIn(("PUT", "/library/collections/900/items", {"uri": uri + "2"}), calls)
        self.assertIn(("DELETE", "/library/collections/900/items/7", None), calls)

        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True, sync=False)
        self.assertFalse([call for call in calls if call[0] == "DELETE"])  # append mode never removes
        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True, minimum=3)
        self.assertEqual(calls, [])  # Both franchises have only 2 movies
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True, franchises=False)
        self.assertEqual(calls, [])  # Franchise collections off: nothing is looked up or made

        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            pc.record_kept(config, kept, {"franchises": True, "streaming": "off"})
            pc.record_kept(config, kept[:1], {"franchises": True, "streaming": "off"})  # Heat wasn't checked this time
            self.assertEqual([e["name"] for e in json.loads((Path(folder) / pc.KEPT_FILE).read_text())["collections"]], ["Alien", "Heat"])
            pc.record_kept(config, [], {"franchises": False, "streaming": "off"})
            self.assertEqual(json.loads((Path(folder) / pc.KEPT_FILE).read_text())["collections"], [])
        self.assertEqual(sp.collection_key("Star Trek: Alternate Reality Collection"), sp.collection_key("Star Trek Alternate Reality"))


    def test_streaming_collections_group_shows_and_skip_smart_collections(self):
        plex = "http://plex.invalid:32400"
        def show(key, title, tmdb):
            return f'<Directory ratingKey="{key}" title="{title}" type="show"><Guid id="tmdb://{tmdb}"/></Directory>'
        def container(*parts, **attributes):
            fields = "".join(f' {name}="{value}"' for name, value in attributes.items())
            return f"<MediaContainer{fields}>{''.join(parts)}</MediaContainer>".encode()
        def tv(network, provider, region="US"):
            return {"networks": [{"name": network}], "watch/providers": {"results": {region: {"flatrate": [{"provider_id": provider}], "rent": [{"provider_id": 9}]}}}}
        self.config["plex"]["libraries"] = ["Movies", "TV"]
        self.http.replies.update({
            plex + "/library/sections": container('<Directory key="1" title="Movies" type="movie"/>', '<Directory key="2" title="TV" type="show"/>'),
            plex + "/library/sections/1/all": container(totalSize=0),
            plex + "/library/sections/1/collections": container(totalSize=0),
            plex + "/library/sections/2/all": container(show(11, "Stranger Things", 1), show(12, "The Witcher", 2), show(13, "Show A", 3),
                                                        show(14, "Show B", 4), show(15, "Lonely", 5), totalSize=5),
            plex + "/library/sections/2/collections": container(
                '<Directory ratingKey="800" title="Hulu Shows" type="collection" subtype="show" smart="1"/>', totalSize=1),
            plex + "/": container(machineIdentifier="MID"),
            common.TMDB + "/tv/1": tv("Netflix", 8), common.TMDB + "/tv/2": tv("Netflix", 8),
            common.TMDB + "/tv/3": tv("Hulu", 15), common.TMDB + "/tv/4": tv("Hulu", 15), common.TMDB + "/tv/5": tv("The CW", 0)})
        calls = []
        class Created(Response):
            content = b'<MediaContainer><Directory ratingKey="950"/></MediaContainer>'
        self.http.request = lambda method, url, **kwargs: (calls.append((method, url.removeprefix(plex), kwargs.get("params"))), Created({}))[1]

        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pc.build_collections(self.artwork, True, streaming="originals"), 0)
        uri = "server://MID/com.plexapp.plugins.library/library/metadata/"
        self.assertEqual([call for call in calls if call[0] == "POST"],
                         [("POST", "/library/collections", {"type": 2, "title": "Netflix Shows", "smart": 0, "sectionId": "2", "uri": uri + "11,12"})])
        self.assertIn("SKIP Hulu Shows [TV]: a smart collection", output.getvalue())  # Kometa's own can't be edited
        self.assertEqual([call for call in calls if call[0] in ("PUT", "DELETE")], [("PUT", "/library/metadata/950/prefs", {"collectionSort": 0})])

        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True)  # Streaming is off by default: movies only, so no TV collection is touched
        self.assertEqual(calls, [])

        data = tv("Hulu", 15, "GB")
        self.assertEqual(sp.streaming_services(data, "originals", "US"), ["Hulu"])
        self.assertEqual(sp.streaming_services(data, "available", "GB"), ["Hulu"])  # flatrate only; the rental (Prime 9) doesn't count
        self.assertEqual(sp.streaming_services(data, "available", "US"), [])
        self.assertEqual(sp.streaming_services({"networks": [{"name": "Disney Plus"}]}, "originals", "US"), ["Disney+"])  # "+" and "plus" agree
        self.assertEqual(sp.streaming_services({"networks": [{"name": "Disney Channel"}]}, "originals", "US"), [])


    def test_streaming_collection_posters_use_the_logo_over_a_color_gradient(self):
        plex = "http://plex.invalid:32400"
        self.config["plex"]["libraries"] = ["TV"]
        self.http.replies.update({
            plex + "/library/sections": b'<MediaContainer><Directory key="2" title="TV" type="show"/></MediaContainer>',
            plex + "/library/sections/2/collections": b'<MediaContainer totalSize="3">'
                b'<Directory ratingKey="1" title="Netflix Shows" type="collection" subtype="show" smart="1"/>'
                b'<Directory ratingKey="2" title="Tubi Shows" type="collection" subtype="show"/>'
                b'<Directory ratingKey="3" title="Favorites" type="collection" subtype="show"/></MediaContainer>'})
        found = self.artwork.plex.poster_collections()
        self.assertEqual([(item["title"], item["service"], item["smart"]) for item in found],
                         [("Netflix Shows", "Netflix", True), ("Tubi Shows", "Tubi", False)])  # "Favorites" isn't a service

        local_image = self.http.image
        def only_known(source, base, headers=None):
            if source.startswith("http") and source not in self.http.images:
                raise RuntimeError("raw.githubusercontent.com: HTTP 404")  # Never reach the network
            return local_image(source, base, headers)
        self.http.image = only_known
        self.http.images[sp.STREAMING_LOGOS + "Netflix.png"] = Image.new("RGBA", (20, 5), "white")
        self.http.images[sp.STREAMING_LOGOS + "tubi.png"] = Image.new("RGBA", (30, 6), "white")  # Filed in lowercase

        background, logo, stock = self.artwork.select(dict(found[0]), sp.Style())
        self.assertEqual((background.size, logo.size, stock), ((1000, 1500), (20, 5), False))
        pixels = np.asarray(background)[..., :3].astype(int)
        center, bottom_left, others = pixels[750, 500], pixels[-1, 0], [pixels[0, 0], pixels[0, -1], pixels[-1, -1]]
        self.assertLess(bottom_left[0], 10)                            # Bottom left is the darkest, nearly black
        for corner in others:                                          # The other corners are lighter, yet still darker than the glow
            self.assertGreater(corner[0], bottom_left[0] * 3)
            self.assertLess(corner[0], center[0] * 0.6)
        self.assertGreater(center[0], center[1] + 40)                  # Netflix's glow is red
        self.assertEqual(self.artwork.select(dict(found[1]), sp.Style())[1].size, (30, 6))  # Falls back to "tubi.png"

        (self.base / "resources" / "streaming").mkdir(parents=True)
        Image.new("RGBA", (12, 3), "white").save(self.base / "resources" / "streaming" / "Netflix.png")
        self.assertEqual(self.artwork.select(dict(found[0]), sp.Style())[1].size, (12, 3))  # The bundled logo beats the download

        own = self.base / "own.png"
        Image.new("RGBA", (8, 8), "blue").save(own)
        background, logo, _ = self.artwork.select({**found[0], "poster": str(own), "logo": str(own)}, sp.Style())
        self.assertEqual((background.size, logo.size), ((8, 8), (8, 8)))  # Files in the folder beat the generated ones
        with self.assertRaisesRegex(ValueError, "No logo found for Hulu"):
            self.artwork.select({"type": "collection", "service": "Hulu"}, sp.Style())

    def test_curated_collection_gets_a_title_poster_or_is_left_alone_when_missing_art_is_skipped(self):
        path = self.folder_job()
        self.config["items"] = [{"type": "collection", "rating_key": "77", "title": "What Should I Watch?"}]
        path.write_text(json.dumps(self.config), encoding="utf-8")
        for key in ("77", "78"):
            self.http.replies[self.artwork.plex.url + f"/library/metadata/{key}/children"] = b"<MediaContainer/>"
        self.http.replies[common.TMDB + "/search/collection"] = {"results": []}  # No franchise of that name
        result, text = self.run_folder_job(path)
        self.assertEqual(result, 0, text)
        self.assertNotIn("LEFT", text)
        folders = list((self.base / "assets" / "collections").glob("*{plex-77}"))
        self.assertEqual(len(folders), 1)
        self.assertIsNotNone(sp.ArtworkFiles.source(folders[0], "poster"))  # The drawn background, kept as its poster

        self.config["missing_art"] = "skip"
        self.config["items"] = [{"type": "collection", "rating_key": "78", "title": "Date Night"}]
        path.write_text(json.dumps(self.config), encoding="utf-8")
        result, text = self.run_folder_job(path)
        self.assertEqual(result, 0)  # Not missing artwork, so a scheduled run stays green
        self.assertIn("LEFT (no TMDb collection", text)
        self.assertFalse(any(call[0] in ("POST", "PUT") for call in self.http.calls))
        # Its folder is made anyway, so it is listed and a poster of your own can be chosen for it
        folders = list((self.base / "assets" / "collections").glob("*{plex-78}"))
        self.assertEqual(len(folders), 1)
        self.assertEqual(json.loads((folders[0] / ".overlayrr.json").read_text(encoding="utf-8"))["rating_key"], "78")


    def test_recent_collections_are_created_once_and_get_chart_posters(self):
        plex = "http://plex.invalid:32400"
        def container(*parts, **attributes):
            fields = "".join(f' {name}="{value}"' for name, value in attributes.items())
            return f"<MediaContainer{fields}>{''.join(parts)}</MediaContainer>".encode()
        self.config["plex"]["libraries"] = ["Movies", "TV"]
        self.http.replies.update({
            plex + "/library/sections": container('<Directory key="1" title="Movies" type="movie"/>', '<Directory key="2" title="TV" type="show"/>'),
            plex + "/library/sections/1/all": container(totalSize=0),
            plex + "/library/sections/1/collections": container(
                '<Directory ratingKey="5" title="Newly Released" type="collection" subtype="movie" smart="1"/>', totalSize=1),
            plex + "/library/sections/2/collections": container(totalSize=0),
            plex + "/library/metadata/5": container('<Directory ratingKey="5" content="/library/sections/1/all?type=1&amp;sort=originallyAvailableAt%3Adesc&amp;originallyAvailableAt%3E%3E=-90d"/>'),
            plex + "/": container(machineIdentifier="MID")})
        calls = []
        class Created(Response):
            content = b"<MediaContainer/>"
        self.http.request = lambda method, url, **kwargs: (calls.append((method, url.removeprefix(plex), kwargs.get("params"))), Created({}))[1]

        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pc.build_collections(self.artwork, False, recent=True), 0)
        self.assertEqual(calls, [])  # A plan never writes
        self.assertIn("PLAN CREATE New Episodes [TV]: smart collection of episodes aired in the last 7 days", output.getvalue())
        self.assertNotIn("CREATE Newly Released", output.getvalue())  # Kometa's own is already there, so it's left alone
        self.assertIn("PLAN SORT Newly Released [Movies]: first in the collections list", output.getvalue())

        with redirect_stdout(io.StringIO()):
            self.assertEqual(pc.build_collections(self.artwork, True, recent=True), 0)
        uri = "server://MID/com.plexapp.plugins.library/library/sections/2/all?type=4&sort=originallyAvailableAt%3Adesc&episode.originallyAvailableAt%3E%3E=-7d"
        # The existing one is moved to the front of the list; the missing one is created
        self.assertEqual(calls, [("PUT", "/library/sections/1/all", {"type": 18, "id": "5", "titleSort.value": "!001 Newly Released", "titleSort.locked": 1}),
                                 ("POST", "/library/collections", {"type": 4, "title": "New Episodes", "smart": 1, "sectionId": "2", "uri": uri})])

        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True)  # Off unless asked for
        self.assertEqual(calls, [])

        # A different window changes the existing collection's filter...
        calls.clear()
        output = io.StringIO()
        with redirect_stdout(output):
            pc.build_collections(self.artwork, True, recent=True, days={"movie": 30, "show": 7})
        window = "server://MID/com.plexapp.plugins.library/library/sections/1/all?type=1&sort=originallyAvailableAt%3Adesc&originallyAvailableAt%3E%3E=-30d"
        self.assertIn(("PUT", "/library/collections/5/items", {"uri": window}), calls)
        self.assertIn("UPDATE Newly Released [Movies]: last 90 days -> last 30 days", output.getvalue())
        # ...but a filter we can't read is left exactly as it is
        self.http.replies[plex + "/library/metadata/5"] = container('<Directory ratingKey="5"/>')
        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True, recent=True, days={"movie": 30, "show": 7})
        self.assertFalse([call for call in calls if call[1] == "/library/collections/5/items"])

        self.http.replies[plex + "/library/sections/1/collections"] = container(totalSize=0)
        calls.clear()
        with redirect_stdout(io.StringIO()):
            pc.build_collections(self.artwork, True, recent=True)
        movie_uri = "server://MID/com.plexapp.plugins.library/library/sections/1/all?type=1&sort=originallyAvailableAt%3Adesc&originallyAvailableAt%3E%3E=-90d"
        self.assertIn(("POST", "/library/collections", {"type": 1, "title": "Newly Released", "smart": 1, "sectionId": "1", "uri": movie_uri}), calls)

        # Posters: the existing smart collection is a chart item, drawn from the bundled Plex logo
        self.http.replies[plex + "/library/sections/1/collections"] = container(
            '<Directory ratingKey="5" title="Newly Released" type="collection" subtype="movie" smart="1"/>', totalSize=1)
        # Plex lists a smart collection of episodes with subtype "episode", not "show"
        self.http.replies[plex + "/library/sections/2/collections"] = container(
            '<Directory ratingKey="6" title="New Episodes" type="collection" subtype="episode" smart="1"/>', totalSize=1)
        found = self.artwork.plex.poster_collections()
        self.assertEqual([(item["title"], item["chart"]) for item in found], [("Newly Released", "Newly Released"), ("New Episodes", "New Episodes")])

        # ...so a run finds it and does not make a second one, and a sort title already in place isn't set again
        self.http.replies[plex + "/library/metadata/6"] = container(
            '<Directory ratingKey="6" titleSort="!001 New Episodes" content="/library/sections/2/all?type=4&amp;episode.originallyAvailableAt%3E%3E=-7d"/>')
        self.http.replies[plex + "/library/metadata/5"] = container(
            '<Directory ratingKey="5" titleSort="!001 Newly Released" content="/library/sections/1/all?type=1&amp;originallyAvailableAt%3E%3E=-90d"/>')
        calls.clear()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pc.build_collections(self.artwork, True, recent=True), 0)
        self.assertEqual(calls, [])
        self.assertNotIn("CREATE", output.getvalue())

        # Two of the same name (made by an earlier run): the oldest is kept, the extra is deleted, and a plan only says so
        self.http.replies[plex + "/library/sections/2/collections"] = container(
            '<Directory ratingKey="7" title="New Episodes" type="collection" subtype="episode" smart="1"/>',
            '<Directory ratingKey="6" title="New Episodes" type="collection" subtype="episode" smart="1"/>', totalSize=2)
        output = io.StringIO()
        with redirect_stdout(output):
            pc.build_collections(self.artwork, False, recent=True)
        self.assertIn("PLAN DELETE New Episodes [TV]: extra copy (id 7); keeping id 6", output.getvalue())
        self.assertIn("1 extra to delete", output.getvalue())
        self.assertEqual(calls, [])
        output = io.StringIO()
        with redirect_stdout(output):
            pc.build_collections(self.artwork, True, recent=True)
        self.assertIn("DELETE New Episodes [TV]: extra copy (id 7); keeping id 6", output.getvalue())
        self.assertEqual(calls, [("DELETE", "/library/collections/7", None)])
        # A same-named collection that isn't smart is somebody's own: it is never deleted
        calls.clear()
        self.http.replies[plex + "/library/sections/2/collections"] = container(
            '<Directory ratingKey="6" title="New Episodes" type="collection" subtype="episode" smart="1"/>',
            '<Directory ratingKey="8" title="New Episodes" type="collection" subtype="show"/>', totalSize=2)
        output = io.StringIO()
        with redirect_stdout(output):
            pc.build_collections(self.artwork, True, recent=True)
        self.assertIn("another collection with this name isn't a smart collection", output.getvalue())
        self.assertEqual(calls, [])
        self.http.replies[plex + "/library/sections/2/collections"] = container(
            '<Directory ratingKey="6" title="New Episodes" type="collection" subtype="episode" smart="1"/>', totalSize=1)
        (self.base / "resources" / "charts").mkdir(parents=True)
        Image.new("RGBA", (40, 20), "white").save(self.base / "resources" / "charts" / "Plex.png")
        background, logo, stock = self.artwork.select(dict(found[1]), sp.Style())
        self.assertEqual((background.size, logo.size, stock), ((1000, 1500), (40, 20), False))
        self.assertEqual(sp.item_layout({**found[1], "type": "collection"}, {"layout_by_type": {"chart": "c", "collection": "x"}, "default_layout": "d"},
                                        {("c", False): 1, ("x", False): 2, ("d", False): 3}), ("c", False))  # chart beats collection

    def test_title_lines_puts_each_word_on_its_own_line(self):
        style = sp.Style(width=400, height=600, text_overlay_enabled=True, custom_text="{title_lines}", font_size=60)
        lines = sp.Renderer(style).render(Image.new("RGB", (40, 60), "black"), None, False, {"title": "New Episodes"})
        one = sp.Renderer(sp.Style(width=400, height=600, text_overlay_enabled=True, custom_text="{title}", font_size=60)).render(
            Image.new("RGB", (40, 60), "black"), None, False, {"title": "New Episodes"})
        self.assertGreater(lines.getbbox()[3] - lines.getbbox()[1], one.getbbox()[3] - one.getbbox()[1])  # Two lines are taller


class CleanupTests(unittest.TestCase):
    """plex_cleanup.py against a fake Plex data folder and database; nothing touches a real server."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()  # The cleanup reports real paths; the temp folder may be a symlink
        self.data = self.base / "plex data"
        self.uploads = self.data / "Metadata/Movies/a/abc.bundle/Uploads/posters"
        self.uploads.mkdir(parents=True)
        self.files = {}
        def make(name, folder=None, overlay=True, software=True, hours=5, suffix=""):
            path = (folder or self.uploads) / (name + suffix)
            path.parent.mkdir(parents=True, exist_ok=True)
            exif = Image.Exif()
            if overlay:
                exif[0x04BC] = "overlay"
            if software:
                exif[0x0131] = "Overlayrr"
            Image.new("RGB", (8, 8), "red").save(path, format="JPEG", exif=exif)
            old = path.stat().st_mtime - hours * 3600
            os.utime(path, (old, old))
            self.files[name] = path
        make("in_use")
        make("orphan")
        make("orphan_two", folder=self.data / "Metadata/Shows/b/xyz.bundle/Uploads/posters")
        make("kometa", software=False)                       # Kometa's overlay: only the overlay tag
        make("manual", overlay=False, software=False)        # Something you uploaded by hand
        make("recent", hours=0)                              # Too new for the snapshot to be trusted
        make("contents", folder=self.data / "Metadata/Movies/a/abc.bundle/Contents/_combined/posters")
        make("elsewhere", folder=self.data / "Metadata/Movies/a/abc.bundle/Other")
        make("with_extension", suffix=".jpg")
        (self.data / "Plug-in Support/Databases").mkdir(parents=True)
        self.database = self.base / "snapshot.db"
        self.write_database({"user_thumb_url": "upload://posters/in_use"})
        config = configured(plex={"url": "http://plex.invalid:32400", "token": "t", "libraries": [], "data_dir": str(self.data)})
        self.config_path = self.base / "config.json"
        self.config_path.write_text(json.dumps(config), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def write_database(self, row, columns=("user_thumb_url", "user_art_url", "user_banner_url", "user_clear_logo_url", "user_square_art_url")):
        self.database.unlink(missing_ok=True)
        connection = sqlite3.connect(self.database)
        connection.execute(f"CREATE TABLE metadata_items (id INTEGER, {', '.join(c + ' TEXT' for c in columns)})")
        connection.execute("INSERT INTO metadata_items (id, " + ", ".join(row) + ") VALUES (1, " + ", ".join("?" * len(row)) + ")", list(row.values()))
        connection.commit()
        connection.close()

    def cleanup(self, mode="report"):
        output = io.StringIO()
        with patch.object(cleanup, "plex_snapshot", return_value=self.database), redirect_stdout(output):
            result = cleanup.cleanup(self.config_path, mode)
        return result, output.getvalue()

    def present(self):
        return {name for name, path in self.files.items() if path.exists()}

    def test_report_lists_only_unused_overlayrr_posters_and_changes_nothing(self):
        result, text = self.cleanup()
        self.assertEqual(result, 0)
        listed = {line.split(" ", 1)[1] for line in text.splitlines() if line.startswith("UNUSED ")}
        self.assertEqual(listed, {str(self.files["orphan"]), str(self.files["orphan_two"])})
        self.assertIn("Found 2 unused", text)
        self.assertEqual(self.present(), set(self.files))

    def test_move_is_reversible_and_remove_deletes_only_the_unused_ones(self):
        self.cleanup("move")
        kept = set(self.files) - {"orphan", "orphan_two"}
        self.assertEqual(self.present(), kept)
        restored = self.data / "Overlayrr Restore/Movies/a/abc.bundle/Uploads/posters/orphan"
        self.assertTrue(restored.is_file())
        self.assertIn("Restored 2 files", self.cleanup("restore")[1])
        self.assertEqual(self.present(), set(self.files))
        self.assertFalse((self.data / "Overlayrr Restore").exists())
        self.cleanup("remove")
        self.assertEqual(self.present(), kept)
        self.assertFalse((self.data / "Overlayrr Restore").exists())

    def test_posters_in_use_stay_even_when_selected_for_other_fields(self):
        self.write_database({"user_thumb_url": "upload://posters/in_use", "user_art_url": "upload://art/orphan"})
        self.cleanup("remove")
        self.assertIn("orphan", self.present())
        self.assertNotIn("orphan_two", self.present())

    def test_age_limit_is_configurable(self):
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        config["plex"]["cleanup_min_age_minutes"] = 600  # Everything under ten hours old is left alone
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        self.assertEqual(self.cleanup()[1].count("UNUSED "), 0)

    def test_refuses_to_guess_when_the_database_or_settings_look_wrong(self):
        self.write_database({"user_thumb_url": None})  # Nothing in use at all: a broken snapshot
        with self.assertRaisesRegex(ValueError, "refusing"):
            self.cleanup("remove")
        self.write_database({"user_banner_url": "upload://posters/in_use"}, columns=("user_banner_url",))  # Required columns missing
        with self.assertRaisesRegex(ValueError, "refusing"):
            self.cleanup("remove")
        self.assertEqual(self.present(), set(self.files))
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        del config["plex"]["data_dir"]
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "data_dir"):
            self.cleanup()

    def test_cleanup_is_its_own_script(self):
        self.cleanup("move")
        result = subprocess.run([sys.executable, str(STANDALONE / "plex_cleanup.py"), str(self.config_path), "restore"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Restored 2 files", result.stdout)
        self.assertEqual(self.present(), set(self.files))
        result = subprocess.run([sys.executable, str(STANDALONE / "overlayrr.py"), str(self.config_path), "--cleanup"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)  # The artwork engine no longer has it

    def test_snapshot_download_accepts_zip_or_raw_database(self):
        import zipfile
        class Download(FixtureHTTP):
            payload = b""
            def request(self, method, url, **kwargs):
                outer = self
                class Streamed(Response):
                    def iter_content(self, size):
                        yield outer.payload
                return Streamed(None)
        http = Download(self.base)
        artwork = sp.Artwork(http, configured(plex={"url": "http://plex.invalid:32400", "token": "t"}), self.base)
        folder = self.base / "tmp"
        folder.mkdir()
        http.payload = self.database.read_bytes()
        self.assertEqual(cleanup.images_in_use(cleanup.plex_snapshot(artwork.plex, folder)), {"in_use"})
        archive = self.base / "backup.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.write(self.database, "databaseBackup-2026")
        http.payload = archive.read_bytes()
        self.assertEqual(cleanup.images_in_use(cleanup.plex_snapshot(artwork.plex, folder)), {"in_use"})
        http.payload = b"<html>nope</html>"
        with self.assertRaisesRegex(ValueError, "not a database"):
            cleanup.plex_snapshot(artwork.plex, folder)


class ArtworkFileTests(unittest.TestCase):
    def test_original_downloaded_bytes_are_saved_without_recompression(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            http = FixtureHTTP(base)
            buffer = io.BytesIO()
            Image.new("RGB", (20, 30), "red").save(buffer, format="JPEG", quality=81)
            original = buffer.getvalue()
            url = "https://art.invalid/original.jpg"
            http.replies[url] = original
            background = http.image(url, base)
            files = sp.ArtworkFiles(base / "assets")
            item = {"type": "movie", "title": 'A: / Movie?', "year": "2020", "tmdb_id": 1}
            folder = files.save(item, background, None, False)
            self.assertEqual((folder / "poster.jpg").read_bytes(), original)
            self.assertNotIn(":", folder.name)
            self.assertNotIn("/", folder.name)
            self.assertFalse(files.apply(item))
            self.assertEqual(http.image(item["poster"], base).size, (20, 30))

    def test_seasons_always_use_the_show_logo(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            files = sp.ArtworkFiles(base / "assets")
            show = {"type": "tv", "title": "Show", "tvdb_id": 42, "rating_key": "10"}
            root = files.save(show, Image.new("RGBA", (20, 30), "red"), Image.new("RGBA", (20, 5), "white"), False)
            season = {**show, "rating_key": "11", "parent_rating_key": "10", "season": 1}
            folder = files.save(season, Image.new("RGBA", (20, 30), "blue"), Image.new("RGBA", (20, 5), "white"), False)
            self.assertEqual(folder.name, "Season 01")
            self.assertFalse((folder / "logo.png").exists())
            files.apply(season)
            self.assertEqual(Path(season["logo"]), root / "logo.png")
            Image.new("RGBA", (20, 5), "lime").save(root / "logo.png")
            self.assertEqual(sp.HTTP(base / "cache").image(season["logo"], base).getpixel((0, 0)), (0, 255, 0, 255))
            Image.new("RGBA", (20, 5), "yellow").save(folder / "logo.png")  # A stray season logo is ignored
            files.apply(season)
            self.assertEqual(Path(season["logo"]), root / "logo.png")
            episode = {**season, "rating_key": "12", "episode": 1}
            files.apply(episode)
            self.assertEqual(Path(episode["logo"]), root / "logo.png")
            # A new process can find the show even if Plex omits provider IDs.
            files = sp.ArtworkFiles(base / "assets")
            lookup = {"type": "tv", "rating_key": "11", "parent_rating_key": "10", "season": 1}
            files.apply(lookup)
            self.assertEqual(Path(lookup["poster"]), folder / "poster.png")

    def test_renamed_title_folder_stays_associated_by_id(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            files = sp.ArtworkFiles(base / "assets")
            item = {"type": "movie", "title": "Old title", "tmdb_id": 603}
            folder = files.save(item, Image.new("RGBA", (20, 30), "red"), None, False)
            renamed = folder.with_name("My preferred title {tmdb-603}")
            folder.rename(renamed)
            files = sp.ArtworkFiles(base / "assets")
            item = {"type": "movie", "tmdb_id": 603}
            files.apply(item)
            self.assertEqual(Path(item["poster"]).parent, renamed)
            self.assertEqual(item["title"], "Old title")

    def test_ambiguous_files_and_duplicate_ids_fail_clearly(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            files = sp.ArtworkFiles(base / "assets")
            item = {"type": "movie", "tmdb_id": 1, "title": "A"}
            folder = files.save(item, Image.new("RGBA", (20, 30), "red"), None, False)
            Image.new("RGB", (20, 30), "blue").save(folder / "poster.jpg")
            with self.assertRaisesRegex(ValueError, "exactly one poster"):
                files.apply(item)
            duplicate = folder.with_name("Duplicate {tmdb-1}")
            duplicate.mkdir()
            with self.assertRaisesRegex(ValueError, "Duplicate artwork ID"):
                sp.ArtworkFiles(base / "assets")

    def test_saved_stock_remains_stock_until_user_replaces_poster(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            files = sp.ArtworkFiles(base / "assets")
            item = {"type": "movie", "tmdb_id": 1, "title": "Stock"}
            folder = files.save(item, Image.new("RGBA", (20, 30), "red"), None, True)
            saved_stock = files.apply(item)
            self.assertTrue(saved_stock)
            artwork = sp.Artwork(FixtureHTTP(base), {}, base)
            self.assertTrue(artwork.select(item, sp.Style(logo_mode="none"), saved_stock)[2])
            artwork.config["missing_art"] = "skip"
            self.assertEqual(artwork.select(item, sp.Style(logo_mode="none"), saved_stock), (None, None, True))
            Image.new("RGBA", (20, 30), "blue").save(folder / "poster.png")
            self.assertFalse(files.apply(item))


class CLIAndHTTPTests(unittest.TestCase):
    def test_cli_force_selects_one_configured_job_by_title_or_id(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            Image.new("RGB", (20, 30), "red").save(base / "poster.png")
            Image.new("RGBA", (20, 5), "white").save(base / "logo.png")
            config = configured(layouts={"custom": {"width": 200, "height": 300}}, items=[
                {"title": "Movie A", "year": 1999, "rating_key": "1", "poster": "poster.png", "logo": "logo.png", "output": "a.png"},
                {"title": "Movie B", "rating_key": "2", "poster": "poster.png", "logo": "logo.png", "output": "b.png"}])
            path = base / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            command = [sys.executable, str(STANDALONE / "overlayrr.py"), str(path)]
            result = subprocess.run(command + ["--title", "movie a", "--type", "movie", "--year", "1999", "--remake"], cwd=base.parent, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            a = base / "assets/movies/Movie A (1999) {plex-1}/a.png"
            b = base / "assets/movies/Movie B {plex-2}/b.png"
            self.assertTrue(a.exists())
            self.assertFalse(b.exists())
            b.parent.mkdir(parents=True)
            b.write_bytes(b"leave the other item alone")
            result = subprocess.run(command + ["--item", "1", "--remake", "--changed-only"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("LAYOUT", result.stdout)
            self.assertNotIn("UNCHANGED", result.stdout)
            self.assertEqual(b.read_bytes(), b"leave the other item alone")
            timestamp = a.stat().st_mtime_ns
            for arguments in (["--refresh"], ["--refresh", "--changed-only"], ["--title", "Missing", "--remake"], ["--item", "1", "--title", "Movie A"],
                              ["--item", "1", "--limit", "1"], ["--item", "1", "--with-seasons"]):
                result = subprocess.run(command + arguments, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(a.stat().st_mtime_ns, timestamp)

    def test_config_credentials_override_environment(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "TMDB_API_KEY": "env-tmdb", "TVDB_API_KEY": "env-tvdb", "PLEX_TOKEN": "env-plex",
            "CUSTOM_FANART_KEY": "custom-fanart"}, clear=True):
            base = Path(directory)
            path = base / "config.json"
            config = configured(plex={"token": "config-plex"},
                                api={"tmdb_key": "config-tmdb", "tvdb_key": "",
                                     "fanart_key": "${CUSTOM_FANART_KEY}"})
            path.write_text(json.dumps(config), encoding="utf-8")
            artwork = sp.Artwork(FixtureHTTP(base), sp.read_config(path), base)
            self.assertEqual(artwork.plex.headers["X-Plex-Token"], "config-plex")
            self.assertEqual(artwork.keys["tmdb_key"], "config-tmdb")
            self.assertEqual(artwork.keys["tvdb_key"], "")
            self.assertEqual(artwork.keys["fanart_key"], "custom-fanart")

    def test_missing_keys_stay_empty(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            base = Path(directory)
            path = base / "config.json"
            path.write_text(json.dumps(configured()), encoding="utf-8")
            artwork = sp.Artwork(FixtureHTTP(base), sp.read_config(path), base)
            self.assertEqual(artwork.keys["tmdb_key"], "")

    def test_cli_local_only_from_other_directory_and_changed_only(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            Image.new("RGB", (200, 300), "red").save(base / "poster.jpg")
            Image.new("RGBA", (100, 20), "white").save(base / "logo.png")
            config = configured(layouts={"custom": {"width": 200, "height": 300, "grain_seed": 42}}, items=[
                {"poster": "poster.jpg", "logo": "logo.png", "output": "render.png"},
                {"poster": "poster.jpg", "logo": "logo.png", "output": "render.jpg"}])
            path = base / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            command = [sys.executable, str(STANDALONE / "overlayrr.py"), str(path)]
            result = subprocess.run(command, cwd=base.parent, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for suffix in ("png", "jpg"):
                alias = sp.ArtworkFiles.local_alias({"output_name": f"render.{suffix}"})
                with Image.open(base / f"assets/movies/render {{{alias}}}/render.{suffix}") as image:
                    self.assertEqual(image.size, (200, 300))
                    if suffix == "jpg":
                        self.assertEqual(image.layer[0][1:3], (1, 1))  # JPEG 4:4:4
            result = subprocess.run(command + ["--changed-only"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.count("UNCHANGED"), 2)
            files = sp.ArtworkFiles(base / "assets")
            folder = files.folder({"type": "movie", "output_name": "render.jpg"})
            files.source(folder, "poster").write_bytes(b"corrupt local image")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("LAYOUT custom", result.stdout)
            self.assertIn("1 failed", result.stdout)

    def test_each_engine_checks_its_own_part_of_the_shared_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            config = configured(layouts={"custom": {"width": 200, "height": 300}},
                                collections=[{"name": "Empty", "library": "Movies", "type": "movie"}])
            path.write_text(json.dumps(config), encoding="utf-8")
            artwork = subprocess.run([sys.executable, str(STANDALONE / "overlayrr.py"), str(path), "--check"], capture_output=True, text=True)
            self.assertEqual(artwork.returncode, 0, artwork.stderr)  # Collection definitions aren't the artwork engine's to judge
            collections = subprocess.run([sys.executable, str(STANDALONE / "plex_collections.py"), str(path), "check"], capture_output=True, text=True)
            self.assertEqual(collections.returncode, 1)
            self.assertIn("Empty needs titles, a list or a rule before it can be turned on", collections.stderr)
            # Off, it is a draft; Radarr downloads without a quality profile ID use Radarr's first one.
            config["collections"] = [{"name": "Empty", "library": "Movies", "type": "movie", "enabled": False, "acquire": True},
                                     {"name": "Picks", "library": "Movies", "type": "movie", "acquire": True, "members": [{"tmdb_id": 948}]}]
            config["radarr"] = {"url": "http://radarr.local:7878", "api_key": "${RADARR_API_KEY}", "root_folder": "/movies"}
            path.write_text(json.dumps(config), encoding="utf-8")
            collections = subprocess.run([sys.executable, str(STANDALONE / "plex_collections.py"), str(path), "check"], capture_output=True, text=True)
            self.assertEqual(collections.returncode, 0, collections.stderr)
            del config["radarr"]
            config["layouts"], config["collections"], config["workers"] = {}, [], 2
            path.write_text(json.dumps(config), encoding="utf-8")
            collections = subprocess.run([sys.executable, str(STANDALONE / "plex_collections.py"), str(path), "check"], capture_output=True, text=True)
            self.assertEqual(collections.returncode, 0, collections.stderr)  # Nor are layouts the collections engine's
            artwork = subprocess.run([sys.executable, str(STANDALONE / "overlayrr.py"), str(path), "--check"], capture_output=True, text=True)
            self.assertIn("Define at least one named layout", artwork.stderr)
            config["workers"] = 0
            path.write_text(json.dumps(config), encoding="utf-8")
            collections = subprocess.run([sys.executable, str(STANDALONE / "plex_collections.py"), str(path), "check"], capture_output=True, text=True)
            self.assertIn("workers must be an integer", collections.stderr)  # The shared checks are both engines'

    def test_reject_bad_config_and_input_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            path = base / "config.json"
            for config in ({"workers": 0}, {"quality": "95"}, {"style": {"width": -1}},
                           {"style": {"grain_seed": -1}}, {"style": {"typo": 1}},
                           {"plex": {"upload": "false"}}):
                path.write_text(json.dumps(config), encoding="utf-8")
                with self.assertRaises(ValueError):
                    sp.read_config(path)
            config = configured(items=[{"poster": "poster.jpg", "logo": "logo.png", "output": "poster.jpg"}])
            artwork = sp.Artwork(FixtureHTTP(base), config, base)
            with self.assertRaisesRegex(ValueError, "overwrite"):
                sp.prepare_items(artwork, config)
            config = configured(items=[{"poster": "x.jpg", "output": "same.jpg"}, {"poster": "y.jpg", "output": "same.jpg"}])
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                sp.prepare_items(artwork, config)
            config = configured(items=[{"title": "Movie A", "poster": "x.jpg"}, {"title": "Movie B", "poster": "y.jpg"}])
            self.assertEqual([item["output_name"] for item in sp.prepare_items(artwork, config)], ["rendered.jpg", "rendered.jpg"])
            config["items"][0]["output"] = "../rendered.jpg"
            with self.assertRaisesRegex(ValueError, "without directories"):
                sp.prepare_items(artwork, config)

    def test_real_http_retry_cache_refresh_and_secret_redaction(self):
        counts = {}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = self.path.split("?")[0]
                counts[path] = counts.get(path, 0) + 1
                if path == "/retry" and counts[path] == 1:
                    self.send_response(429)
                    self.send_header("Retry-After", "0")
                    self.end_headers()
                elif path == "/error":
                    self.send_response(401)
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"ok":true}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                http = sp.HTTP(Path(directory))
                url = f"http://127.0.0.1:{server.server_port}"
                self.assertEqual(http.json(url + "/retry"), {"ok": True})
                self.assertEqual(http.json(url + "/retry"), {"ok": True})
                self.assertEqual(counts["/retry"], 2)
                http.refresh = True
                http.json(url + "/retry")
                self.assertEqual(counts["/retry"], 3)
                http.refresh = False
                http.json(url + "/scope", headers={"Authorization": "Bearer first"}, cache_scope="same-account")
                http.json(url + "/scope", headers={"Authorization": "Bearer second"}, cache_scope="same-account")
                self.assertEqual(counts["/scope"], 1)
                with self.assertRaisesRegex(RuntimeError, "HTTP 401") as caught:
                    http.get(url + "/error", params={"api_key": "sensitive-value"})
                self.assertNotIn("sensitive-value", str(caught.exception))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class FakePlexHTTP:
    """Answers Plex GETs from a {path: xml or callable(params)} map and records every call."""
    def __init__(self, answers):
        self.answers, self.calls = answers, []
    def get(self, url, params=None, headers=None, **kwargs):
        path = url.removeprefix("http://plex.invalid")
        self.calls.append(("GET", path, params))
        answer = self.answers.get(path, b"<MediaContainer/>")
        return answer(params) if callable(answer) else answer
    @contextmanager
    def request(self, method, url, **kwargs):
        self.calls.append((method, url.removeprefix("http://plex.invalid"), kwargs.get("params")))
        yield None


class SafeguardTests(unittest.TestCase):
    """Download link checks, Plex paging, cache upkeep, change-record migration, resets and the web login limit."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_web_download_refuses_private_addresses_and_follows_redirects_on_the_checked_address(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers["Host"]))
                if self.path == "/start":
                    self.send_response(302)
                    self.send_header("Location", "/image.png")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"data")
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host = f"127.0.0.1:{server.server_port}"
            with self.assertRaisesRegex(ValueError, "private address"):
                sp.web_download(f"http://{host}/start")
            self.assertEqual(seen, [])  # Refused before connecting
            public = type("Address", (), {"is_global": True})()
            with patch.object(common.ipaddress, "ip_address", return_value=public):
                self.assertEqual(sp.web_download(f"http://{host}/start"), b"data")
            self.assertEqual(seen, [("/start", host), ("/image.png", host)])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_tvdb_answers_from_cache_without_logging_in(self):
        http = sp.HTTP(self.base / "cache")
        artwork = sp.Artwork(http, {"api": {"tvdb_key": "key"}}, self.base)
        scope = {key: artwork.keys.get(key) for key in ("tvdb_key", "tvdb_pin")}
        (self.base / "cache").mkdir()
        (self.base / "cache" / http.digest(common.TVDB + "/artwork/types", None, None, scope)).write_text('{"data": [1]}')
        with patch.object(http, "request", side_effect=AssertionError("no network, and no login")):
            self.assertEqual(artwork.tvdb("/artwork/types"), {"data": [1]})
        self.assertIsNone(artwork.token)

    def test_plex_pages_move_past_entries_they_skip(self):
        pages = {0: b'<MediaContainer totalSize="4"><Video ratingKey="1"/><Photo/></MediaContainer>',
                 2: b'<MediaContainer totalSize="4"><Video ratingKey="3"/><Video ratingKey="4"/></MediaContainer>'}
        plex = sp.Plex(FakePlexHTTP({"/listing": lambda params: pages[params["X-Plex-Container-Start"]]}),
                       {"plex": {"url": "http://plex.invalid", "token": "t"}})
        found = [e.get("ratingKey") for _, entries in plex.pages("/listing", lambda e: e.tag == "Video", size=2) for e in entries]
        self.assertEqual(found, ["1", "3", "4"])  # Never "3" twice from an overlapping second page

    def test_change_records_made_with_plex_url_are_updated_without_a_rebuild(self):
        poster = self.base / "poster.png"
        Image.new("RGB", (20, 30), "red").save(poster)
        config = configured(plex={"url": "http://plex.invalid", "upload": True})
        artwork = sp.Artwork(sp.HTTP(self.base / "cache"), config, self.base)
        batch = sp.Batch(artwork, None, config, self.base, set(), force=False, changed_only=True,
                         refresh=False, refetch=False, upload=True)
        batch.server = "server-id"
        item, style = {"type": "movie", "rating_key": "9", "poster": str(poster)}, sp.Style(logo_mode="none")
        signature = sp.render_signature(item, style, config, self.base, "server-id")
        state = self.base / "record"
        state.write_text(sp.render_signature(item, style, config, self.base, legacy=True))
        self.assertEqual(batch.recorded(item, style, state, signature), signature)
        self.assertEqual(state.read_text(), signature)
        state.write_text("made from other inputs")
        self.assertEqual(batch.recorded(item, style, state, signature), "made from other inputs")  # A real change stays one
        other_address = configured(plex={"url": "http://localhost:32400", "upload": True})
        self.assertEqual(sp.render_signature(item, style, other_address, self.base, "server-id"), signature)

    def test_prune_cache_drops_expired_files_and_keeps_its_own_records(self):
        cache = self.base / "cache"
        (cache / "thumbs").mkdir(parents=True)
        (cache / "renders").mkdir()
        old, new = "a" * 64, "b" * 64
        stale = [cache / old, cache / "web_pending.json", cache / "renders" / old, cache / "thumbs" / (old + ".jpg")]
        for path in stale + [cache / new, cache / "thumbs" / (new + ".jpg")]:
            path.write_bytes(b"x")
        moment = time.time() - sp.THUMB_TTL - 60
        for path in stale:
            os.utime(path, (moment, moment))
        sp.prune_cache(cache)
        self.assertEqual(sorted(path.name for path in cache.iterdir()), sorted([new, "web_pending.json", "renders", "thumbs"]))
        self.assertTrue((cache / "renders" / old).exists())
        self.assertEqual([path.name for path in (cache / "thumbs").iterdir()], [new + ".jpg"])

    def test_one_title_runs_find_folders_by_name_and_read_saved_ids_only_when_needed(self):
        root = self.base / "assets"
        named = root / "movies" / "Heat (1995) {tmdb-949}"
        renamed = root / "movies" / "My Matrix"
        named.mkdir(parents=True)
        renamed.mkdir()
        (renamed / ".overlayrr.json").write_text(json.dumps({"type": "movie", "tmdb_id": 603}))
        files = sp.ArtworkFiles(root, full=False)
        self.assertEqual(files.folder({"type": "movie", "tmdb_id": 949}), named)
        self.assertFalse(files.scanned)  # Found by its name; no .overlayrr.json was read
        self.assertEqual(files.folder({"type": "movie", "tmdb_id": 603}), renamed)
        self.assertTrue(files.scanned)

    def test_collections_keep_their_own_folder_and_a_title_ending_in_its_year_gets_it_once(self):
        files = sp.ArtworkFiles(self.base / "assets")
        saga = files.folder({"type": "collection", "rating_key": "1", "tmdb_id": 10, "title": "Star Wars"}, create=True)
        other = files.folder({"type": "collection", "rating_key": "2", "tmdb_id": 10, "title": "Star Wars: Skywalker Saga"}, create=True)
        self.assertNotEqual(saga, other)  # Both resolve to TMDb collection 10, but each keeps its own folder
        show = files.folder({"type": "tv", "tvdb_id": 436588, "title": "Betrayal (2023)", "year": "2023"}, create=True)
        self.assertEqual(show.name, "Betrayal (2023) {tvdb-436588}")

    def test_file_hashes_are_remembered_between_runs_and_redone_when_a_file_changes(self):
        poster, other = self.base / "poster.jpg", self.base / "other.jpg"
        poster.write_bytes(b"first")
        other.write_bytes(b"other")
        store_file = self.base / "digests.json"
        first = sp.Digests()
        first.load(store_file)
        self.assertEqual(first.digest(poster), sp.hashlib.sha256(b"first").hexdigest())
        first.digest(other)
        first.save()
        later = sp.Digests()  # The next run
        later.load(store_file)
        with patch.object(sp.Path, "read_bytes", side_effect=AssertionError("an unchanged file is not read")):
            self.assertEqual(later.digest(poster), sp.hashlib.sha256(b"first").hexdigest())
        poster.write_bytes(b"replaced")
        self.assertEqual(later.digest(poster), sp.hashlib.sha256(b"replaced").hexdigest())
        later.save(prune=True)  # A whole-library run that no longer used other.jpg
        self.assertEqual(list(json.loads(store_file.read_text())), [str(poster)])

if __name__ == "__main__":
    unittest.main()
