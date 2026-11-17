"""Explicit failures and id checks for what Plex and tk.box hand the script."""


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
