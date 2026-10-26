#!/usr/bin/env python3
"""tk.box's collections engine: the Plex collections tk.box keeps, apart from the artwork engine (artwork_engine.py).

- Franchise collections from TMDb, "<Service> Shows" streaming collections and the "Newly Released" / "New Episodes"
  smart collections, made and kept in line with your libraries. Each franchise or streaming one can be turned off.
- tk.box's collections are what Plex holds: one turned off or removed in tk.box is deleted from Plex (its titles stay).
- Custom and seasonal collections defined in tk.box (by hand, from a curated universe or a public list), with Radarr
  fetching a seasonal collection's missing movies and, when asked, removing them again once its season ends.
- Discover: the public lists and universes the Collections page offers, the TMDb collections a library has only part
  of, and a preview of what one would hold. Partly owned and Universes read the Discover index, which the full run
  builds and newly added movies join (`index build`, `index added`), so they open without asking TMDb or the lists.

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
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse
import xml.etree.ElementTree as ET

from engine_common import (CHARTS, DEFAULTS, HTTP, Metadata, atomic_write, collection_key, local_path, option, read_config,
                           READ_ONLY, run_lock, secret, select_item, streaming_services, web_download)


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
    "letterboxd": ("Letterboxd", "letterboxd.com"),
    "mdblist": ("MDBList", "mdblist.com"), "flixpatrol": ("FlixPatrol", "flixpatrol.com"), "plex": ("Plex", "watch.plex.tv")}
COLLECTION_RECOMMENDATIONS = (
    ("TMDb Trending Movies", "https://www.themoviedb.org/trending/movie/week", "This week's trending movies", "movie"),
    ("TMDb Trending TV", "https://www.themoviedb.org/trending/tv/week", "This week's trending shows", "tv"),
    ("TMDb Top Rated Movies", "https://www.themoviedb.org/movie/top-rated", "Highly rated movies", "movie"),
    ("IMDb Top 250", "https://www.imdb.com/chart/top/", "Classic and contemporary audience favorites", "movie"),
    ("IMDb Popular Movies", "https://www.imdb.com/chart/moviemeter/", "Movies attracting attention on IMDb", "movie"),
    ("IMDb Top Rated TV", "https://www.imdb.com/chart/toptv/", "Highly rated television", "tv"),
    ("Letterboxd Top 250", "https://letterboxd.com/xobl/list/official-top-250-narrative-feature-films/", "Community-rated narrative features", "movie"),
    ("Netflix Top 10", "https://flixpatrol.com/top10/netflix/world/", "Netflix's worldwide movie and TV charts", "movie"),
    ("Disney+ Top 10", "https://flixpatrol.com/top10/disney/world/", "Disney+ worldwide movie and TV charts", "movie"),
    ("Prime Video Top 10", "https://flixpatrol.com/top10/amazon-prime/world/", "Prime Video worldwide charts", "movie"),
    ("Released This Week in History", "https://watch.plex.tv/discover/list/historical-week", "Plex's movies released this week in years past; it changes every week", "movie"))


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
    if provider == "plex":
        path = re.sub(r"^/me(?=/)", "", path)  # watch.plex.tv/me/discover/... is the signed-in view of the same list
    patterns = {
        "tmdb": r"/(?:collection/\d+(?:-[\w-]+)?|list/\d+(?:-[\w-]+)?|trending/(?:movie|tv)/(?:day|week)|(?:movie|tv)/(?:popular|top-rated))",
        "imdb": r"/(?:list/ls\d+|chart/(?:top|toptv|moviemeter|tvmeter))",
        "letterboxd": r"/[\w-]+/list/[\w-]+",
        "mdblist": r"/lists/(?:\d+|[\w-]+/[\w-]+|[\w-]+/external/\d+)",
        "flixpatrol": r"/top10/[\w-]+/[\w-]+(?:/\d{4}-\d{2}-\d{2})?",
        "plex": r"/discover/list/[\w-]+"}
    if provider is None or not re.fullmatch(patterns[provider], path):
        raise ValueError("Unsupported list URL. Use a TMDb list/collection/chart, IMDb list/chart, Letterboxd list, MDBList list, FlixPatrol Top 10 or Plex Discover list URL")
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

    def plex_discover(self, path, **params):
        """Plex's Discover catalog (its online lists), read with tk.box's Plex token and never cached, so a list that
        changes every week is read as it is now. Redirects are followed only on Discover's own host."""
        plex = self.artwork.plex
        plex.require("Reading Plex Discover lists")
        headers = {**plex.headers, "Accept": "application/json", "X-Plex-Product": "tk.box", "X-Plex-Client-Identifier": "tk.box-collections"}
        url = "https://discover.provider.plex.tv" + path
        for _ in range(4):
            try:
                with self.http.request("GET", url, params=params, headers=headers, allow_redirects=False) as response:
                    if not response.is_redirect:
                        return (response.json() or {}).get("MediaContainer") or {}
                    target = urljoin(url, response.headers.get("location", ""))
            except RuntimeError as error:
                if str(error).endswith(("HTTP 401", "HTTP 403")):
                    raise ValueError("Plex Discover refused tk.box's Plex token, so its lists can't be read") from None
                raise
            if urlparse(target).hostname != "discover.provider.plex.tv":
                raise ValueError("Plex Discover redirected elsewhere; the list was not read")
            url, params = target, {}
        raise ValueError("Plex Discover redirected too many times")

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

    def universes(self, query="", kind="movie", index=None):
        """The universes of one media type, those you have most of first, counted from each one's list as the Discover
        index last read it (see build_index); one not read yet is still offered, without a count, last."""
        if kind not in ("movie", "tv"):
            raise ValueError("Choose movies or TV for universe collections")
        rows = [{"key": key, "name": name, "url": collection_source(url)[1], "type": kind, "provider": collection_source(url)[0],
                 "description": "Curated universe membership from " + COLLECTION_PROVIDERS[collection_source(url)[0]][0]}
                for key, name, url, kinds in COLLECTION_UNIVERSES if kind in kinds and query.casefold() in name.casefold()]
        lists = (index or {}).get("universes", {})
        if not any(f"{row['key']}:{kind}" in lists for row in rows):
            return rows
        items = self.artwork.plex.scan(media_type="movie" if kind == "movie" else "show")
        def count(row):
            members = lists.get(f"{row['key']}:{kind}", {}).get("members")
            if members is None:
                return row
            owned = owned_members(members, items)
            return {**row, "owned": owned, "total": len(members), "description": f"You have {owned} of {len(members)}. " + row["description"]}
        return sorted(map(count, rows), key=lambda row: ("owned" not in row, -row.get("owned", 0), row["name"].casefold()))

    def discover(self, provider, query=""):
        rows = []
        if provider == "tmdb":
            if not query.strip():
                return self.recommendations(provider)
            for row in self.api("tmdb", "/search/collection", query=query, page=1).get("results", [])[:20]:
                rows.append({"name": row["name"], "url": f"https://www.themoviedb.org/collection/{row['id']}/", "description": row.get("overview", ""), "type": "movie", "provider": provider})
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
        elif provider in ("imdb", "flixpatrol", "plex"):
            rows = self.recommendations(provider, query)
        else:
            raise ValueError("Choose a provider to browse")
        return rows

    def details(self, kind, tmdb_id):
        """What filters and sorts read about one title: its year, TMDb rating, genres, original language and
        certification (in the collections region), from TMDb's details (cached)."""
        region = option(self.config.get("plex", {}), "collection_region")
        if kind == "movie":
            found = self.api("tmdb", f"/movie/{tmdb_id}", append_to_response="release_dates")
            dated = found.get("release_date")
            ratings = [c.get("certification") for r in (found.get("release_dates") or {}).get("results", []) if r.get("iso_3166_1") == region
                       for c in r.get("release_dates", [])]
        else:
            found = self.api("tmdb", f"/tv/{tmdb_id}", append_to_response="content_ratings")
            dated = found.get("first_air_date")
            ratings = [r.get("rating") for r in (found.get("content_ratings") or {}).get("results", []) if r.get("iso_3166_1") == region]
        year = str(dated or "")[:4]
        return {"year": int(year) if year.isdigit() else None, "rating": found.get("vote_average") or None, "language": found.get("original_language") or None,
                "genres": [g["name"] for g in found.get("genres", []) if g.get("name")], "certification": next((r for r in ratings if r), None)}

    def fetch(self, url, kind="movie", limit=None, resolve=True, choose=None, exclude=(), candidates=False):
        """A list's titles. With `choose` ({"filter", "sort"}, as a collection's source holds them) or titles to
        `exclude`, the whole list is read, the excluded titles taken out, the rest filtered and sorted, and only then
        cut to `limit`; what was left out comes back in "left_out" with why. With `candidates`, every title of the
        whole list also comes back, with its TMDb details (None without a TMDb key), for the editor to choose from."""
        provider, url = collection_source(url)
        limit = option({}, "collection_source_limit") if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= 250 or kind not in ("movie", "tv"):
            raise ValueError("Choose movies or TV and a source limit from 1 to 250")
        choose, exclude = source_choice(choose or {}), list(exclude or [])
        wanted = limit
        if choose and not self.artwork.keys.get("tmdb_key") and not candidates:
            raise ValueError("Filtering or sorting a list needs a TMDb API key")
        if choose or exclude or candidates:
            limit, resolve = 250, True
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
        elif provider == "plex":
            # The list is one of Discover's home shelves; its slug is in the shelf's key or identifier.
            slug = path.split("/")[-1]
            hubs = self.plex_discover("/hubs/sections/home", includeMeta=1).get("Hub") or []
            hub = next((h for h in hubs if re.search(rf"(?<![\w-]){re.escape(slug)}(?![\w-])", " ".join(str(h.get(k) or "") for k in ("key", "hubKey", "hubIdentifier", "context")))
                        or (h.get("title") or "").casefold() == name.casefold()), None)
            if hub is None or not str(hub.get("key") or hub.get("hubKey") or "").startswith("/"):
                offered = ", ".join(h["title"] for h in hubs if h.get("title")) or "none"
                raise ValueError(f"Plex Discover doesn't offer the {slug} list to this account. It offers: {offered}")
            name = hub.get("title") or name
            found = self.plex_discover(hub.get("key") or hub["hubKey"], limit=min(limit * 2, 250), includeGuids=1, includeMeta=1, excludeElements="Media,Image")
            entries = found.get("Metadata") or ((found.get("Hub") or [{}])[0].get("Metadata")) or []
            entries = [m for m in entries if m.get("type") == ("show" if kind == "tv" else "movie")]
            # Discover's shelves often leave out the external IDs; one read per 20 titles fills them in.
            guids = {}
            missing = [m["ratingKey"] for m in entries if m.get("ratingKey") and not m.get("Guid") and re.fullmatch(r"[\w-]{1,64}", m["ratingKey"])]
            for start in range(0, len(missing), 20):
                chunk = missing[start:start + 20]
                for m in self.plex_discover("/library/metadata/" + ",".join(chunk), includeGuids=1, excludeElements="Media,Image").get("Metadata") or []:
                    guids[m.get("ratingKey")] = m.get("Guid") or []
            for m in entries:
                ids = {}
                for guid in m.get("Guid") or guids.get(m.get("ratingKey")) or []:
                    found_id = re.fullmatch(r"(tmdb|imdb)://(\w+)", str(guid.get("id") or ""))
                    if found_id and found_id[1] not in ids and (found_id[1] == "imdb" or found_id[2].isdigit()):
                        ids[found_id[1]] = found_id[2]
                add({"title": m.get("title"), "year": str(m.get("year") or ""), "ids": ids}, "tv" if m["type"] == "show" else "movie")
                if len(rows) >= limit:
                    break
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
        # Counting what you have needs no TMDb IDs (Plex knows IMDb IDs, titles and years); only adding a list does.
        if resolve and self.artwork.keys.get("tmdb_key"):
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
        left_out, everything = [], None
        if choose or exclude or candidates:
            found = [None] * len(rows)
            if (choose or candidates) and self.artwork.keys.get("tmdb_key"):
                ids = [row["member"].get("tmdb_id") for row in rows]
                with ThreadPoolExecutor(max_workers=8) as pool:
                    found = list(pool.map(lambda tmdb_id: self.details(kind, tmdb_id) if tmdb_id else None, ids))
            everything = [{**row, "details": details} for row, details in zip(rows, found)]
            rows, left_out = choose_titles(everything, choose, wanted, exclude=exclude)
        return {"provider": provider, "url": url, "name": name, "type": kind, "limit": wanted, "items": rows, "left_out": left_out,
                **({"candidates": everything, "details": bool(self.artwork.keys.get("tmdb_key"))} if candidates else {})}


