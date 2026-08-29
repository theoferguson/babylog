"""Sending the invite email.

Plain Django SMTP, configured entirely by environment variables, so any provider
(Resend, Postmark, Mailgun, SendGrid, even Gmail) works without a dependency or
a code change.
"""
from django.conf import settings
from django.core.mail import send_mail
from django.utils import timezone


def send_invite(invite):
    """Send the invite. Returns True if it went out.

    Never raises: a delivery failure must not lose the invite, because the link
    can still be shared by hand.
    """
    link = invite.link(settings.PUBLIC_BASE_URL)
    who = invite.created_by.get_full_name() or invite.created_by.username if invite.created_by else "Someone"
    body = (
        f"{who} invited you to their babylog household"
        f"{f' ({invite.household.name})' if invite.household.name else ''}.\n\n"
        f"Open this link to create your account:\n{link}\n\n"
        "You will both see the same feeds, diapers and timers.\n"
        "The link works once and expires in a week. If you were not expecting "
        "this, you can ignore it."
    )
    try:
        sent = send_mail(
            subject="You have been invited to babylog",
            message=body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[invite.email],
            fail_silently=False,
        )
    except Exception:  # noqa: BLE001 -- SMTP failures are many and all recoverable
        return False
    if sent:
        invite.sent_at = timezone.now()
        invite.save(update_fields=["sent_at"])
    return bool(sent)
