from typing import Any


def electron_cookie_to_playwright(cookie: dict[str, Any]) -> dict[str, Any] | None:
    name = cookie.get('name')
    value = cookie.get('value')
    domain = cookie.get('domain')
    path = cookie.get('path') or '/'
    if not name or value is None or not domain:
        return None

    same_site = cookie.get('sameSite')
    same_site_map = {
        'unspecified': 'Lax',
        'no_restriction': 'None',
        'lax': 'Lax',
        'strict': 'Strict',
    }
    expires = cookie.get('expirationDate')
    if expires is None:
        expires = -1

    return {
        'name': str(name),
        'value': str(value),
        'domain': str(domain),
        'path': str(path),
        'expires': float(expires),
        'httpOnly': bool(cookie.get('httpOnly')),
        'secure': bool(cookie.get('secure')),
        'sameSite': same_site_map.get(str(same_site), 'Lax'),
    }


def to_playwright_storage_state(session_state: dict[str, Any] | None, fallback_origin: str | None) -> dict[str, Any] | None:
    if not session_state:
        return None

    cookies = []
    for cookie in session_state.get('cookies') or []:
        if not isinstance(cookie, dict):
            continue
        converted = electron_cookie_to_playwright(cookie)
        if converted:
            cookies.append(converted)

    origin = session_state.get('origin') or fallback_origin
    local_storage = session_state.get('localStorage') or {}
    origins = []
    if origin and isinstance(local_storage, dict) and local_storage:
        origins.append({
            'origin': origin,
            'localStorage': [
                {'name': str(key), 'value': str(value)}
                for key, value in local_storage.items()
            ],
        })

    if not cookies and not origins:
        return None

    return {'cookies': cookies, 'origins': origins}