LIST_SORTS = ("list", "rating", "oldest", "newest", "anniversary", "random")
# Genres and certifications name what's left out, so one a list gains later is in; languages name what's kept, so
# "only English" stays only English.
LIST_FILTERS = {"year_from", "year_to", "min_rating", "max_rating", "languages", "exclude_genres", "exclude_certifications"}


def source_choice(source):
    """A source's filter and sort, checked: {} when it keeps the list as it is (no filter, list order)."""
    found, sort = source.get("filter") or {}, source.get("sort", "list")
    if not isinstance(found, dict) or set(found) - LIST_FILTERS:
        raise ValueError("A list filter supports " + ", ".join(sorted(LIST_FILTERS)))
    if sort not in LIST_SORTS:
        raise ValueError("A list sort is one of " + ", ".join(LIST_SORTS))
    for key in ("year_from", "year_to"):
        if key in found and (type(found[key]) is not int or not 0 <= found[key] <= 9999):
            raise ValueError(f"Filter {key} must be a year")
    for key in ("min_rating", "max_rating"):
        if key in found and (type(found[key]) not in (int, float) or not 0 <= found[key] <= 10):
            raise ValueError(f"Filter {key} must be from 0 to 10")
    for key in ("languages", "exclude_genres", "exclude_certifications"):
        if key in found and (not isinstance(found[key], list) or any(not isinstance(v, str) or not v.strip() for v in found[key])):
            raise ValueError(f"Filter {key} must be a list of names")
    if found.get("year_from", 0) > found.get("year_to", 9999):
        raise ValueError("Filter year_from must not exceed year_to")
    if found.get("min_rating", 0) > found.get("max_rating", 10):
        raise ValueError("Filter min_rating must not exceed max_rating")
    found = {key: value for key, value in found.items() if value != []}
    return {**({"filter": found} if found else {}), **({"sort": sort} if sort != "list" else {})}


