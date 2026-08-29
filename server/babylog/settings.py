import os
import re
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-not-for-fly")
DEBUG = os.environ.get("DEBUG", "1") == "1"
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "*").split(",")
CSRF_TRUSTED_ORIGINS = [
    o for o in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") if o
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "rest_framework.authtoken",
    "events",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",  # must precede CommonMiddleware
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "babylog.urls"
WSGI_APPLICATION = "babylog.wsgi.application"

TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [], "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]

DATABASES = {
    "default": dj_database_url.config(
        default=os.environ.get("DATABASE_URL", f"sqlite:///{BASE_DIR / 'dev.sqlite3'}"),
        conn_max_age=600,
        conn_health_checks=True,
    )
}

if DATABASES["default"]["ENGINE"].endswith("sqlite3"):
    # SQLite tuned for two concurrent writers on one machine. Defaults are
    # tuned for a single-process desktop app and will throw "database is
    # locked" the first time you and your partner log a feed at once.
    DATABASES["default"]["OPTIONS"] = {
        "init_command": (
            # Readers never block the writer, and vice versa.
            "PRAGMA journal_mode=WAL;"
            # Safe with WAL: survives process crash, only risks the last commits
            # on host power loss.
            "PRAGMA synchronous=NORMAL;"
            # Wait for a busy lock instead of failing instantly.
            "PRAGMA busy_timeout=5000;"
            "PRAGMA foreign_keys=ON;"
            "PRAGMA temp_store=MEMORY;"
            "PRAGMA cache_size=-16000;"  # 16MB page cache
            "PRAGMA mmap_size=134217728;"  # 128MB
        ),
        # Take the write lock up front. Without this, two transactions that both
        # read then write deadlock on lock upgrade and one dies with SQLITE_BUSY
        # even though busy_timeout is set -- SQLite cannot resolve that by
        # waiting.
        "transaction_mode": "IMMEDIATE",
    }
    DATABASES["default"]["conn_max_age"] = 0  # cheap to reopen; avoids stale WAL readers

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": f"django.contrib.auth.password_validation.{n}"} for n in [
        "UserAttributeSimilarityValidator", "MinimumLengthValidator",
        "CommonPasswordValidator", "NumericPasswordValidator",
    ]
]

# The web build is a separate origin from the API, so the browser needs CORS.
# Native builds don't, which is why this only bites on web.
#
# An explicit allowlist, never CORS_ALLOW_ALL_ORIGINS: the API is token-
# authenticated, and reflecting arbitrary origins would let any page a browser
# visits read a signed-in user's data.
CORS_ALLOWED_ORIGINS = [
    o for o in os.environ.get(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006",
    ).split(",") if o
]
CORS_ALLOW_CREDENTIALS = False  # auth is a bearer token, not a cookie

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 200,
}

# Everything is stored UTC; each Event carries the zone it was recorded in.
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# The exported Expo web build, copied in by the Docker web stage. Absent in
# local development, where Metro serves the app instead.
WEB_ROOT = Path(os.environ.get("WEB_ROOT", BASE_DIR / "webroot"))
if WEB_ROOT.is_dir():
    # WhiteNoise serves the hashed assets under _expo/ only. HTML is deliberately
    # left to serve_web so every page carries no-cache -- otherwise a redeploy
    # would never reach a tab that is already open.
    WHITENOISE_ROOT = WEB_ROOT
    # Expo emits content-hashed asset names, so they can be cached forever.
    # WhiteNoise's default immutability test only knows Django's manifest
    # pattern, which these do not match -- without this, 1.2MB revalidates on
    # every load.
    WHITENOISE_IMMUTABLE_FILE_TEST = staticmethod(
        lambda path, url: re.search(r"[.-][0-9a-f]{8,}\.(js|css|woff2?|png|jpg|svg)$", url)
        is not None
    )

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
