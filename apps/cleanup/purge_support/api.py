"""Small API clients with explicit failures and one reusable HTTP session."""

import os

import requests

from .config import Service


class ApiError(RuntimeError):
    """An integration failed; its data must not be interpreted as an empty library."""


def positive_id(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("Expected a positive integer ID")
    result = int(value)
    if result <= 0:
        raise ValueError("Expected a positive integer ID")
    return result


def object_list(data, description):
    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
        raise ApiError(f"Invalid {description} response")
    return data


def season_targets(season_number, episodes):
    """Preflight a season without performing writes, including shared-file checks."""
    season_episodes = [ep for ep in episodes if ep.get("seasonNumber") == season_number]
    if not season_episodes:
        raise ApiError(f"Sonarr has no episodes for season {season_number}")
    try:
        episode_ids = [positive_id(ep.get("id")) for ep in season_episodes]
        file_ids = {positive_id(ep["episodeFileId"]) for ep in season_episodes if ep.get("episodeFileId")}
        if any(ep.get("hasFile") and not ep.get("episodeFileId") for ep in season_episodes):
            raise ValueError
    except (KeyError, ValueError, TypeError):
        raise ApiError("Sonarr returned invalid episode/file IDs") from None
    if not file_ids:
        raise ApiError("Sonarr has no mapped episode files for this Plex season")
    try:
        shared_with_other_season = any(positive_id(ep["episodeFileId"]) in file_ids
                                      and ep.get("seasonNumber") != season_number
                                      for ep in episodes if ep.get("episodeFileId"))
    except (ValueError, TypeError):
        raise ApiError("Sonarr returned invalid episode/file IDs") from None
    if shared_with_other_season:
        raise ApiError("Sonarr episode file spans another season; refusing to delete it")
    return episode_ids, file_ids


class HttpClient:
    def __init__(self, session, timeout):
        self.session = session
        self.timeout = timeout

    def request(self, method, url, *, decode=False, **kwargs):
        if method != "GET" and os.environ.get("TKBOX_READ_ONLY") == "1":
            raise ApiError(f"{method} {url}: refused in read-only mode")
        try:
            response = self.session.request(method, url, timeout=self.timeout, **kwargs)
            response.raise_for_status()
            return response.json() if decode else None
        except requests.RequestException as exc:
            status = exc.response.status_code if exc.response is not None else "unavailable"
            # RequestException URLs may include the Tautulli API key. Never log them.
            raise ApiError(f"{method} {url}: {type(exc).__name__} (HTTP {status})") from None
        except ValueError:
            raise ApiError(f"{method} {url}: invalid JSON") from None


class SeerrClient:
    def __init__(self, http: HttpClient, service: Service):
        self.http = http
        self.url = service.url + "/api/v1"
        self.headers = {"X-Api-Key": service.key}

    def available_requests(self):
        results, seen = [], set()
        while True:
            data = self.http.request("GET", self.url + "/request", headers=self.headers, decode=True,
                                     params={"take": 100, "skip": len(results), "filter": "available", "sort": "added"})
            if not isinstance(data, dict):
                raise ApiError("Invalid Seerr request response")
            page = object_list(data.get("results"), "Seerr requests")
            info = data.get("pageInfo") or {}
            total = info.get("results") if isinstance(info, dict) else None
            if total is not None and (isinstance(total, bool) or not isinstance(total, int) or total < 0):
                raise ApiError("Invalid Seerr request count")
            if not page:
                if total is not None and len(results) < total:
                    raise ApiError("Seerr request pagination ended before all requests were fetched")
                return results
            for request in page:
                try:
                    request_id = positive_id(request.get("id"))
                except (ValueError, TypeError):
                    raise ApiError("Seerr returned a request without a valid ID") from None
                if request_id in seen:
                    raise ApiError("Seerr request pagination repeated a request; aborting incomplete fetch")
                seen.add(request_id)
            results.extend(page)
            if total is not None and len(results) >= total:
                return results

    def details(self, media_type, tmdb_id):
        data = self.http.request("GET", f"{self.url}/{media_type}/{positive_id(tmdb_id)}",
                                 headers=self.headers, decode=True)
        if not isinstance(data, dict):
            raise ApiError("Invalid Seerr media details")
        return data

    def delete_media(self, media_id):
        self.http.request("DELETE", f"{self.url}/media/{positive_id(media_id)}", headers=self.headers)


class ArrClient:
    def __init__(self, http: HttpClient, service: Service, name: str):
        self.http = http
        self.service = service
        self.name = name
        self.url = service.url + "/api/v3"
        self.headers = {"X-Api-Key": service.key}
        self.resource = "movie" if name == "Radarr" else "series"
        self.external_id = "tmdbId" if name == "Radarr" else "tvdbId"

    def library(self):
        if not self.service.configured:
            raise ApiError(f"{self.name} is not configured")
        data = self.http.request("GET", f"{self.url}/{self.resource}", headers=self.headers, decode=True)
        result = {}
        for item in object_list(data, self.name + " library"):
            try:
                key = positive_id(item.get(self.external_id))
                positive_id(item.get("id"))
            except (ValueError, TypeError):
                raise ApiError(f"{self.name} returned an item with invalid IDs") from None
            if key in result:
                raise ApiError(f"{self.name} returned duplicate external IDs")
            result[key] = item
        return result

    def tags(self):
        data = self.http.request("GET", self.url + "/tag", headers=self.headers, decode=True)
        result = {}
        for tag in object_list(data, self.name + " tags"):
            try:
                tag_id = positive_id(tag.get("id"))
                label = tag["label"].strip()
                if not label:
                    raise ValueError
            except (KeyError, AttributeError, ValueError, TypeError):
                raise ApiError(f"{self.name} returned an invalid tag") from None
            result[tag_id] = label
        return result

    def delete_item(self, item):
        self.http.request("DELETE", f"{self.url}/{self.resource}/{positive_id(item.get('id'))}",
                          headers=self.headers, params={"deleteFiles": "true", "addImportExclusion": "false"})

    def episodes(self, series_id):
        data = self.http.request("GET", self.url + "/episode", headers=self.headers, decode=True,
                                 params={"seriesId": positive_id(series_id)})
        return object_list(data, "Sonarr episodes")

    def delete_season(self, series, season_number, episodes):
        positive_id(series.get("id"))
        episode_ids, file_ids = season_targets(season_number, episodes)
        # Unmonitor before deleting, so a failed update cannot trigger a redownload.
        self.http.request("PUT", self.url + "/episode/monitor", headers=self.headers,
                          json={"episodeIds": episode_ids, "monitored": False})
        for file_id in sorted(file_ids):
            self.http.request("DELETE", f"{self.url}/episodefile/{file_id}", headers=self.headers)

    def rescan(self, series_id):
        self.http.request("POST", self.url + "/command", headers=self.headers,
                          json={"name": "RescanSeries", "seriesId": positive_id(series_id)})