def round_anniversary(age):
    return age > 0 and (age % 10 == 0 or age % 25 == 0)


def week_hash(week, member):
    """FNV-1a of the week and a member, the order "random" sorts by. The editor sorts by the same (list-choice.ts)."""
    value = 0x811C9DC5
    for byte in (week + "|" + "&".join(f"{key}={member[key]}" for key in sorted(member))).encode():
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value


def choose_titles(rows, choose, limit, today=None, exclude=()):
    """The rows a filtered, sorted list keeps (at most `limit`; each row carries its TMDb "details", which come off),
    and the rest as {"title", "year", "why"}. Titles in `exclude` are taken out first, so they don't use up the limit.
    Sorting is stable, so ties keep the list's order; "random" is the same all week, so a nightly run doesn't swap
    titles. The collection editor chooses the same way as you change these (list-choice.ts)."""
    today = today or date.today()
    found, sort, kept, left = choose.get("filter", {}), choose.get("sort", "list"), [], []
    fold = lambda names: {name.strip().casefold() for name in names}
    for row in rows:
        if row["member"] in exclude:
            continue
        d, why = row.get("details"), None
        if d is None:
            why = "no TMDb details" if found else None
        elif ("year_from" in found or "year_to" in found) and not d["year"]:
            why = "no release year"
        elif d["year"] and d["year"] < found.get("year_from", 0):
            why = f"released before {found['year_from']}"
        elif d["year"] and d["year"] > found.get("year_to", 9999):
            why = f"released after {found['year_to']}"
        elif "min_rating" in found and (d["rating"] or 0) < found["min_rating"]:
            why = f"rated below {found['min_rating']:g} on TMDb"
        elif "max_rating" in found and (d["rating"] or 0) > found["max_rating"]:
            why = f"rated above {found['max_rating']:g} on TMDb"
        elif found.get("languages") and (d["language"] or "").casefold() not in fold(found["languages"]):
            why = "in a language left out"
        elif fold(found.get("exclude_genres", [])) & fold(d["genres"]):
            why = "in a genre left out"
        elif (d["certification"] or "NR").casefold() in fold(found.get("exclude_certifications", [])):
            why = f"rated {d['certification'] or 'NR'}"
        if why:
            left.append({"title": row["title"], "year": row.get("year"), "why": why})
        else:
            kept.append(row)
    year = lambda row: (row.get("details") or {}).get("year")
    week = "%d-%02d" % today.isocalendar()[:2]
    keys = {
        "rating": lambda row: -((row.get("details") or {}).get("rating") or 0),
        "oldest": lambda row: year(row) or 9999,
        "newest": lambda row: -(year(row) or 0),
        "anniversary": lambda row: not (year(row) and round_anniversary(today.year - year(row))),
        "random": lambda row: week_hash(week, row["member"])}
    if sort in keys:
        kept.sort(key=keys[sort])
    left.extend({"title": row["title"], "year": row.get("year"), "why": "beyond the collection size"} for row in kept[limit:])
    return [{key: value for key, value in row.items() if key != "details"} for row in kept[:limit]], left


