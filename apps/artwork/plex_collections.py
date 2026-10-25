#!/usr/bin/env python3
"""tk.box's collections engine: the Plex collections tk.box keeps, apart from the artwork engine (overlayrr.py).

- Franchise collections from TMDb, "<Service> Shows" streaming collections and the "Newly Released" / "New Episodes"
  smart collections, made and kept in line with your libraries. Each franchise or streaming one can be turned off.
- tk.box's collections are what Plex holds: one turned off or removed in tk.box is deleted from Plex (its titles stay).
- Custom and seasonal collections defined in tk.box (by hand, from a curated universe or a public list), with Radarr
  fetching a seasonal collection's missing movies and, when asked, removing them again once its season ends.
- Discover: the public lists and universes the Collections page offers, and a preview of what one would hold.

It reads the same JSON config tk.box writes for the artwork engine and shares its Plex, TMDb and HTTP code
(engine_common.py), but none of its imaging: Pillow and NumPy are never loaded here. A collection's poster is the
artwork engine's job; tk.box runs this script first, so collections made now get their posters in the same pass.
"""

import argparse
import contextlib
import json
import os
import re
import secrets
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse
import xml.etree.ElementTree as ET

from engine_common import (CHARTS, DEFAULTS, HTTP, Metadata, atomic_write, collection_key, local_path, option, read_config,
                           run_lock, secret, select_item, streaming_services, web_download)


def create_collection(plex, params):
    """The new collection's Directory element (None if Plex doesn't return one). tk.box reads the CREATED line to make
    the new collection's poster straight away."""
    with plex.http.request("POST", plex.url + "/library/collections", headers=plex.headers, params=params) as response:
        created = ET.fromstring(response.content).find("Directory")
    if created is not None and str(created.get("ratingKey") or "").isdigit():
        print(f"CREATED {params['title']}: Plex ID {created.get('ratingKey')}", flush=True)
    return created


def collection_titles(plex, section_key):
    """{collection_key(title): [(rating key, is smart)]} of everything in one library, to see what already exists."""
    found = {}
    for e in plex.collection_entries(section_key):
        found.setdefault(collection_key(e.get("title")), []).append((e.get("ratingKey"), e.get("smart") == "1"))
    return found


def lead_list(plex, apply, section_key, rating_key, title, library, rank="!001"):
    """Plex lists collections by sort title and "!" sorts before letters, so this puts one at the front of the list.
    The chart collections use !001 and the streaming services !002, so they follow the charts, each group by name."""
    sort = f"{rank} {title}"
    entry = plex.xml(f"/library/metadata/{rating_key}").find("Directory")
    if entry is not None and entry.get("titleSort") == sort:
        return
    print(f"{'' if apply else 'PLAN '}SORT {title} [{library}]: first in the collections list", flush=True)
    if apply:
        plex.send("PUT", f"/library/sections/{section_key}/all",
                  {"type": 18, "id": rating_key, "titleSort.value": sort, "titleSort.locked": 1})


def members_of(plex, rating_key):
    """{rating key: title} of a collection's movies."""
    return {e.get("ratingKey"): e.get("title", "") for e in plex.xml(f"/library/metadata/{rating_key}/children")
            if e.tag in ("Video", "Directory")}


COLLECTION_PROVIDERS = {
    "tmdb": ("TMDb", "www.themoviedb.org"), "imdb": ("IMDb", "www.imdb.com"),
    "trakt": ("Trakt", "trakt.tv"), "letterboxd": ("Letterboxd", "letterboxd.com"),
    "mdblist": ("MDBList", "mdblist.com"), "flixpatrol": ("FlixPatrol", "flixpatrol.com")}
COLLECTION_RECOMMENDATIONS = (
    ("TMDb Trending Movies", "https://www.themoviedb.org/trending/movie/week", "This week's trending movies", "movie"),
    ("TMDb Trending TV", "https://www.themoviedb.org/trending/tv/week", "This week's trending shows", "tv"),
    ("TMDb Top Rated Movies", "https://www.themoviedb.org/movie/top-rated", "Highly rated movies", "movie"),
    ("IMDb Top 250", "https://www.imdb.com/chart/top/", "Classic and contemporary audience favorites", "movie"),
    ("IMDb Popular Movies", "https://www.imdb.com/chart/moviemeter/", "Movies attracting attention on IMDb", "movie"),
    ("IMDb Top Rated TV", "https://www.imdb.com/chart/toptv/", "Highly rated television", "tv"),
    ("Trakt Trending Movies", "https://trakt.tv/movies/trending", "Movies being watched now", "movie"),
    ("Trakt Trending Shows", "https://trakt.tv/shows/trending", "Shows being watched now", "tv"),
    ("Letterboxd Top 250", "https://letterboxd.com/xobl/list/official-top-250-narrative-feature-films/", "Community-rated narrative features", "movie"),
    ("Netflix Top 10", "https://flixpatrol.com/top10/netflix/world/", "Netflix's worldwide movie and TV charts", "movie"),
    ("Disney+ Top 10", "https://flixpatrol.com/top10/disney/world/", "Disney+ worldwide movie and TV charts", "movie"),
    ("Prime Video Top 10", "https://flixpatrol.com/top10/amazon-prime/world/", "Prime Video worldwide charts", "movie"))


# Membership sources: github.com/Kometa-Team/Kometa/blob/master/defaults/both/universe.yml
COLLECTION_UNIVERSES = (
    ("avp", "Alien / Predator", "https://www.imdb.com/list/ls543971628/", ("movie",)),
    ("arrow", "Arrowverse", "https://www.imdb.com/list/ls566667558/", ("movie", "tv")),
    ("askew", "View Askewniverse", "https://mdblist.com/lists/k0meta/external/15362/", ("movie", "tv")),
    ("conjuring", "Conjuring Universe", "https://www.imdb.com/list/ls068768438/", ("movie",)),
    ("dca", "DC Animated Universe", "https://mdblist.com/lists/johnfawkes/dca/", ("movie", "tv")),
    ("dceu", "DC Extended Universe", "https://mdblist.com/lists/fa11en82/dc-extended-universe/", ("movie", "tv")),
    ("dcu", "DC Universe", "https://www.themoviedb.org/list/8642250/", ("movie", "tv")),
    ("fast", "Fast & Furious", "https://www.imdb.com/list/ls4102351575/", ("movie",)),
    ("marvel", "In Association With Marvel", "https://mdblist.com/lists/k0meta/external/15110/", ("movie", "tv")),
    ("mcu", "Marvel Cinematic Universe", "https://www.imdb.com/list/ls539646485/", ("movie", "tv")),
    ("middle", "Middle Earth", "https://mdblist.com/lists/k0meta/external/46550/", ("movie", "tv")),
    ("rocky", "Rocky / Creed", "https://mdblist.com/lists/k0meta/external/9248/", ("movie",)),
    ("trek", "Star Trek", "https://www.imdb.com/list/ls547463722/", ("movie", "tv")),
    ("star", "Star Wars Universe", "https://www.imdb.com/list/ls501373412/", ("movie", "tv")),
    ("mummy", "Mummy Universe", "https://mdblist.com/lists/k0meta/external/9249/", ("movie",)),
    ("wizard", "Wizarding World", "https://mdblist.com/lists/k0meta/external/23683/", ("movie",)),
    ("xmen", "X-Men Universe", "https://www.imdb.com/list/ls567618635/", ("movie", "tv")))
IMDB_CHARTS = {"top": "TOP_RATED_MOVIES", "toptv": "TOP_RATED_TV_SHOWS", "moviemeter": "MOST_POPULAR_MOVIES", "tvmeter": "MOST_POPULAR_TV_SHOWS"}
IMDB_PAGE = "pageInfo { hasNextPage endCursor } edges { title { id titleText { text } releaseYear { year } titleType { canHaveEpisodes } } }"


def collection_source(url):
    """Canonical public list URL. Never forward user-supplied credentials, hosts or query strings."""
    if not isinstance(url, str):
        raise ValueError("Enter a public collection URL")
    parsed = urlparse(url.strip())
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Use an HTTPS collection URL without credentials or a custom port")
    provider = next((key for key, (_, host) in COLLECTION_PROVIDERS.items() if parsed.hostname in (host, host.removeprefix("www."))), None)
    path = parsed.path.rstrip("/")
    patterns = {
        "tmdb": r"/(?:collection/\d+(?:-[\w-]+)?|list/\d+(?:-[\w-]+)?|trending/(?:movie|tv)/(?:day|week)|(?:movie|tv)/(?:popular|top-rated))",
        "imdb": r"/(?:list/ls\d+|chart/(?:top|toptv|moviemeter|tvmeter))",
        "trakt": r"/(?:users/[\w-]+/lists/[\w-]+|lists/\d+|(?:movies|shows)/(?:trending|popular))",
        "letterboxd": r"/[\w-]+/list/[\w-]+",
        "mdblist": r"/lists/(?:\d+|[\w-]+/[\w-]+|[\w-]+/external/\d+)",
        "flixpatrol": r"/top10/[\w-]+/[\w-]+(?:/\d{4}-\d{2}-\d{2})?"}
    if provider is None or not re.fullmatch(patterns[provider], path):
        raise ValueError("Unsupported list URL. Use a TMDb list/collection/chart, IMDb list/chart, Trakt list/chart, Letterboxd list, MDBList list or FlixPatrol Top 10 URL")
    return provider, "https://" + COLLECTION_PROVIDERS[provider][1] + path + "/"


