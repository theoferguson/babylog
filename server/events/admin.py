from django.contrib import admin

from .models import Baby, Event, Household, Membership


@admin.register(Household)
class HouseholdAdmin(admin.ModelAdmin):
    list_display = ["name", "units", "timezone"]


@admin.register(Baby)
class BabyAdmin(admin.ModelAdmin):
    list_display = ["name", "household", "dob", "archived"]


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    list_display = ["type", "started_at", "ended_at", "baby", "created_by", "deleted_at"]
    list_filter = ["type", "baby", "deleted_at"]
    date_hierarchy = "started_at"


admin.site.register(Membership)