def owned_members(members, items):
    """How many of a list's members are in Plex, matched by TMDb or IMDb ID, or by title and year."""
    tmdb = {item["tmdb_id"] for item in items if item.get("tmdb_id")}
    imdb = {item["imdb_id"] for item in items if item.get("imdb_id")}
    titles = {(item["title"].casefold(), str(item.get("year") or "")) for item in items}
    named = {title for title, _ in titles}
    return sum(1 for m in members if m.get("tmdb_id") in tmdb or m.get("imdb_id") in imdb
               or "title" in m and ((str(m["title"]).casefold(), str(m["year"])) in titles if m.get("year") else str(m["title"]).casefold() in named))


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
        if not isinstance(entry, dict) or set(entry) - {"name", "library", "type", "enabled", "schedule", "sync", "members", "rules", "visibility", "acquire", "cleanup", "hide_recent", "source", "exclude"}:
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
        # hide_recent only matters to tk.box, which keeps the movies this collection downloads off Recently added.
        for field in ("enabled", "acquire", "hide_recent"):
            if field in entry and type(entry[field]) is not bool:
                raise ValueError(f"Collection {field} must be true or false")
        # Older settings name a membership mode; a custom collection now always matches its titles, so it's ignored.
        if entry.get("sync", "append") not in ("sync", "append"):
            raise ValueError("Collection sync must be sync or append")
        collection_active(entry.get("schedule"))
        source = entry.get("source")
        if source is not None:
            if not isinstance(source, dict) or set(source) - {"url", "limit", "refresh", "filter", "sort"}:
                raise ValueError("Collection source supports url, limit, refresh, filter and sort")
            source_choice(source)
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
        if entry.get("cleanup", "keep") not in ("keep", "remove-delete", "rotate"):
            raise ValueError("Collection cleanup must be keep, remove-delete or rotate")
        if entry.get("acquire") and entry["type"] != "movie":
            raise ValueError(f"{entry['name']}: only movie collections can download through Radarr")
        if enabled and entry.get("acquire") and not (source or any("tmdb_id" in m for m in members)):
            raise ValueError(f"{entry['name']}: Radarr downloads need titles with TMDb IDs (tmdb:123) or a list")
        if entry.get("cleanup") == "remove-delete" and (not entry.get("schedule") or not entry.get("acquire")):
            raise ValueError("remove-delete requires a seasonal collection with acquire: true")
        # Rotating deletes what leaves the list, so the list must be read on every run.
        if entry.get("cleanup") == "rotate" and (not entry.get("acquire") or not source or not source.get("refresh", option({}, "collection_source_refresh"))):
            raise ValueError("rotate requires acquire: true and a list that is refreshed on every run")
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
    """The Plex titles a collection holds, the members it couldn't find, and how many of those matched more than one title."""
    selected, missing, ambiguous = set(), [], 0
    for member in entry.get("members", []):
        matches = [item for item in items if all(str(item.get(k, "")).casefold() == str(v).casefold() for k, v in member.items())]
        ambiguous += len(matches) > 1
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
    return [item["rating_key"] for item in items if item["rating_key"] in selected], missing, ambiguous