class CollectionPage(HTMLParser):
    """The public page's structured data and links; never executes embedded scripts."""
    def __init__(self, data):
        super().__init__(convert_charrefs=True)
        self.scripts, self.links, self.posters, self.title = [], [], [], ""
        self.script = self.link = None
        self.in_title = False
        self.tables, self.heading, self.heading_tag, self.section = 0, "", None, None
        self.feed(data)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and (attrs.get("type") == "application/ld+json" or attrs.get("id") == "__NEXT_DATA__"):
            self.script = ""
        if tag == "title":
            self.in_title = True
        if tag in ("h1", "h2", "h3"):
            self.heading, self.heading_tag = "", tag
        if tag == "table":
            self.tables += 1
        if tag == "a" and attrs.get("href"):
            self.link = {"url": attrs["href"], "title": "", "next": attrs.get("rel") == "next" or "next" in attrs.get("class", "").split(),
                         "table": bool(self.tables), "media": self.section}
        film = attrs.get("data-film-slug") or attrs.get("data-item-slug")
        if film:
            self.posters.append({"url": attrs.get("data-item-link") or "/film/" + film.strip("/").removeprefix("film/") + "/", "title": attrs.get("data-item-name") or attrs.get("data-film-name", "")})
        if tag == "img" and self.link and attrs.get("alt"):
            self.link["title"] += attrs["alt"]

    def handle_data(self, data):
        if self.heading_tag:
            self.heading += data
        if self.script is not None:
            self.script += data
        if self.in_title:
            self.title += data
        if self.link is not None:
            self.link["title"] += data

    def handle_endtag(self, tag):
        if tag == "table":
            self.tables = max(0, self.tables - 1)
        if tag == self.heading_tag:
            self.section = "movie" if re.search(r"\b(movies|films)\b", self.heading, re.I) else "tv" if re.search(r"\b(tv|shows|series)\b", self.heading, re.I) else None
            self.heading_tag = None
        if tag == "script" and self.script is not None:
            with contextlib.suppress(ValueError):
                self.scripts.append(json.loads(self.script.strip().removeprefix("/* <![CDATA[ */").removesuffix("/* ]]> */")))
            self.script = None
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.link is not None:
            self.link["title"] = " ".join(self.link["title"].split())
            self.links.append(self.link)
            self.link = None


