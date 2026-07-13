"""Extract <img> references from HTML and download images to a local directory."""
from __future__ import annotations

import hashlib
import os
import tempfile
import time
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from modules.crawler.schemas import ImageRef


def extract_image_refs(
    soup_element: BeautifulSoup | Tag,
    base_url: str,
) -> list[ImageRef]:
    """Extract all <img> tags from a BeautifulSoup element, returning ImageRef objects."""
    refs: list[ImageRef] = []
    seen: set[str] = set()

    for img in soup_element.find_all('img'):
        src = (img.get('src') or '').strip()
        if not src:
            continue
        # Skip inline data URIs (they stay embedded in content)
        if src.startswith('data:'):
            continue
        # Resolve relative URLs
        try:
            absolute = urljoin(base_url, src)
        except Exception:
            absolute = src

        if absolute in seen:
            continue
        seen.add(absolute)

        alt = (img.get('alt') or '').strip()
        refs.append(ImageRef(src_url=absolute, alt=alt))

    return refs


async def download_images(
    image_refs: list[ImageRef],
    output_dir: str,
    session: Optional[httpx.AsyncClient] = None,
    timeout: float = 15.0,
) -> list[ImageRef]:
    """Download images to output_dir, returning updated ImageRef list with local_path filled in.

    Deduplicates by src_url. Failed downloads are skipped silently.
    """
    if not image_refs:
        return image_refs

    os.makedirs(output_dir, exist_ok=True)

    close_session = False
    client = session
    if client is None:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        close_session = True

    try:
        updated: list[ImageRef] = []
        for ref in image_refs:
            if ref.local_path:
                updated.append(ref)
                continue

            # Deduplicate: if another ref has the same URL and was already downloaded, reuse
            existing = next((r for r in updated if r.src_url == ref.src_url and r.local_path), None)
            if existing:
                updated.append(ImageRef(
                    src_url=ref.src_url,
                    alt=ref.alt,
                    local_path=existing.local_path,
                    content_type=existing.content_type,
                    file_size=existing.file_size,
                ))
                continue

            try:
                response = await client.get(ref.src_url, timeout=timeout)
                response.raise_for_status()

                content_type = response.headers.get('content-type', 'image/png')
                content = response.content
                if len(content) == 0:
                    updated.append(ref)
                    continue

                # Generate a filename from URL hash
                url_hash = hashlib.md5(ref.src_url.encode('utf-8')).hexdigest()[:12]
                ext = _guess_extension(content_type)
                filename = f'{url_hash}{ext}'
                filepath = os.path.join(output_dir, filename)

                with open(filepath, 'wb') as f:
                    f.write(content)

                updated.append(ImageRef(
                    src_url=ref.src_url,
                    alt=ref.alt,
                    local_path=filepath,
                    content_type=content_type,
                    file_size=len(content),
                ))
            except Exception:
                # Failed downloads are skipped
                updated.append(ref)

        return updated
    finally:
        if close_session:
            await client.aclose()


def rich_text_from(element: BeautifulSoup | Tag, selector: str | None) -> str:
    """Extract inner HTML from matched element, keeping only <img> and <br> tags.

    Falls back to plain text if extraction fails.
    """
    if not selector:
        try:
            text = element.get_text(' ', strip=True)
        except Exception:
            text = ''
        return text

    try:
        nodes = element.select(selector)
    except Exception:
        return ''

    if not nodes:
        return ''

    node = nodes[0]

    # Clone to avoid mutating the original
    import copy
    clone = copy.copy(node)

    # Remove all tags except <img> and <br>
    _strip_tags_except(clone, keep={'img', 'br'})

    # Get inner HTML
    html = ''.join(str(child) for child in clone.contents) if hasattr(clone, 'contents') else clone.decode_contents()
    return html.strip()


def _strip_tags_except(soup: BeautifulSoup | Tag, keep: set[str]) -> None:
    """Recursively remove all tags except those in `keep`, preserving text content."""
    from bs4 import NavigableString

    for child in list(soup.children):
        if isinstance(child, NavigableString):
            continue
        if child.name in keep:
            # Keep <img> and <br> but strip their event handlers
            for attr in list(child.attrs):
                if attr.startswith('on'):
                    del child.attrs[attr]
            _strip_tags_except(child, keep)
        else:
            # Unwrap: replace this tag with its text content
            child.unwrap()


def _guess_extension(content_type: str) -> str:
    """Map MIME type to file extension."""
    mapping = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
    }
    # Normalize: strip charset suffix
    ct = content_type.split(';')[0].strip().lower()
    return mapping.get(ct, '.png')