def seasonal_radarr(artwork, definitions, items, apply, today):
    """Only a successful add recorded here AND its private Radarr tag grant cleanup ownership. A seasonal collection
    (remove-delete) deletes the movies it downloaded once its season ends; a rotating one (rotate) deletes each once it
    leaves the list, but not while someone is watching it, nor on a run where the list came back less than half as long as last time."""
    if not any(entry.get("acquire") and entry.get("enabled", True) for entry in definitions):
        return
    if READ_ONLY:
        print("READ-ONLY: Radarr acquisition and cleanup skipped", flush=True)
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
    state_path = artwork.base / "collections-state.json"
    try:
        state = json.loads(state_path.read_bytes()) if state_path.exists() else {"version": 1, "server": url, "tag": "tkbox-" + secrets.token_hex(8), "movies": {}}
    except (OSError, ValueError):
        raise ValueError("Cannot read collections-state.json; Radarr acquisition and cleanup refused. Restore the ownership journal from backup") from None
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("movies"), dict) or not isinstance(state.get("tag"), str):
        raise ValueError("Invalid collections-state.json; Radarr acquisition and cleanup refused. Restore the ownership journal from backup")
    if state.get("server") != url:
        raise ValueError("Radarr URL differs from collections-state.json; Radarr acquisition and cleanup refused. Restore the previous radarr.url or the journal for this server")
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
        keys = collection_members(entry, candidates)[0]
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
    # A list that suddenly shrank is more likely a bad answer than a new week: nothing leaves it on this run.
    lists, held = state.setdefault("lists", {}), set()
    for entry in definitions:
        if entry.get("enabled", True) and entry.get("cleanup") == "rotate":
            owner, count = identity(entry), sum("tmdb_id" in m for m in entry.get("members", []))
            if count < lists.get(owner, 0) / 2:
                held.add(owner)
                print(f"WARN {entry['name']} [{entry['library']}]: the list has {count} movies, down from {lists[owner]}; none are removed this run", flush=True)
            if apply and lists.get(owner) != count:
                lists[owner] = count
                save()
    def releases(entry):
        if entry is None or not entry.get("enabled", True):
            return False
        if entry.get("cleanup") == "rotate":
            return identity(entry) not in held
        return entry.get("cleanup", "keep") == "remove-delete" and not collection_active(entry.get("schedule"), today)
    playing = None
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
        if not responsible or not all(map(releases, responsible)):
            continue
        movie = existing.get(tmdb_id)
        if movie is None or tag is None or tag not in movie.get("tags", []) or movie["id"] != record["id"] or not record.get("path") or movie.get("path") != record["path"]:
            continue
        if any(e.get("cleanup") == "rotate" for e in responsible):
            if playing is None:
                playing = now_playing(artwork.plex, items)
            if playing is False or tmdb_id in playing:
                print(f"KEEP {movie['title']} (tmdb:{tmdb_id}): left the list, but "
                      + ("Plex didn't say what is playing" if playing is False else "someone is watching it"), flush=True)
                continue
        print(f"{' ' if apply else 'PLAN '}RADARR REMOVE + DELETE FILES {movie['title']} (tmdb:{tmdb_id}; added by tk.box)", flush=True)
        if apply:
            fresh = request("GET", f"movie/{record['id']}")
            if fresh.get("tmdbId") != tmdb_id or tag not in fresh.get("tags", []) or fresh.get("path") != record["path"]:
                raise ValueError("Radarr ownership changed; cleanup refused")
            request("DELETE", f"movie/{record['id']}", params={"deleteFiles": "true", "addImportExclusion": "false"})
            del state["movies"][key]
            save()