class CollectionSources:
    def __init__(self, artwork):
        self.artwork, self.config, self.http = artwork, artwork.config, artwork.http

    def key(self, name, variable):
        value = secret(self.config.get("api", {}).get(name, os.environ.get(variable, "")))
        if not value:
            raise ValueError(f"Set {variable} to use this collection provider")
        return value

    def api(self, provider, path, **params):
        if provider == "tmdb":
            if not self.artwork.keys.get("tmdb_key"):
                raise ValueError("Set TMDB_API_KEY to use TMDb collections")
            return self.artwork.tmdb(path, **params)
        if provider == "trakt":
            headers = {"trakt-api-version": "2", "trakt-api-key": self.key("trakt_client_id", "TRAKT_CLIENT_ID")}
            return self.http.json("https://api.trakt.tv" + path, headers=headers, params=params)
        params["apikey"] = self.key("mdblist_key", "MDBLIST_API_KEY")
        return self.http.json("https://api.mdblist.com" + path, params=params)

    def page(self, url):
        # Same DNS-pinned public-only downloader as artwork imports; redirects are checked too.
        key = "collection-page:" + url
        cached = self.http.recall(key)
        if cached is None:
            cached = web_download(url).decode("utf-8", errors="replace")
            self.http.remember(key, cached)
        return CollectionPage(cached)

    def imdb(self, field, **variables):
        """IMDb's own GraphQL API: list and chart pages refuse servers, but the API their site loads from answers them."""
        names = {"id": "ID!", "after": "String"}
        query = "query%s { %s }" % ("(" + ", ".join(f"${k}: {names[k]}" for k in variables) + ")" if variables else "", field)
        key = "imdb-graphql:" + json.dumps([query, variables], sort_keys=True)
        data = self.http.recall(key)
        if data is None:
            with self.http.request("POST", "https://api.graphql.imdb.com/", json={"query": query, "variables": variables},
                                   headers={"content-type": "application/json", "x-imdb-client-name": "imdb-web-next"}) as response:
                data = response.json()
            errors = [e.get("extensions", {}).get("code") or e.get("message") for e in data.get("errors") or []]
            if "RESOURCE_NOT_FOUND" in errors:
                raise ValueError("That IMDb list doesn't exist")
            if "FORBIDDEN" in errors:
                raise ValueError("That IMDb list is private; make it public on IMDb first")
            if errors or not data.get("data"):
                raise ValueError("IMDb did not return the list (" + (errors[0] if errors else "empty answer") + ")")
            data = self.http.remember(key, data["data"])
        return data

    @staticmethod
    def objects(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from CollectionSources.objects(child)
        elif isinstance(value, list):
            for child in value:
                yield from CollectionSources.objects(child)

    def recommendations(self, provider="all", query=""):
        if provider not in ("all", *COLLECTION_PROVIDERS):
            raise ValueError("Unknown collection provider")
        rows = [{"name": name, "url": url, "description": description, "type": kind, "provider": collection_source(url)[0]}
                for name, url, description, kind in COLLECTION_RECOMMENDATIONS]
        rows = [r for r in rows if (provider == "all" or r["provider"] == provider) and query.casefold() in (r["name"] + " " + r["description"]).casefold()]
        if provider in ("all", "mdblist") and (not query or query.casefold() in "popular mdblist collections"):
            rows.append({"name": "Popular MDBList collections", "url": None, "description": "Browse community lists ranked by likes (requires MDBLIST_API_KEY)", "type": "movie", "provider": "mdblist"})
        return rows

    def universes(self, query="", kind="movie"):
        if kind not in ("movie", "tv"):
            raise ValueError("Choose movies or TV for universe collections")
        return [{"key": key, "name": name, "url": url, "description": "Curated universe membership from " + COLLECTION_PROVIDERS[collection_source(url)[0]][0],
                 "type": kind, "provider": collection_source(url)[0]}
                for key, name, url, kinds in COLLECTION_UNIVERSES if kind in kinds and query.casefold() in name.casefold()]

    def discover(self, provider, query=""):
        rows = []
        if provider == "tmdb":
            if not query.strip():
                return self.recommendations(provider)
            for row in self.api("tmdb", "/search/collection", query=query, page=1).get("results", [])[:20]:
                rows.append({"name": row["name"], "url": f"https://www.themoviedb.org/collection/{row['id']}/", "description": row.get("overview", ""), "type": "movie", "provider": provider})
        elif provider == "trakt":
            results = self.api("trakt", "/search/list", query=query, limit=20) if query else self.api("trakt", "/lists/popular", limit=20)
            for row in results:
                info = row.get("list", row)
                rows.append({"name": info["name"], "url": f"https://trakt.tv/lists/{info['ids']['trakt']}/", "description": info.get("description") or "Public Trakt list", "type": "movie", "provider": provider})
        elif provider == "mdblist":
            results = self.api("mdblist", "/lists/search", query=query) if query else self.api("mdblist", "/lists/top")
            for row in results[:20]:
                rows.append({"name": row["name"], "url": f"https://mdblist.com/lists/{row['id']}/", "description": row.get("description") or "Popular MDBList collection", "type": "tv" if row.get("mediatype") == "show" else "movie", "provider": provider})
        elif provider == "letterboxd":
            page = self.page("https://letterboxd.com/lists/popular/this/week/")
            seen = set()
            for link in page.links:
                if re.fullmatch(r"/[\w-]+/list/[\w-]+/", link["url"]) and link["title"] and link["url"] not in seen:
                    seen.add(link["url"])
                    if query.casefold() in link["title"].casefold():
                        rows.append({"name": link["title"], "url": "https://letterboxd.com" + link["url"], "description": "Popular this week on Letterboxd", "type": "movie", "provider": provider})
            rows = rows[:20]
            if not rows and not query:
                raise ValueError("Letterboxd did not return readable public lists; try a specific list URL")
        elif provider in ("imdb", "flixpatrol"):
            rows = self.recommendations(provider, query)
        else:
            raise ValueError("Choose a provider to browse")
        return rows

    def fetch(self, url, kind="movie", limit=None):
        provider, url = collection_source(url)
        limit = option({}, "collection_source_limit") if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= 250 or kind not in ("movie", "tv"):
            raise ValueError("Choose movies or TV and a source limit from 1 to 250")
        path = urlparse(url).path.rstrip("/")
        name = next((r[0] for r in COLLECTION_RECOMMENDATIONS if collection_source(r[1])[1] == url), path.split("/")[-1].replace("-", " "))
        rows = []
        def add(row, media=None, title_only=False):
            media = media or row.get("media_type") or row.get("mediatype") or kind
            if ("tv" if media in ("show", "tv", "TVSeries") else "movie") != kind:
                return
            ids = row.get("ids") or {}
            title = row.get("title") or row.get("name") or ""
            year = row.get("year") or row.get("release_year") or str(row.get("release_date") or row.get("first_air_date") or "")[:4]
            member = {"tmdb_id": int(ids.get("tmdb") or row["tmdb_id"])} if ids.get("tmdb") or row.get("tmdb_id") else None
            imdb = ids.get("imdb") or row.get("imdb_id")
            if member is None and imdb and re.fullmatch(r"tt\d+", str(imdb)):
                member = {"imdb_id": imdb}
            if member is None and title and (year or title_only):
                member = {"title": title, **({"year": int(year)} if year else {})}
            if member is None:
                raise ValueError("A source title could not be identified; refusing partial membership")
            if not any(r["member"] == member for r in rows):
                rows.append({"title": title or str(next(iter(member.values()))), "year": year, "member": member})
        if provider == "tmdb":
            if path.startswith("/collection/"):
                result = self.api(provider, "/collection/" + re.search(r"/collection/(\d+)", path)[1])
                name = result["name"]
                for row in result.get("parts", []):
                    add({**row, "tmdb_id": row["id"]}, "movie")
            else:
                endpoint = "/list/" + re.search(r"/list/(\d+)", path)[1] if path.startswith("/list/") else path.replace("top-rated", "top_rated")
                for page in range(1, 26):
                    result = self.api(provider, endpoint, page=page)
                    name = result.get("name") or name
                    batch = result.get("items", result.get("results", []))
                    for row in batch:
                        add({**row, "tmdb_id": row["id"]}, row.get("media_type") or ("tv" if "/tv/" in path else "movie"))
                    if len(rows) >= limit or not batch or page >= result.get("total_pages", 1):
                        break
                else:
                    raise ValueError("Too many source pages; choose a smaller collection limit")
        elif provider == "trakt":
            chart = path.startswith(("/movies/", "/shows/"))
            endpoint = path if chart else path + "/items/" + ("movies" if kind == "movie" else "shows")
            if not chart:
                name = self.api(provider, path).get("name", name)
            for page in range(1, 26):
                batch = self.api(provider, endpoint, page=page, limit=100)
                for row in batch:
                    add(row.get("movie", row.get("show", row)), "tv" if "show" in row or path.startswith("/shows/") else "movie")
                if len(rows) >= limit or len(batch) < 100:
                    break
            else:
                raise ValueError("Too many source pages; choose a smaller collection limit")
        elif provider == "mdblist":
            external = re.fullmatch(r"/lists/[\w-]+/external/(\d+)", path)
            endpoint = "/external/lists/" + external[1] if external else path
            if external or re.fullmatch(r"/lists/\d+", endpoint):
                metadata = self.api(provider, endpoint)
                if isinstance(metadata, list):
                    metadata = metadata[0] if metadata else {}
                name = metadata.get("name") or name
            for offset in range(0, 2500, 100):
                result = self.api(provider, endpoint + "/items", limit=100, offset=offset, **({"unified": True} if external else {}))
                batch = result if isinstance(result, list) else result.get("movies" if kind == "movie" else "shows", result.get("items", []))
                for row in batch:
                    add({**row, "tmdb_id": row.get("id") or row.get("tmdbid")}, row.get("mediatype") or row.get("type") or kind)
                if len(rows) >= limit or not result or isinstance(result, dict) and not any(result.get(key) for key in ("movies", "shows", "items")):
                    break
            else:
                raise ValueError("Too many source pages; choose a smaller collection limit")
        elif provider == "imdb":
            chart = IMDB_CHARTS.get(path.split("/")[-1]) if path.startswith("/chart/") else None
            after = None
            for _ in range(25):
                if chart:
                    result = self.imdb("chartTitles(first: 250, chart: {chartType: %s}) { %s }" % (chart, IMDB_PAGE.replace("title {", "node {")))["chartTitles"]
                else:
                    found = self.imdb("list(id: $id) { name { originalText } titleListItemSearch(first: 250, after: $after) { %s } }" % IMDB_PAGE,
                                      id=path.split("/")[-1], after=after)["list"]
                    name = (found.get("name") or {}).get("originalText") or name
                    result = found["titleListItemSearch"]
                for edge in result.get("edges") or []:
                    title = edge.get("title") or edge.get("node")
                    if not title or not re.fullmatch(r"tt\d+", str(title.get("id"))):
                        raise ValueError("An IMDb list item has no readable identifier; refusing partial membership")
                    add({"title": (title.get("titleText") or {}).get("text", ""), "year": str((title.get("releaseYear") or {}).get("year") or ""), "imdb_id": title["id"]},
                        "tv" if (title.get("titleType") or {}).get("canHaveEpisodes") else "movie")
                if len(rows) >= limit or not result["pageInfo"]["hasNextPage"]:
                    break
                after = result["pageInfo"]["endCursor"]
            else:
                raise ValueError("Too many source pages; choose a smaller collection limit")
        else:
            page = self.page(url)
            name = page.title.split(" • ")[0].strip() or name
            links, seen, labels, media_types = [], set(), {}, {}
            for number in range(1, 11):
                candidates = page.posters if provider == "letterboxd" and page.posters else page.links
                for link in candidates:
                    if provider == "flixpatrol" and (not link.get("table") or link.get("media") not in (None, kind)):
                        continue
                    target = urljoin(url, link["url"])
                    parsed = urlparse(target)
                    pattern = r"/film/[\w-]+/" if provider == "letterboxd" else r"/title/[\w-]+/"
                    if parsed.hostname == COLLECTION_PROVIDERS[provider][1] and re.fullmatch(pattern, parsed.path) and target not in seen:
                        seen.add(target)
                        links.append(target)
                        labels[target] = link["title"]
                        media_types[target] = link.get("media")
                if len(links) >= limit * (2 if provider == "flixpatrol" else 1):
                    break
                next_link = next((link for link in page.links if link["next"]), None)
                if not next_link:
                    break
                target = urljoin(url, next_link["url"])
                if urlparse(target).hostname != COLLECTION_PROVIDERS[provider][1] or not urlparse(target).path.startswith(path + "/"):
                    raise ValueError("Unexpected pagination link from provider")
                page = self.page(target)
            else:
                raise ValueError("Too many source pages; choose a smaller collection limit")
            for target in links:
                label = re.fullmatch(r"(.+) \((\d{4})\)", labels.get(target, ""))
                if provider == "letterboxd" and label:
                    add({"title": label[1], "year": label[2]}, "movie")
                    if len(rows) >= limit:
                        break
                    continue
                detail = self.page(target)
                found = False
                for link in detail.links:
                    match = re.search(r"themoviedb\.org/(movie|tv)/(\d+)", link["url"])
                    if match:
                        add({"title": detail.title.split(" (")[0].split(" • ")[0], "tmdb_id": int(match[2])}, match[1])
                        found = True
                        break
                if not found:
                    for script in detail.scripts:
                        for obj in self.objects(script):
                            if obj.get("@type") in ("Movie", "TVSeries"):
                                add({"title": obj.get("name"), "year": str(obj.get("datePublished") or "")[:4]}, obj["@type"])
                                found = True
                                break
                if not found and provider == "flixpatrol" and media_types[target] == kind and labels[target]:
                    add({"title": labels[target]}, kind, title_only=True)
                    found = True
                if not found:
                    raise ValueError("A source title could not be identified; import stopped to avoid partial membership")
                if len(rows) >= limit:
                    break
        if not rows:
            raise ValueError("No readable titles of the selected media type were returned; check the list, media type and provider access")
        rows = rows[:limit]
        if self.artwork.keys.get("tmdb_key"):
            for row in rows:
                member = row["member"]
                if "imdb_id" in member:
                    result = self.api("tmdb", "/find/" + member["imdb_id"], external_source="imdb_id")
                    matches = result.get("movie_results" if kind == "movie" else "tv_results", [])
                elif "title" in member:
                    params = {("year" if kind == "movie" else "first_air_date_year"): member["year"]} if member.get("year") else {}
                    result = self.api("tmdb", "/search/" + ("movie" if kind == "movie" else "tv"), query=member["title"], **params)
                    matches = [m for m in result.get("results", []) if (m.get("title") or m.get("name", "")).casefold() == member["title"].casefold()
                               and (not member.get("year") or str(m.get("release_date") or m.get("first_air_date") or "")[:4] == str(member["year"]))]
                    if result.get("total_pages", 1) > 1:
                        matches = []
                else:
                    continue
                if len(matches) == 1:
                    match = matches[0]
                    row.update(member={"tmdb_id": match["id"]}, title=match.get("title") or match.get("name") or row["title"],
                               year=str(match.get("release_date") or match.get("first_air_date") or row["year"])[:4])
        return {"provider": provider, "url": url, "name": name, "type": kind, "limit": limit, "items": rows}


def collection_active(schedule, today=None):
    if not schedule:
        return True
    if not isinstance(schedule, str) or not re.fullmatch(r"\d{2}/\d{2}-\d{2}/\d{2}", schedule):
        raise ValueError("Collection schedule must be MM/DD-MM/DD")
    start, end = [tuple(map(int, part.split("/"))) for part in schedule.split("-")]
    for month, day in (start, end):
        date(2000, month, day)
    today = today or date.today()
    current = (today.month, today.day)
    return start <= current <= end if start <= end else current >= start or current <= end


def validate_collections(config):
    definitions = option(config, "collections")
    if not isinstance(definitions, list):
        raise ValueError("collections must be a list")
    seen = set()
    for entry in definitions:
        if not isinstance(entry, dict) or set(entry) - {"name", "library", "type", "enabled", "schedule", "sync", "members", "rules", "visibility", "acquire", "cleanup", "source", "exclude"}:
            raise ValueError("Each collection must be a mapping with supported collection settings")
        for field in ("name", "library"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
                raise ValueError(f"Collection {field} must be nonempty text")
        identity = (entry["library"], collection_key(entry["name"]))
        if not identity[1] or identity in seen:
            raise ValueError("Collection names must be unique within each library")
        seen.add(identity)
        if entry.get("type") not in ("movie", "tv"):
            raise ValueError("Collection type must be movie or tv")
        for field in ("enabled", "acquire"):
            if field in entry and type(entry[field]) is not bool:
                raise ValueError(f"Collection {field} must be true or false")
        if entry.get("sync", "append") not in ("sync", "append"):
            raise ValueError("Collection sync must be sync or append")
        collection_active(entry.get("schedule"))
        source = entry.get("source")
        if source is not None:
            if not isinstance(source, dict) or set(source) - {"url", "limit", "refresh"}:
                raise ValueError("Collection source supports url, limit and refresh")
            collection_source(source.get("url"))
            if type(source.get("limit", option({}, "collection_source_limit"))) is not int or not 1 <= source.get("limit", option({}, "collection_source_limit")) <= 250:
                raise ValueError("Source limit must be an integer from 1 to 250")
            if "refresh" in source and type(source["refresh"]) is not bool:
                raise ValueError("Source refresh must be true or false")
        members, rules, exclude = entry.get("members", []), entry.get("rules", {}), entry.get("exclude", [])
        if not isinstance(members, list) or not isinstance(exclude, list) or not isinstance(rules, dict):
            raise ValueError("Collection members and exclude must be lists and rules must be a mapping")
        for member in members + exclude:
            if not isinstance(member, dict) or not member or set(member) - {"rating_key", "tmdb_id", "imdb_id", "title", "year"}:
                raise ValueError("Collection members use rating_key, tmdb_id, imdb_id, or title and optional year")
            if sum(key in member for key in ("rating_key", "tmdb_id", "imdb_id", "title")) != 1 or ("year" in member and "title" not in member):
                raise ValueError("Use exactly one identifier per collection member")
            for key, value in member.items():
                if key in ("year", "tmdb_id"):
                    if type(value) is not int or value < 1:
                        raise ValueError(f"Member {key} must be a positive integer")
                elif not isinstance(value, str) or not value.strip() or (key == "rating_key" and not value.isdigit()) or (key == "imdb_id" and not re.fullmatch(r"tt\d+", value)):
                    raise ValueError(f"Invalid member {key}")
        if set(rules) - {"genres", "year_from", "year_to", "title_contains"}:
            raise ValueError("Rules support genres, year_from, year_to and title_contains")
        if "genres" in rules and (not isinstance(rules["genres"], list) or not rules["genres"] or any(not isinstance(g, str) or not g.strip() for g in rules["genres"])):
            raise ValueError("genres must be a nonempty list of names")
        for key in ("year_from", "year_to"):
            if key in rules and (type(rules[key]) is not int or not 1 <= rules[key] <= 9999):
                raise ValueError(f"{key} must be a year")
        if rules.get("year_from", 1) > rules.get("year_to", 9999):
            raise ValueError("year_from must not exceed year_to")
        if "title_contains" in rules and (not isinstance(rules["title_contains"], str) or not rules["title_contains"].strip()):
            raise ValueError("title_contains must be nonempty text")
        # A collection that is off may still be a draft; it needs something to hold only once it is on.
        enabled = entry.get("enabled", True)
        if enabled and not members and not rules and not source:
            raise ValueError(f"{entry['name']} needs titles, a list or a rule before it can be turned on")
        visibility = entry.get("visibility", {})
        if not isinstance(visibility, dict) or set(visibility) - {"home", "shared", "recommended"} or any(type(v) is not bool for v in visibility.values()):
            raise ValueError("visibility accepts home, shared and recommended booleans")
        if entry.get("cleanup", "keep") not in ("keep", "remove-delete"):
            raise ValueError("Collection cleanup must be keep or remove-delete")
        if entry.get("acquire") and entry["type"] != "movie":
            raise ValueError(f"{entry['name']}: only movie collections can download through Radarr")
        if enabled and entry.get("acquire") and not (source or any("tmdb_id" in m for m in members)):
            raise ValueError(f"{entry['name']}: Radarr downloads need titles with TMDb IDs (tmdb:123) or a list")
        if entry.get("cleanup") == "remove-delete" and (not entry.get("schedule") or not entry.get("acquire")):
            raise ValueError("remove-delete requires a seasonal collection with acquire: true")
    radarr = config.get("radarr", {})
    if not isinstance(radarr, dict) or set(radarr) - {"url", "api_key", "root_folder", "quality_profile_id", "search"}:
        raise ValueError("Unsupported radarr settings")
    if "search" in radarr and type(radarr["search"]) is not bool:
        raise ValueError("radarr.search must be true or false")
    # Without a quality profile ID, downloads use Radarr's first quality profile.
    if "quality_profile_id" in radarr and (type(radarr["quality_profile_id"]) is not int or radarr["quality_profile_id"] < 1):
        raise ValueError("radarr.quality_profile_id must be a positive integer")
    if any(entry.get("acquire") and entry.get("enabled", True) for entry in definitions):
        for key in ("url", "api_key", "root_folder"):
            if not isinstance(radarr.get(key), str) or not radarr[key].strip():
                raise ValueError(f"radarr.{key} is required for acquisition")
    return definitions


def validate_automatic(config):
    """{(library, collection key): setting} for the franchise and streaming collections the admin turned off or set
    where they show; the rest are kept as they are made."""
    settings = config.get("automatic_collections", [])
    if not isinstance(settings, list):
        raise ValueError("automatic_collections must be a list")
    found = {}
    for entry in settings:
        if not isinstance(entry, dict) or set(entry) - {"name", "library", "kind", "enabled", "visibility", "exclude"}:
            raise ValueError("Each automatic collection setting supports name, library, kind, enabled, visibility and exclude")
        exclude = entry.get("exclude", [])
        if not isinstance(exclude, list) or any(not isinstance(key, str) or not key.isdigit() for key in exclude):
            raise ValueError("An automatic collection's exclude is a list of Plex IDs")
        if not all(isinstance(entry.get(k), str) and entry[k].strip() for k in ("name", "library")):
            raise ValueError("Automatic collection settings need a name and a library")
        if entry.get("kind", "franchise") not in ("franchise", "streaming") or type(entry.get("enabled", True)) is not bool:
            raise ValueError("Automatic collection kind must be franchise or streaming, and enabled true or false")
        visibility = entry.get("visibility", {})
        if not isinstance(visibility, dict) or set(visibility) - set(VISIBILITY) or any(type(v) is not bool for v in visibility.values()):
            raise ValueError("visibility accepts home, shared and recommended booleans")
        found[(entry["library"], collection_key(entry["name"]))] = entry
    return found


VISIBILITY = {"home": "promotedToOwnHome", "shared": "promotedToSharedHome", "recommended": "promotedToRecommended"}


def show_in(plex, apply, prefix, section_key, name, library, rating_key, visibility, active=True):
    """Where a collection shows in Plex: your Home, friends' Homes and the library's recommendations."""
    params = {VISIBILITY[key]: int(value and active) for key, value in visibility.items()}
    print(f"{prefix}VISIBILITY {name} [{library}]: " + ", ".join(f"{k}={'on' if v and active else 'off'}" for k, v in visibility.items()), flush=True)
    if not apply or rating_key is None:
        return
    path = f"/hubs/sections/{section_key}/manage"
    hub = plex.xml(path, {"metadataItemId": rating_key}).find("Hub")
    if hub is not None:
        identifier = hub.get("identifier")
        if not identifier:
            raise ValueError("Plex returned a hub without an identifier")
        if any(hub.get(k) != str(v) for k, v in params.items()):
            plex.send("PUT", path + "/" + quote(identifier, safe=""), params)
    elif any(params.values()):
        plex.send("POST", path, {**params, "metadataItemId": rating_key})


def collection_members(entry, items):
    selected, missing = set(), []
    for member in entry.get("members", []):
        matches = [item for item in items if all(str(item.get(k, "")).casefold() == str(v).casefold() for k, v in member.items())]
        if len(matches) != 1:
            if matches or not entry.get("source"):
                missing.append(member)
        else:
            selected.add(matches[0]["rating_key"])
    rules = entry.get("rules", {})
    if rules:
        for item in items:
            year = int(item.get("year") or 0)
            if rules.get("genres") and not {g.casefold() for g in rules["genres"]} & {g.casefold() for g in item.get("genres", [])}:
                continue
            if "year_from" in rules and year < rules["year_from"] or "year_to" in rules and (not year or year > rules["year_to"]):
                continue
            if rules.get("title_contains", "").casefold() not in item["title"].casefold():
                continue
            selected.add(item["rating_key"])
    return [item["rating_key"] for item in items if item["rating_key"] in selected], missing


def seasonal_radarr(artwork, definitions, items, apply, today):
    """Only a successful add recorded here AND its private Radarr tag grant cleanup ownership."""
    if not any(entry.get("acquire") and entry.get("enabled", True) for entry in definitions):
        return
    settings = artwork.config["radarr"]
    url = settings["url"].rstrip("/")
    token = secret(settings["api_key"])
    if not token:
        raise ValueError("Set RADARR_API_KEY before using acquisition")
    def request(method, path, **kwargs):
        with artwork.http.request(method, url + "/api/v3/" + path, headers={"X-Api-Key": token}, **kwargs) as response:
            return response.json() if response.content else None
    # This durable journal is intentionally outside the expiring artwork cache.
    state_path = artwork.base / "overlayrr-collections.json"
    try:
        state = json.loads(state_path.read_bytes()) if state_path.exists() else {"version": 1, "server": url, "tag": "overlayrr-" + secrets.token_hex(8), "movies": {}}
    except (OSError, ValueError):
        raise ValueError("Cannot read overlayrr-collections.json; Radarr acquisition and cleanup refused. Restore the ownership journal from backup") from None
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("movies"), dict) or not isinstance(state.get("tag"), str):
        raise ValueError("Invalid overlayrr-collections.json; Radarr acquisition and cleanup refused. Restore the ownership journal from backup")
    if state.get("server") != url:
        raise ValueError("Radarr URL differs from overlayrr-collections.json; Radarr acquisition and cleanup refused. Restore the previous radarr.url or the journal for this server")
    save = lambda: atomic_write(state_path, json.dumps(state, indent=2).encode())
    movies = request("GET", "movie")
    existing = {int(movie["tmdbId"]): movie for movie in movies}
    tags = request("GET", "tag")
    tag = next((t["id"] for t in tags if t["label"] == state["tag"]), None)
    active_ids, acquisition, owners = set(), set(), {}
    def identity(entry):
        return entry["library"] + ":" + collection_key(entry["name"])
    for entry in definitions:
        owner = identity(entry)
        owners[owner] = entry
        if not entry.get("enabled", True) or not collection_active(entry.get("schedule"), today):
            continue
        ids = {m["tmdb_id"] for m in entry.get("members", []) if "tmdb_id" in m}
        candidates = [i for i in items if i["library"] == entry["library"] and i["type"] == entry["type"]]
        keys, _ = collection_members(entry, candidates)
        ids.update(i["tmdb_id"] for i in candidates if i["rating_key"] in keys and i.get("tmdb_id"))
        if entry["type"] == "movie":
            active_ids.update(ids)
            if entry.get("acquire"):
                acquisition.update(m["tmdb_id"] for m in entry.get("members", []) if "tmdb_id" in m)
    present = {i["tmdb_id"] for i in items if i["type"] == "movie" and i.get("tmdb_id")}
    missing = acquisition - existing.keys() - present
    if missing:
        profiles, roots = request("GET", "qualityprofile"), request("GET", "rootfolder")
        profile = settings.get("quality_profile_id") or next((p["id"] for p in profiles), None)
        if profile not in {p["id"] for p in profiles}:
            available = ", ".join(str(p["id"]) for p in profiles) or "none"
            raise ValueError(f"Radarr quality profile ID {profile} does not exist. Available IDs: {available}")
        root_folder = next((r["path"] for r in roots if r["path"].rstrip("/") == settings["root_folder"].rstrip("/")), None)
        if root_folder is None:
            available = ", ".join(repr(r["path"]) for r in roots) or "none"
            raise ValueError(f"Radarr root folder {settings['root_folder']!r} is not configured. Registered folders: {available}. Use the path Radarr sees (inside its container, if applicable)")
        if apply:
            save()
            if tag is None:
                tag = request("POST", "tag", json={"label": state["tag"]})["id"]
        for tmdb_id in sorted(missing):
            print(f"{' ' if apply else 'PLAN '}RADARR ADD tmdb:{tmdb_id}", flush=True)
            if not apply:
                continue
            # Recheck immediately before adding; never adopt a pre-existing movie.
            if any(m.get("tmdbId") == tmdb_id for m in request("GET", "movie")):
                continue
            found = request("GET", "movie/lookup", params={"term": f"tmdb:{tmdb_id}"})
            movie = next((m for m in found if m.get("tmdbId") == tmdb_id), None)
            if movie is None:
                raise ValueError(f"Radarr could not resolve tmdb:{tmdb_id}")
            if any(i["type"] == "movie" and i["title"].casefold() == movie["title"].casefold()
                   and str(i.get("year", "")) == str(movie.get("year", "")) for i in items):
                print(f"SKIP tmdb:{tmdb_id}: title/year already in Plex", flush=True)
                continue
            added = request("POST", "movie", json={"tmdbId": tmdb_id, "title": movie["title"], "qualityProfileId": profile,
                            "rootFolderPath": root_folder, "monitored": True, "minimumAvailability": "released", "tags": [tag],
                            "addOptions": {"searchForMovie": option(settings, "search")}})
            state["movies"][str(tmdb_id)] = {"id": added["id"], "path": added.get("path"), "owners": [identity(e) for e in definitions
                if e.get("enabled", True) and e.get("acquire") and collection_active(e.get("schedule"), today) and {"tmdb_id": tmdb_id} in e.get("members", [])]}
            save()
    for key, record in list(state["movies"].items()):
        tmdb_id = int(key)
        if tmdb_id in active_ids:
            # All acquisition collections sharing this movie must agree before eventual deletion.
            shared = [identity(e) for e in definitions if e.get("acquire") and {"tmdb_id": tmdb_id} in e.get("members", [])]
            if apply and set(shared) - set(record["owners"]):
                record["owners"] = sorted(set(record["owners"]) | set(shared))
                save()
            continue
        responsible = [owners.get(owner) for owner in record["owners"]]
        if not responsible or any(e is None or not e.get("enabled", True) or e.get("cleanup", "keep") != "remove-delete" or collection_active(e.get("schedule"), today) for e in responsible):
            continue
        movie = existing.get(tmdb_id)
        if movie is None or tag is None or tag not in movie.get("tags", []) or movie["id"] != record["id"] or not record.get("path") or movie.get("path") != record["path"]:
            continue
        print(f"{' ' if apply else 'PLAN '}RADARR REMOVE + DELETE FILES {movie['title']} (tmdb:{tmdb_id}; added by Overlayrr)", flush=True)
        if apply:
            fresh = request("GET", f"movie/{record['id']}")
            if fresh.get("tmdbId") != tmdb_id or tag not in fresh.get("tags", []) or fresh.get("path") != record["path"]:
                raise ValueError("Radarr ownership changed; cleanup refused")
            request("DELETE", f"movie/{record['id']}", params={"deleteFiles": "true", "addImportExclusion": "false"})
            del state["movies"][key]
            save()


def custom_collections(artwork, apply=False, today=None, added_item=None, kept=None, earlier=()):
    """The custom and seasonal collections. tk.box's list is what Plex holds: one turned off comes out of Plex (found by
    name), and so does one removed from the list (by the Plex ID an earlier run recorded in `earlier`). With `kept` (a
    list), each one that is on is added to it as {"name", "library", "kind": "custom", "items", "rating_key"}; a removed
    one that couldn't be deleted stays in it, to be tried again. A newly added title (`added_item`) only ever adds."""
    definitions = json.loads(json.dumps(validate_collections(artwork.config)))
    kept = [] if kept is None else kept
    if added_item is not None:
        definitions = [entry for entry in definitions if entry.get("enabled", True)
                       and entry["library"] == added_item.get("library") and entry["type"] == added_item["type"]
                       and collection_active(entry.get("schedule"), today)]
    sources = CollectionSources(artwork)
    # Resolve every enabled feed before any mutations, including seasonal deletion.
    for entry in definitions:
        source = entry.get("source")
        if entry.get("enabled", True) and source and source.get("refresh", option({}, "collection_source_refresh")):
            result = sources.fetch(source["url"], entry["type"], source.get("limit"))
            entry["members"] = [row["member"] for row in result["items"]]
    # Titles the admin removed stay out, whether they were picked or came from a list.
    for entry in definitions:
        entry["members"] = [member for member in entry.get("members", []) if member not in entry.get("exclude", [])]
    enabled = [entry for entry in definitions if entry.get("enabled", True)]
    # Until tk.box saves its collections the engine's seasonal presets stand in, all off; only saved ones come out of Plex.
    off = [entry for entry in definitions if not entry.get("enabled", True)] if "collections" in artwork.config and added_item is None else []
    named = {(entry["library"], collection_key(entry["name"])) for entry in definitions}
    gone = [row for row in earlier if row.get("kind") == "custom" and row.get("rating_key")
            and (row["library"], collection_key(row["name"])) not in named] if added_item is None else []
    if not enabled and (added_item is not None or not off and not gone):
        print("No enabled custom collections. Nothing was changed.", flush=True)
        return 0
    plex = artwork.plex
    kinds = sorted({"show" if entry["type"] == "tv" else "movie" for entry in enabled})
    libraries = {kind: dict((title, key) for key, title in plex.sections(kind)) for kind in kinds}
    sections = {title: key for values in libraries.values() for title, key in values.items()}
    for entry in enabled:
        if entry["library"] not in libraries["show" if entry["type"] == "tv" else "movie"]:
            raise ValueError(f"Collection library {entry['library']!r} must name a configured library of its type")
    items = plex.scan() if enabled else []
    radarr_failed = 0
    if added_item is None and enabled:
        try:
            seasonal_radarr(artwork, definitions, items, apply, today)
        except (RuntimeError, ValueError, OSError) as error:
            radarr_failed = 1
            print(f"ERROR Radarr: {error}. Plex collection syncing will continue", file=sys.stderr, flush=True)
    builder = CollectionBuilder(plex, apply, ("movie", "show"))
    for entry in off:
        current = builder.existing.get((entry["library"], collection_key(entry["name"])))
        if current is not None and not current.get("smart"):
            builder.remove(current["rating_key"], current["title"], entry["library"], "turned off in tk.box")
    for row in gone:
        if not builder.remove(row["rating_key"], row["name"], row["library"], "removed from tk.box's collections"):
            kept.append(row)
    for entry in enabled:
        name, library = entry["name"], entry["library"]
        active = collection_active(entry.get("schedule"), today)
        current = builder.existing.get((library, collection_key(name)))
        keys = []
        try:
            candidates = [item for item in items if item["library"] == library and item["type"] == entry["type"]]
            keys, missing = collection_members(entry, candidates)
            dropped = collection_members({"members": entry.get("exclude", [])}, candidates)[0]
            keys = [key for key in keys if key not in dropped]
            if active:
                if added_item is not None:
                    keys = [key for key in keys if key == added_item.get("rating_key")]
                    if not keys:
                        continue
                print(f"{'PLAN ' if not apply else ''}MATCH {name} [{library}]: {len(keys)} existing Plex {'shows' if entry['type'] == 'tv' else 'movies'}; enabled", flush=True)
                if missing:
                    print(f"WARN {name} [{library}]: {len(missing)} missing or ambiguous members; no members removed", flush=True)
                if not keys:
                    print(f"SKIP {name} [{library}]: no matching titles; membership left alone", flush=True)
                else:
                    builder.groups({(library, "custom"): {"name": name, "type": 2 if entry["type"] == "tv" else 1, "keys": keys, "drop": dropped}},
                                   {item["rating_key"]: item["title"] for item in candidates}, sections, 1, added_item is None and entry.get("sync", "append") == "sync" and not missing)
                    if current is None and apply:
                        current = next((c for c in plex.collections("show" if entry["type"] == "tv" else "movie")
                                        if c["library"] == library and collection_key(c["title"]) == collection_key(name)), None)
            else:
                print(f"{builder.prefix}SEASON {name} [{library}]: outside {entry['schedule']}; keep collection", flush=True)
            if added_item is None and entry.get("visibility"):
                show_in(plex, apply, builder.prefix, sections[library], name, library, current and current["rating_key"], entry["visibility"], active)
        except (RuntimeError, ValueError, ET.ParseError) as error:
            builder.failed(name, library, error)
        if added_item is None:
            kept.append({"name": name, "library": library, "kind": "custom", "items": len(keys), **({"rating_key": current["rating_key"]} if current else {})})
    builder.summary()
    return builder.failures + radarr_failed


def wanted_collections(artwork, streaming, region, franchises=True):
    """What the franchise (with `franchises`) and streaming collections should hold, from TMDb: ({(library, label):
    {"name", "type", "keys"}}, {rating key: title}, number of failed lookups)."""
    groups, titles, failed = {}, {}, []

    def add(library, label, name, plex_type, item):
        titles[item["rating_key"]] = item["title"]
        keys = groups.setdefault((library, label), {"name": name, "type": plex_type, "keys": []})["keys"]
        if item["rating_key"] not in keys:
            keys.append(item["rating_key"])

    def lookup(function, entries, empty):
        def safe(entry):
            try:
                return function(entry)
            except (RuntimeError, ValueError):
                failed.append(entry)
                return empty
        with ThreadPoolExecutor(max_workers=6) as pool:
            return list(pool.map(safe, entries))

    def show_services(show):
        if not show.get("tmdb_id"):
            artwork.identify(show)
        if not show.get("tmdb_id"):
            return []
        return streaming_services(artwork.tmdb(f"/tv/{show['tmdb_id']}", append_to_response="watch/providers"), streaming, region)

    movies = [movie for movie in artwork.plex.scan(media_type="movie") if movie.get("tmdb_id")] if franchises else []
    ids = sorted({movie["tmdb_id"] for movie in movies})
    franchises = dict(zip(ids, lookup(lambda movie_id: artwork.tmdb(f"/movie/{movie_id}").get("belongs_to_collection") or {}, ids, {})))
    for movie in movies:
        franchise = franchises[movie["tmdb_id"]]
        if franchise.get("id"):
            add(movie["library"], franchise["id"], re.sub(r"\s+Collection$", "", franchise.get("name") or "").strip() or str(franchise["id"]), 1, movie)
    if streaming != "off":
        shows = artwork.plex.scan(media_type="show")
        for show, services in zip(shows, lookup(show_services, shows, [])):
            for service in services:
                add(show["library"], "stream:" + service, f"{service} Shows", 2, show)
    return groups, titles, len(failed)


class CollectionBuilder:
    """Brings Plex's collections in line with what's wanted (or, without `apply`, prints the plan), counting what it
    does; the collections already in Plex are read once up front."""

    def __init__(self, plex, apply, kinds):
        self.plex, self.apply, self.prefix = plex, apply, "" if apply else "PLAN "
        self.counts, self.failures = dict.fromkeys(("create", "update", "same", "smart", "delete"), 0), 0
        self.existing, self.by_key, self.kept, self.wanted = {}, {}, [], set()
        for kind in kinds:
            for collection in plex.collections(kind):
                self.existing.setdefault((collection["library"], collection_key(collection["title"])), collection)
                self.by_key[collection["rating_key"]] = collection
        self.server = self.root = ""
        if apply:
            self.server = f"server://{plex.xml('/').get('machineIdentifier')}/com.plexapp.plugins.library"
            self.root = self.server + "/library/metadata/"

    def failed(self, name, library, error):
        self.failures += 1
        print(f"ERROR collection {name} [{library}]: {error}", file=sys.stderr, flush=True)

    def remove(self, rating_key, name, library, why, listed=False):
        """Deletes one collection from Plex (never its titles). False only if Plex refused; one already gone is fine.
        `listed`: Plex just listed it, so it's there even if the collections read up front didn't include it."""
        if rating_key not in self.by_key and not listed:
            return True
        self.counts["delete"] += 1
        print(f"{self.prefix}DELETE {name} [{library}]: {why}", flush=True)
        try:
            if self.apply:
                self.plex.send("DELETE", f"/library/collections/{rating_key}")
            return True
        except (RuntimeError, ET.ParseError) as error:
            self.failed(name, library, error)
            return False

    def groups(self, groups, titles, sections, minimum, sync, settings=None):
        """Franchise and streaming collections: create the missing ones, add to (and with `sync` trim) the rest. One the
        admin turned off (in `settings`, from validate_automatic) comes out of Plex instead, and one with a visibility
        setting has it applied. Every one that qualifies is noted in `wanted`."""
        plex, counts, prefix, listed, settings = self.plex, self.counts, self.prefix, {}, settings or {}
        for (library, label), group in sorted(groups.items(), key=lambda pair: (pair[0][0], pair[1]["name"].casefold())):
            name, setting = group["name"], settings.get((library, collection_key(group["name"])), {})
            # Titles the admin removed come out even when membership only adds.
            drop = set(group.get("drop", ())) | set(setting.get("exclude", ()))
            want = [key for key in group["keys"] if key not in drop]
            if len(want) < minimum:
                continue
            service = str(label).startswith("stream:")  # The streaming services lead the collections list, after the charts
            kept = {"name": name, "library": library, "kind": "streaming" if service else "franchise", "items": len(want)}
            self.wanted.add((library, collection_key(name)))
            try:
                current = self.existing.get((library, collection_key(name)))
                if not setting.get("enabled", True):
                    self.kept.append({**kept, "off": True})
                    if current is not None and not current.get("smart"):
                        self.remove(current["rating_key"], current["title"], library, "turned off in tk.box")
                    continue
                if service and current is not None:  # Kometa's, smart or not, too: only its sort title changes
                    lead_list(plex, self.apply, sections[library], current["rating_key"], current["title"], library, "!002")
                if current is not None and current.get("smart"):
                    counts["smart"] += 1
                    print(f"SKIP {current['title']} [{library}]: a smart collection can't be edited by hand; delete it in Plex to let Overlayrr rebuild it")
                    continue
                if current is None:
                    if library not in listed:
                        listed[library] = collection_titles(plex, sections[library])
                    if collection_key(name) in listed[library]:  # Asked fresh, whatever it holds: never make a second one
                        print(f"SKIP {name} [{library}]: a collection with that name is already in Plex", flush=True)
                        counts["same"] += 1
                        continue
                    print(f"{prefix}CREATE {name} [{library}]: {len(want)} {'shows' if group['type'] == 2 else 'movies'}", flush=True)
                    counts["create"] += 1
                    if self.apply:
                        created = create_collection(plex, {"type": group["type"], "title": name, "smart": 0,
                                                          "sectionId": sections[library], "uri": self.root + ",".join(want)})
                        if created is not None:  # Release-date order, as Kometa's collections had
                            plex.send("PUT", f"/library/metadata/{created.get('ratingKey')}/prefs", {"collectionSort": 0})
                            if service:
                                lead_list(plex, self.apply, sections[library], created.get("ratingKey"), name, library, "!002")
                            self.kept.append({**kept, "rating_key": created.get("ratingKey")})
                    if setting.get("visibility"):
                        show_in(plex, self.apply, prefix, sections[library], name, library, created.get("ratingKey") if self.apply and created is not None else None, setting["visibility"])
                    continue
                kept = {**kept, "name": current["title"], "rating_key": current["rating_key"]}
                have = members_of(plex, current["rating_key"])
                add_keys = [key for key in want if key not in have]
                remove = [key for key in have if key not in want] if sync else [key for key in have if key in drop]
                self.kept.append(kept)
                if setting.get("visibility"):
                    show_in(plex, self.apply, prefix, sections[library], current["title"], library, current["rating_key"], setting["visibility"])
                if not add_keys and not remove:
                    counts["same"] += 1
                    continue
                counts["update"] += 1
                changes = [f"+{titles.get(key, key)}" for key in add_keys] + [f"-{have[key]}" for key in remove]
                print(f"{prefix}UPDATE {current['title']} [{library}]: {'; '.join(changes)}", flush=True)
                if self.apply:
                    if add_keys:
                        plex.send("PUT", f"/library/collections/{current['rating_key']}/items", {"uri": self.root + ",".join(add_keys)})
                    for key in remove:
                        plex.send("DELETE", f"/library/collections/{current['rating_key']}/items/{key}")
            except (RuntimeError, ValueError, ET.ParseError) as error:
                self.failed(name, library, error)

    def charts(self, days):
        """The "Newly Released" and "New Episodes" smart collections: one each, first in the list, with the asked date window."""
        plex, counts, prefix = self.plex, self.counts, self.prefix
        for kind, name, plex_type, field, default_days in CHARTS:
            window = (days or {}).get(kind, default_days)
            for key, library in plex.sections(kind):
                uri = f"{self.server}/library/sections/{key}/all?type={plex_type}&sort=originallyAvailableAt%3Adesc&{field}%3E%3E=-{window}d"
                try:
                    current = self.existing.get((library, collection_key(name)))
                    present = collection_titles(plex, key).get(collection_key(name), [])  # Asked again, fresh: never make a second one
                    # Only one is kept: the oldest smart one. Extra smart copies (made by an earlier run, or by Kometa) are
                    # deleted; a same-named collection that isn't smart is somebody's own and is only mentioned.
                    smart = sorted((entry for entry in present if entry[1]), key=lambda entry: int(entry[0]))
                    for rating_key, _ in smart[1:]:
                        counts["delete"] += 1
                        print(f"{prefix}DELETE {name} [{library}]: extra copy (id {rating_key}); keeping id {smart[0][0]}", flush=True)
                        if self.apply:
                            plex.send("DELETE", f"/library/collections/{rating_key}")
                    if smart:
                        current = self.by_key.get(smart[0][0], current)
                    if len(present) - max(len(smart) - 1, 0) > 1:
                        print(f"NOTE {name} [{library}]: another collection with this name isn't a smart collection, so it's left alone", flush=True)
                    if current is None and present:
                        print(f"SKIP {name} [{library}]: a collection with that name is already in Plex", flush=True)
                        counts["same"] += 1
                        continue
                    if current is not None:
                        lead_list(plex, self.apply, key, current["rating_key"], current["title"], library)
                        # One that exists (Kometa's, or made earlier) is only touched to change its date window; a filter
                        # we can't read or recognize is left exactly as it is.
                        entry = plex.xml(f"/library/metadata/{current['rating_key']}").find("Directory")
                        found = re.search(rf"{re.escape(field)}>>=-(\d+)d", unquote(entry.get("content") or "")) if entry is not None else None
                        if not found or int(found[1]) == window:
                            counts["same"] += 1
                            continue
                        counts["update"] += 1
                        print(f"{prefix}UPDATE {current['title']} [{library}]: last {found[1]} days -> last {window} days", flush=True)
                        if self.apply:
                            plex.send("PUT", f"/library/collections/{current['rating_key']}/items", {"uri": uri})
                        continue
                    print(f"{prefix}CREATE {name} [{library}]: smart collection of {'movies released' if kind == 'movie' else 'episodes aired'} "
                          f"in the last {window} days", flush=True)
                    counts["create"] += 1
                    if self.apply:
                        created = create_collection(plex, {"type": plex_type, "title": name, "smart": 1, "sectionId": key, "uri": uri})
                        if created is not None:
                            lead_list(plex, self.apply, key, created.get("ratingKey"), name, library)
                except (RuntimeError, ET.ParseError) as error:
                    self.failed(name, library, error)

    def drop_charts(self):
        """With them turned off, the "Newly Released" and "New Episodes" smart collections come out of Plex; a same-named
        collection that isn't smart is somebody's own and stays."""
        for kind, name, *_ in CHARTS:
            for key, library in self.plex.sections(kind):
                try:
                    for rating_key, smart in collection_titles(self.plex, key).get(collection_key(name), []):
                        if smart:
                            self.remove(rating_key, name, library, "Newly Released and New Episodes are turned off in tk.box", listed=True)
                except (RuntimeError, ET.ParseError) as error:
                    self.failed(name, library, error)

    def summary(self):
        counts = self.counts
        print(f"{self.prefix}Collections: {counts['create']} to create, {counts['update']} to update, {counts['same']} unchanged"
              + (f", {counts['delete']} extra to delete" if counts["delete"] else "")
              + (f", {counts['smart']} smart collections skipped" if counts["smart"] else "") + "."
              + ("" if self.apply else " Nothing was changed."))


def build_collections(artwork, apply, minimum=2, sync=True, franchises=True, streaming="off", region="US", recent=False, days=None, kept=None, earlier=()):
    """Collections like Kometa's franchise and streaming defaults, with no Kometa:
    - with `franchises`, one per TMDb movie collection that has at least `minimum` of your movies in a library;
    - with `streaming` ("originals": the show's original network; "available": where it streams in `region`),
      one "<Service> Shows" per streaming service with at least `minimum` of your shows;
    - with `recent`, the "Newly Released" (movies) and "New Episodes" (TV) smart collections, created if missing and
      their date window (`days`: {"movie": 90, "show": 7} by default) brought in line if it differs; without it, the
      smart ones with those names are deleted.
    Existing Plex collections with the same name are adopted and brought in line (added to, and with `sync` trimmed);
    smart collections can't be edited by hand, so they are skipped. tk.box's settings are what Plex holds: one the admin
    turned off is deleted, and so is one an earlier run kept (in `earlier`, as recorded) that no longer qualifies or
    whose kind is off, but only when every TMDb lookup worked. Extra copies of "Newly Released" or "New Episodes" (smart
    ones, keeping the oldest) are deleted too, so there is only ever one. Without `apply` it only prints a plan. Every
    franchise and streaming collection that qualifies is added to `kept` (a list) as {"name", "library", "kind",
    "items", "rating_key"} ("off": true, without a Plex ID, for one turned off), then the custom ones. Returns the
    number of collections that failed."""
    if (franchises or streaming != "off") and not artwork.keys.get("tmdb_key"):
        raise ValueError("Franchise and streaming collections need a TMDb API key")
    kinds = ("movie", "show")
    sections = {title: key for kind in kinds for key, title in artwork.plex.sections(kind)}
    groups, titles, failed = wanted_collections(artwork, streaming, region, franchises)
    if failed:  # A partial picture must never remove anything.
        sync = False
        print(f"WARN {failed} TMDb lookups failed; collections are only added to this run, never trimmed or deleted", file=sys.stderr)
    kept = [] if kept is None else kept
    builder = CollectionBuilder(artwork.plex, apply, kinds)
    builder.groups(groups, titles, sections, minimum, sync, validate_automatic(artwork.config))
    kept.extend(builder.kept)
    for row in earlier:
        if row.get("kind") not in ("franchise", "streaming") or (row["library"], collection_key(row["name"])) in builder.wanted:
            continue
        if failed or not row.get("rating_key"):
            if failed:
                kept.append(row)
            continue
        if not builder.remove(row["rating_key"], row["name"], row["library"], f"no longer one of the {row['kind']} collections"):
            kept.append(row)
    if recent:
        builder.charts(days)
    else:
        builder.drop_charts()
    builder.summary()
    return builder.failures + custom_collections(artwork, apply, kept=kept, earlier=earlier)


def read_collections_config(path):
    """The shared config checks, plus this engine's own: the collection settings and definitions."""
    config = read_config(path)
    plex = config.get("plex", {})
    for name in ("recent_movie_days", "recent_episode_days"):
        value = option(plex, name)
        if type(value) is not int or not 1 <= value <= 3650:
            raise ValueError(f"plex.{name} must be a whole number of days from 1 to 3650")
    minimum = option(plex, "collection_min_items")
    if type(minimum) is not int or minimum < 1:
        raise ValueError("plex.collection_min_items must be an integer, 1 or more")
    if option(plex, "collection_sync") not in ("sync", "append"):
        raise ValueError("plex.collection_sync must be sync or append")
    if option(plex, "collection_streaming") not in ("off", "originals", "available"):
        raise ValueError("plex.collection_streaming must be off, originals or available")
    validate_collections(config)
    validate_automatic(config)
    return config


def engine(config_path, config):
    base = config_path.resolve().parent
    return Metadata(HTTP(local_path(option(config, "cache_dir"), base)), config, base)


def collection_options(config):
    plex = config.get("plex", {})
    return {"minimum": option(plex, "collection_min_items"), "sync": option(plex, "collection_sync") == "sync",
            "franchises": option(plex, "franchise_collections"),
            "streaming": plex.get("collection_streaming") or "off", "region": option(plex, "collection_region"),
            "recent": plex.get("recent_collections", False),
            "days": {"movie": option(plex, "recent_movie_days"), "show": option(plex, "recent_episode_days")}}


def sync_collections(config_path, mode="plan", custom=False, today=None):
    """all/custom: show (plan) or make (apply) the collections; apply needs plex.upload: true."""
    config = read_collections_config(config_path)
    if mode == "apply" and not config.get("plex", {}).get("upload"):
        raise ValueError("Applying collections changes Plex, so plex.upload must be true")
    artwork = engine(config_path, config)
    earlier, kept = read_kept(config_path), []
    if custom:
        failed = custom_collections(artwork, mode == "apply", today, kept=kept, earlier=earlier)
        kept += [row for row in earlier if row.get("kind") != "custom"]
    else:
        failed = build_collections(artwork, mode == "apply", kept=kept, earlier=earlier, **collection_options(config))
    if mode == "apply":
        record_kept(config_path, kept)
    return 1 if failed else 0


KEPT_FILE = "kept_collections.json"


def read_kept(config_path):
    """The collections the last applying run kept (see record_kept); none if it hasn't run or the file is unreadable."""
    with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
        rows = json.loads((config_path.resolve().parent / KEPT_FILE).read_text(encoding="utf-8"))["collections"]
        return [row for row in rows if isinstance(row, dict) and isinstance(row.get("name"), str) and isinstance(row.get("library"), str)]
    return []


def record_kept(config_path, kept):
    """What an applying run kept, written next to the config: for tk.box's Collections page, and so the next run knows
    which Plex collections are tk.box's to delete once they're removed or no longer qualify."""
    rows = sorted(kept, key=lambda entry: (entry["kind"], entry["library"], entry["name"].casefold()))
    atomic_write(config_path.resolve().parent / KEPT_FILE, json.dumps({"updated": date.today().isoformat(), "collections": rows}).encode())


def added(config_path, rating_key):
    """A newly added title (a movie's, show's, season's or episode's key) joins the custom collections it matches, and
    only those: nothing is removed and no other collection changes. Applies when plex.upload is on, else prints the plan."""
    config = read_collections_config(config_path)
    artwork = engine(config_path, config)
    artwork.plex.require("Adding a title to collections")
    rating_key, _, _ = artwork.plex.added_target(rating_key)  # A season's or episode's own key works too
    item = select_item(artwork, config, rating_key=rating_key)[0]
    if not item.get("rating_key"):
        return 0
    return 1 if custom_collections(artwork, bool(config["plex"].get("upload")), added_item=item) else 0


def discover(config_path, data):
    """The Collections page's Discover: recommendations, a provider's lists, universes, or a preview of one list."""
    sources = CollectionSources(engine(config_path, read_collections_config(config_path)))
    mode = data.get("mode", "recommendations")
    try:
        if mode == "preview":
            universe = data.get("universe")
            preset = next((row for row in COLLECTION_UNIVERSES if row[0] == universe), None) if universe else None
            if universe and (preset is None or data.get("type", "movie") not in preset[3]):
                raise ValueError("Unknown universe or unsupported media type")
            result = sources.fetch(preset[2] if preset else data.get("url"), data.get("type", "movie"), data.get("limit"))
            if preset:
                result["name"] = preset[1]
            return result
        provider, query = data.get("provider", "all"), str(data.get("query") or "")[:200]
        if mode == "universes":
            return {"results": sources.universes(query, data.get("type", "movie"))}
        rows = sources.discover(provider, query) if mode == "browse" else sources.recommendations(provider, query)
        return {"results": rows}
    except RuntimeError:
        raise ValueError("Provider request failed; check API credentials, rate limits and provider availability") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("config", type=Path, help="The JSON config tk.box writes for the run")
    commands = parser.add_subparsers(dest="command", required=True)
    plan = {"nargs": "?", "default": "plan", "choices": ("plan", "apply"), "help": "plan (default, changes nothing) or apply (needs plex.upload: true)"}
    commands.add_parser("all", help="Franchise, streaming and chart collections from TMDb, then the custom and seasonal ones").add_argument("mode", **plan)
    custom = commands.add_parser("custom", help="Custom and seasonal collections only")
    custom.add_argument("mode", **plan)
    custom.add_argument("--date", type=date.fromisoformat, help="With plan: as if today were YYYY-MM-DD")
    commands.add_parser("added", help="Add a newly added title (its Plex rating key) to the custom collections it matches").add_argument("rating_key", type=int)
    commands.add_parser("discover", help="Answer one Discover request: JSON on stdin, JSON on stdout")
    commands.add_parser("defaults", help="Print the seasonal presets used until collections are first saved")
    commands.add_parser("check", help="Only validate the config, then exit (tk.box runs this before saving)")
    args = parser.parse_args()
    if getattr(args, "date", None) and args.mode != "plan":
        parser.error("--date is only for plan")
    if hasattr(os, "nice"):
        with contextlib.suppress(OSError):
            os.nice(10)  # Plex, its transcoder and anyone else on the machine come first
    try:
        if args.command == "check":
            read_collections_config(args.config)
            print("Config OK")
            return 0
        if args.command == "defaults":
            print(json.dumps({"collections": DEFAULTS["collections"]}))
            return 0
        if args.command == "discover":
            print(json.dumps(discover(args.config, json.load(sys.stdin)), default=str))
            return 0
        with run_lock(args.config) if args.command == "added" or args.mode == "apply" else contextlib.nullcontext():
            if args.command == "added":
                return added(args.config, args.rating_key)
            return sync_collections(args.config, args.mode, args.command == "custom", getattr(args, "date", None))
    except (OSError, ValueError, TypeError, RuntimeError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
