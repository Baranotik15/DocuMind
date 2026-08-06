import hashlib
import hmac
import time

# Slack's own documented replay-attack guard
# (https://api.slack.com/authentication/verifying-requests-from-slack):
# reject any request whose X-Slack-Request-Timestamp is more than 5 minutes
# away from "now", in either direction.
_MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5


def verify_slack_signature(
    *,
    signing_secret: str,
    timestamp: str | None,
    signature: str | None,
    body: bytes,
) -> bool:
    """Verifies a Slack Events API webhook request per Slack's documented v0
    signing algorithm. `timestamp`/`signature` are the raw
    X-Slack-Request-Timestamp / X-Slack-Signature header values (None if
    either header is missing - always rejected). `body` must be the exact
    raw request bytes (not a re-serialized/parsed form - Slack signs the
    literal bytes it sent, so any re-encoding would produce a mismatch even
    for a genuine request).

    Returns False (never raises) for: a missing header, a non-numeric
    timestamp, a stale timestamp (see _MAX_TIMESTAMP_SKEW_SECONDS above), or
    a signature that doesn't match the HMAC-SHA256 digest of
    `f"v0:{timestamp}:{body}"` keyed by `signing_secret`. The comparison
    uses hmac.compare_digest (constant-time) so a timing side-channel can't
    leak how much of a forged signature happened to match.
    """
    if timestamp is None or signature is None:
        return False

    try:
        timestamp_seconds = int(timestamp)
    except ValueError:
        return False

    if abs(time.time() - timestamp_seconds) > _MAX_TIMESTAMP_SKEW_SECONDS:
        return False

    basestring = f"v0:{timestamp}:{body.decode()}"
    computed_signature = (
        "v0=" + hmac.new(signing_secret.encode(), basestring.encode(), hashlib.sha256).hexdigest()
    )

    return hmac.compare_digest(computed_signature, signature)