def now_playing(plex, items):
    """The TMDb IDs of the movies someone is watching now, or False if Plex didn't say."""
    try:
        keys = {e.get("ratingKey") for e in plex.xml("/status/sessions") if e.tag == "Video"}
    except (RuntimeError, ET.ParseError):
        return False
    return {item["tmdb_id"] for item in items if item["rating_key"] in keys and item.get("tmdb_id")}


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
            result = sources.fetch(source["url"], entry["type"], source.get("limit"), choose=source, exclude=entry.get("exclude"))
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
            keys, missing, ambiguous = collection_members(entry, candidates)
            dropped = collection_members({"members": entry.get("exclude", [])}, candidates)[0]
            keys = [key for key in keys if key not in dropped]
            if active:
                if added_item is not None:
                    keys = [key for key in keys if key == added_item.get("rating_key")]
                    if not keys:
                        continue
                print(f"{'PLAN ' if not apply else ''}MATCH {name} [{library}]: {len(keys)} existing Plex {'shows' if entry['type'] == 'tv' else 'movies'}; enabled", flush=True)
                # A title missing from Plex can't be in the collection, but one that matches several might be: nothing
                # comes out while any is unclear.
                if ambiguous:
                    print(f"WARN {name} [{library}]: {ambiguous} members match more than one title; no members removed", flush=True)
                elif missing:
                    print(f"NOTE {name} [{library}]: {len(missing)} members not in Plex", flush=True)
                if not keys:
                    print(f"SKIP {name} [{library}]: no matching titles; membership left alone", flush=True)
                else:
                    builder.groups({(library, "custom"): {"name": name, "type": 2 if entry["type"] == "tv" else 1, "keys": keys, "drop": dropped}},
                                   {item["rating_key"]: item["title"] for item in candidates}, sections, 1, added_item is None and not ambiguous)
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


def franchise_name(collection):
    """A TMDb movie collection's name as its franchise collection is called: "Alien Collection" is "Alien"."""
    return re.sub(r"\s+Collection$", "", collection.get("name") or "").strip() or str(collection["id"])


INDEX_FILE = "discover-index.json"
# How long the index trusts what it read: a movie's TMDb collection rarely changes; a collection's parts and a
# universe's list change when a movie is announced or released.
MOVIE_DAYS, LIST_DAYS = 30, 7


def empty_index():
    return {"version": 1, "built": None, "movies": {}, "collections": {}, "universes": {}}


def load_index(artwork):
    """The Discover index (see build_index), or an empty one if it hasn't been built or can't be read."""
    with contextlib.suppress(OSError, ValueError):
        index = json.loads((artwork.base / INDEX_FILE).read_bytes())
        if isinstance(index, dict) and index.get("version") == 1 and all(isinstance(index.get(k), dict) for k in ("movies", "collections", "universes")):
            return index
    return empty_index()


def save_index(artwork, index):
    atomic_write(artwork.base / INDEX_FILE, json.dumps(index).encode())


def index_movies(artwork, index, tmdb_ids, force=False, now=None):
    """Records each movie's TMDb collection ([collection ID or None, when read]) where it is missing, older than
    MOVIE_DAYS, or `force`d; a failed lookup keeps what was there. Returns the collection IDs of these movies."""
    now = time.time() if now is None else now
    movies = index["movies"]
    stale = [i for i in tmdb_ids if force or str(i) not in movies or now - movies[str(i)][1] > MOVIE_DAYS * 86400]
    def lookup(movie_id):
        try:
            return movie_id, (artwork.tmdb(f"/movie/{movie_id}").get("belongs_to_collection") or {}).get("id")
        except (RuntimeError, ValueError):
            return movie_id, False
    with ThreadPoolExecutor(max_workers=6) as pool:
        for movie_id, collection in pool.map(lookup, stale):
            if collection is not False:
                movies[str(movie_id)] = [collection, now]
    return {movies[str(i)][0] for i in tmdb_ids if str(i) in movies and movies[str(i)][0]}


def index_collections(artwork, index, collection_ids, force=False, now=None):
    """Records each TMDb collection's name and parts where missing, older than LIST_DAYS, or `force`d."""
    now = time.time() if now is None else now
    collections = index["collections"]
    stale = [i for i in collection_ids if force or str(i) not in collections or now - collections[str(i)]["read"] > LIST_DAYS * 86400]
    def lookup(collection_id):
        try:
            return collection_id, artwork.tmdb(f"/collection/{collection_id}")
        except (RuntimeError, ValueError):
            return collection_id, None
    with ThreadPoolExecutor(max_workers=6) as pool:
        for collection_id, detail in pool.map(lookup, stale):
            if detail and detail.get("parts") is not None:
                collections[str(collection_id)] = {"name": franchise_name({"id": collection_id, **detail}), "read": now, "parts": [
                    {"id": p["id"], "title": p.get("title") or str(p["id"]), "release_date": p.get("release_date") or ""} for p in detail["parts"] if p.get("id")]}


def index_universes(sources, index, force=False, now=None):
    """Records each universe's list (its members, as the list names them) where missing, older than LIST_DAYS, or
    `force`d; one that can't be read keeps what was there. Returns how many couldn't be read."""
    now = time.time() if now is None else now
    universes = index["universes"]
    wanted = [(key, url, kind) for key, _, url, kinds in COLLECTION_UNIVERSES for kind in kinds
              if force or f"{key}:{kind}" not in universes or now - universes[f"{key}:{kind}"]["read"] > LIST_DAYS * 86400]
    def read(entry):
        key, url, kind = entry
        try:
            return entry, [row["member"] for row in sources.fetch(url, kind, 250, resolve=False)["items"]]
        except (RuntimeError, ValueError):
            return entry, None
    failed = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for (key, _, kind), members in pool.map(read, wanted):
            if members is None:
                failed += 1
            else:
                universes[f"{key}:{kind}"] = {"read": now, "members": members}
    return failed


