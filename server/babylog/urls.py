from django.contrib import admin
from django.urls import include, path, re_path
from rest_framework.authtoken.views import obtain_auth_token
from rest_framework.routers import DefaultRouter

from events import views
from events.web import healthz, serve_web

router = DefaultRouter()
router.register("households", views.HouseholdViewSet, basename="household")
router.register("babies", views.BabyViewSet, basename="baby")
router.register("events", views.EventViewSet, basename="event")
router.register("invites", views.InviteViewSet, basename="invite")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include(router.urls)),
    path("api/auth/token/", obtain_auth_token),
    path("api/auth/register/", views.register),
    path("api/import/preview/", views.import_preview),
    path("api/import/commit/", views.import_commit),
    path("healthz", healthz),
    # Catch-all LAST: anything not an API, admin or static asset is a web-app
    # route and gets the SPA entry.
    re_path(r"^(?P<path>.*)$", serve_web),
]
