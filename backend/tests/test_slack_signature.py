import hashlib
import hmac
import time

from app.slack.signature import verify_slack_signature

_SECRET = "test-signing-secret"


def _sign(secret: str, timestamp: str, body: bytes) -> str:
    # Independent re-implementation of Slack's documented v0 algorithm
    # (see app/slack/signature.py's own docstring) - deliberately not
    # imported from production code, so this test can't pass by construction.
    basestring = f"v0:{timestamp}:{body.decode()}"
    return "v0=" + hmac.new(secret.encode(), basestring.encode(), hashlib.sha256).hexdigest()


def test_verify_slack_signature_accepts_valid_signature() -> None:
    timestamp = str(int(time.time()))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, timestamp, body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET, timestamp=timestamp, signature=signature, body=body
        )
        is True
    )


def test_verify_slack_signature_rejects_tampered_body() -> None:
    timestamp = str(int(time.time()))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, timestamp, body)
    tampered_body = b'{"type":"url_verification","challenge":"tampered"}'

    assert (
        verify_slack_signature(
            signing_secret=_SECRET,
            timestamp=timestamp,
            signature=signature,
            body=tampered_body,
        )
        is False
    )


def test_verify_slack_signature_rejects_tampered_signature() -> None:
    timestamp = str(int(time.time()))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, timestamp, body)
    tampered_signature = "v0=" + ("0" * 64)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET,
            timestamp=timestamp,
            signature=tampered_signature,
            body=body,
        )
        is False
    )


def test_verify_slack_signature_rejects_signature_from_wrong_secret() -> None:
    timestamp = str(int(time.time()))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign("some-other-secret", timestamp, body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET, timestamp=timestamp, signature=signature, body=body
        )
        is False
    )


def test_verify_slack_signature_rejects_stale_timestamp() -> None:
    stale_timestamp = str(int(time.time()) - (60 * 10))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, stale_timestamp, body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET,
            timestamp=stale_timestamp,
            signature=signature,
            body=body,
        )
        is False
    )


def test_verify_slack_signature_accepts_timestamp_just_inside_window() -> None:
    timestamp = str(int(time.time()) - (60 * 5 - 10))
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, timestamp, body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET, timestamp=timestamp, signature=signature, body=body
        )
        is True
    )


def test_verify_slack_signature_rejects_missing_signature_header() -> None:
    timestamp = str(int(time.time()))
    body = b'{"type":"url_verification","challenge":"abc"}'

    assert (
        verify_slack_signature(
            signing_secret=_SECRET, timestamp=timestamp, signature=None, body=body
        )
        is False
    )


def test_verify_slack_signature_rejects_missing_timestamp_header() -> None:
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, "1700000000", body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET, timestamp=None, signature=signature, body=body
        )
        is False
    )


def test_verify_slack_signature_rejects_non_numeric_timestamp() -> None:
    body = b'{"type":"url_verification","challenge":"abc"}'
    signature = _sign(_SECRET, "not-a-number", body)

    assert (
        verify_slack_signature(
            signing_secret=_SECRET,
            timestamp="not-a-number",
            signature=signature,
            body=body,
        )
        is False
    )