def build_index(artwork, force=False, now=None):
    """The Discover index Partly owned and Universes read, so they open at once: each movie's TMDb collection, those
    collections' parts and each universe's list, saved in DATA_DIR/artwork/discover-index.json. Only what is missing or
    stale is asked for again, and movies no longer in Plex (and collections none of them is in) are dropped. What you
    own is never stored: Discover matches it with Plex when it opens. Returns the number of lookups that failed."""
    now = time.time() if now is None else now
    index = load_index(artwork)
    movies = [movie for movie in artwork.plex.scan(media_type="movie") if movie.get("tmdb_id")]
    ids = sorted({movie["tmdb_id"] for movie in movies})
    print(f"INDEX {len(ids)} movies", flush=True)
    present = set(ids)
    index["movies"] = {key: value for key, value in index["movies"].items() if int(key) in present}
    collections = index_movies(artwork, index, ids, force, now) if artwork.keys.get("tmdb_key") else set()
    index["collections"] = {key: value for key, value in index["collections"].items() if int(key) in collections}
    index_collections(artwork, index, sorted(collections), force, now)
    failed = index_universes(CollectionSources(artwork), index, force, now)
    failed += sum(1 for i in ids if str(i) not in index["movies"]) + sum(1 for i in collections if str(i) not in index["collections"])
    index["built"] = now
    save_index(artwork, index)
    print(f"INDEX {len(index['collections'])} TMDb collections and {len(index['universes'])} universe lists saved"
          + (f"; {failed} lookups failed and are tried again next time" if failed else ""), flush=True)
    return failed


def index_added(artwork, rating_keys, now=None):
    """Newly added movies join the Discover index straight away: their TMDb collection, and its parts read again.
    Universes need nothing, as what you own is matched when Discover opens."""
    index = load_index(artwork)
    ids = []
    for rating_key in rating_keys:
        try:
            item = artwork.plex.get_item(rating_key)
        except ValueError:  # An episode, or gone again
            continue
        if item.get("type") != "movie":
            continue
        artwork.identify(item)
        if item.get("tmdb_id"):
            ids.append(item["tmdb_id"])
    if not ids:
        print("INDEX No newly added movies with a TMDb ID", flush=True)
        return 0
    collections = index_movies(artwork, index, ids, True, now)
    index_collections(artwork, index, sorted(collections), True, now)
    save_index(artwork, index)
    print(f"INDEX {len(ids)} newly added movies, in {len(collections)} TMDb collections", flush=True)
    return 0


def franchise_counts(artwork, index):
    """How many movies each library has of each TMDb collection now, from a Plex scan and the Discover index:
    [{"library", "name", "items"}], so the Collections page needn't wait for a full run to see movies come and go."""
    counts = {}
    for movie in artwork.plex.scan(media_type="movie"):
        entry = index["movies"].get(str(movie.get("tmdb_id")))
        collection = index["collections"].get(str(entry[0])) if entry and entry[0] else None
        if collection:
            key = (movie["library"], collection["name"])
            counts[key] = counts.get(key, 0) + 1
    return [{"library": library, "name": name, "items": items} for (library, name), items in sorted(counts.items())]


