"""Serve the exported Expo web build.

`expo export --platform web` emits flat HTML per route -- `nurse.html`,
`log/bottle.html` -- plus a dynamic `event/[id].html`. WhiteNoise serves the
hashed assets; this view resolves the pretty URLs and falls back to the SPA
entry so client-side routes (an event id, say) still load on a hard refresh.
"""
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse

CACHE_HTML = "no-cache"  # HTML must revalidate or a deploy never reaches an open tab


def _root() -> Path | None:
    root = getattr(settings, "WEB_ROOT", None)
    return root if root and root.is_dir() else None


def _resolve(root: Path, path: str) -> Path | None:
    rel = path.strip("/")
    candidates = [rel and f"{rel}.html", rel and f"{rel}/index.html", "index.html"]
    for cand in candidates:
        if not cand:
            continue
        target = (root / cand).resolve()
        # Never serve outside the build directory, whatever the URL contains.
        if root.resolve() not in target.parents and target != root.resolve():
            continue
        if target.is_file():
            return target
    return None


def serve_web(request, path=""):
    root = _root()
    if root is None:
        raise Http404("no web build in this image")
    target = _resolve(root, path)
    if target is None:
        raise Http404("not found")
    resp = FileResponse(open(target, "rb"), content_type="text/html")
    resp["Cache-Control"] = CACHE_HTML
    return resp


def healthz(request):
    return HttpResponse("ok", content_type="text/plain")