def partly_owned(artwork, query="", today=None, index=None):
    """The TMDb movie collections each library holds some but not all of the released movies of, from the Discover
    index (see build_index) matched with Plex now, closest to complete first: ({"name", "url", "description", "type",
    "provider", "library", "owned", "total"} rows, number of movies in Plex the index hasn't read yet)."""
    index = index or empty_index()
    today = (today or date.today()).isoformat()
    movies = [movie for movie in artwork.plex.scan(media_type="movie") if movie.get("tmdb_id")]
    owned, unread = {}, set()
    for movie in movies:
        entry = index["movies"].get(str(movie["tmdb_id"]))
        if entry is None:
            unread.add(movie["tmdb_id"])
        elif entry[0] and str(entry[0]) in index["collections"]:
            owned.setdefault((movie["library"], entry[0]), set()).add(movie["tmdb_id"])
    rows = []
    for (library, collection_id), have in owned.items():
        detail = index["collections"][str(collection_id)]
        # Movies not out yet aren't missing; a part with no date isn't out either.
        missing = [part for part in detail["parts"] if part["id"] not in have and (part["release_date"] or "9999") <= today]
        if not missing or query.casefold() not in detail["name"].casefold():
            continue
        titles = [f"{part['title']} ({part['release_date'][:4]})" for part in sorted(missing, key=lambda p: p["release_date"])]
        more = f" and {len(titles) - 5} more" if len(titles) > 5 else ""
        rows.append({"name": detail["name"], "url": f"https://www.themoviedb.org/collection/{collection_id}/", "type": "movie", "provider": "tmdb",
                     "library": library, "owned": len(have), "total": len(have) + len(missing),
                     "description": f"{len(have)} of {len(have) + len(missing)} in {library}. Missing {', '.join(titles[:5])}{more}"})
    rows.sort(key=lambda row: (row["total"] - row["owned"], -row["owned"], row["name"].casefold(), row["library"]))
    return rows, len(unread)


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
            add(movie["library"], franchise["id"], franchise_name(franchise), 1, movie)
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

    def groups(self, groups, titles, sections, minimum, sync, settings=None, claimed=()):
        """Franchise and streaming collections: create the missing ones, add to (and with `sync` trim) the rest. One the
        admin turned off (in `settings`, from validate_automatic) comes out of Plex instead, and one with a visibility
        setting has it applied. One with the name of a custom collection (in `claimed`) is that collection's to keep.
        Every one that qualifies or is claimed is noted in `wanted`."""
        plex, counts, prefix, listed, settings = self.plex, self.counts, self.prefix, {}, settings or {}
        for (library, label), group in sorted(groups.items(), key=lambda pair: (pair[0][0], pair[1]["name"].casefold())):
            name, setting = group["name"], settings.get((library, collection_key(group["name"])), {})
            if (library, collection_key(name)) in claimed:
                self.wanted.add((library, collection_key(name)))
                print(f"SKIP {name} [{library}]: kept as one of tk.box's custom collections", flush=True)
                continue
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
                    print(f"SKIP {current['title']} [{library}]: a smart collection can't be edited by hand; delete it in Plex to let tk.box rebuild it")
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
    # A custom collection named like a franchise one (one added from Discover's Partly owned) takes it over.
    claimed = {(entry["library"], collection_key(entry["name"])) for entry in validate_collections(artwork.config)}
    builder.groups(groups, titles, sections, minimum, sync, validate_automatic(artwork.config), claimed)
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
        if not custom:  # Its TMDb lookups are fresh in the cache now, so the Discover index costs little more
            try:
                build_index(artwork)
            except (RuntimeError, ValueError, OSError) as error:
                print(f"ERROR Discover index: {error}", file=sys.stderr, flush=True)
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
    """The Collections page's Discover: recommendations, a provider's lists, universes, partly owned TMDb collections,
    or a preview of one list."""
    sources = CollectionSources(engine(config_path, read_collections_config(config_path)))
    mode = data.get("mode", "recommendations")
    try:
        if mode == "preview":
            universe = data.get("universe")
            preset = next((row for row in COLLECTION_UNIVERSES if row[0] == universe), None) if universe else None
            if universe and (preset is None or data.get("type", "movie") not in preset[3]):
                raise ValueError("Unknown universe or unsupported media type")
            result = sources.fetch(preset[2] if preset else data.get("url"), data.get("type", "movie"), data.get("limit"),
                                   choose={key: data[key] for key in ("filter", "sort") if key in data}, candidates=data.get("candidates") is True)
            if preset:
                result["name"] = preset[1]
            return result
        provider, query = data.get("provider", "all"), str(data.get("query") or "")[:200]
        if mode in ("universes", "partial", "franchises"):  # From the Discover index, matched with Plex now: no lookups while you wait
            index = load_index(sources.artwork)
            built = {"built": index["built"]}
            if mode == "franchises":
                return {"results": franchise_counts(sources.artwork, index) if index["built"] else [], "index": built}
            if mode == "universes":
                return {"results": sources.universes(query, data.get("type", "movie"), index), "index": built}
            rows, unread = partly_owned(sources.artwork, query, index=index)
            return {"results": rows, "index": {**built, "unread": unread}}
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
    index = commands.add_parser("index", help="Build the Discover index (build), or add newly added movies to it (added KEY...)")
    index.add_argument("action", choices=("build", "added"))
    index.add_argument("rating_keys", nargs="*", type=int)
    commands.add_parser("defaults", help="Print the seasonal presets used until collections are first saved")
    commands.add_parser("check", help="Only validate the config, then exit (tk.box runs this before saving)")
    args = parser.parse_args()
    if getattr(args, "date", None) and args.mode != "plan":
        parser.error("--date is only for plan")
    if args.command == "index" and (args.action == "added") != bool(args.rating_keys):
        parser.error("index added needs Plex IDs, and index build takes none")
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
        if args.command == "index":
            artwork = engine(args.config, read_collections_config(args.config))
            artwork.plex.require("Building the Discover index")
            return 1 if (build_index(artwork) if args.action == "build" else index_added(artwork, args.rating_keys)) else 0
        with run_lock(args.config) if args.command == "added" or args.mode == "apply" else contextlib.nullcontext():
            if args.command == "added":
                return added(args.config, args.rating_key)
            return sync_collections(args.config, args.mode, args.command == "custom", getattr(args, "date", None))
    except (OSError, ValueError, TypeError, RuntimeError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
