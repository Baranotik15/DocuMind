"""Admin-user management for the (small, closed) admin panel.

There is no HTTP path for creating or revoking a user - both are reachable
only by running this script inside the backend container, e.g.:

    docker compose exec -it backend python -m app.auth.cli create-user
    docker compose exec backend python -m app.auth.cli revoke-user \
        --email admin@example.com

create-user prompts for email/password/confirmation in the terminal (the
`-it` flags above are what give the container a real tty for that) rather
than taking them as --flags, so the password never ends up in shell
history or `docker inspect`/`ps` output.

Terminal I/O only - the actual user-provisioning logic (create_user/
revoke_user/UserNotFoundError) lives in service.py, which has no Unix-only
imports and stays importable on any platform without dragging in
termios/tty just to reuse it.
"""
import argparse
import sys
import termios
import tty

from sqlalchemy.exc import IntegrityError

from app.auth.service import UserNotFoundError, create_user, revoke_user

# Length matters far more for password strength than composition rules
# (NIST 800-63B) - this is a floor against trivially weak passwords
# (single dictionary words, "12345678"), not full complexity enforcement.
_MIN_PASSWORD_LENGTH = 8

_BACKSPACE_CHARS = ("\x7f", "\x08")


def _read_masked_password(prompt: str) -> str:
    """Reads a password from the terminal one raw keypress at a time,
    echoing '*' per character typed - unlike stdlib getpass (fully hidden,
    no feedback at all), this gives the same "something is being typed"
    confirmation a normal input field would, without ever showing the
    actual characters. Backspace erases the last '*'. Requires a real tty
    (true whenever this runs via `docker compose exec -it`, per this
    module's docstring)."""
    print(prompt, end="", flush=True)
    fd = sys.stdin.fileno()
    original_settings = termios.tcgetattr(fd)
    password_chars: list[str] = []
    try:
        tty.setraw(fd)
        while True:
            char = sys.stdin.read(1)
            if char in ("\r", "\n"):
                break
            if char == "\x03":  # Ctrl-C
                raise KeyboardInterrupt
            if char in _BACKSPACE_CHARS:
                if password_chars:
                    password_chars.pop()
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                continue
            password_chars.append(char)
            sys.stdout.write("*")
            sys.stdout.flush()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original_settings)
        sys.stdout.write("\n")
    return "".join(password_chars)


def _validate_password_strength(password: str) -> str | None:
    """Returns a human-readable reason `password` is too weak, or None if
    it's acceptable."""
    if len(password) < _MIN_PASSWORD_LENGTH:
        return f"password must be at least {_MIN_PASSWORD_LENGTH} characters"
    if not any(char.isalpha() for char in password):
        return "password must contain at least one letter"
    if not any(char.isdigit() for char in password):
        return "password must contain at least one digit"
    return None


def _prompt_for_new_user() -> tuple[str, str]:
    """Prompts for email, then password + confirmation (masked input via
    _read_masked_password, re-prompting on a weak password or a mismatched
    confirmation) until both are valid."""
    email = input("Email: ").strip()
    while True:
        password = _read_masked_password("Password: ")
        weakness = _validate_password_strength(password)
        if weakness is not None:
            print(f"error: {weakness}", file=sys.stderr)
            continue
        confirmation = _read_masked_password("Confirm password: ")
        if password != confirmation:
            print("error: passwords do not match", file=sys.stderr)
            continue
        return email, password


def _cmd_create_user(args: argparse.Namespace) -> int:
    email, password = _prompt_for_new_user()
    try:
        user_id = create_user(email, password)
    except IntegrityError:
        print(f"error: a user with email {email!r} already exists", file=sys.stderr)
        return 1
    print(f"created user {email} (id={user_id})")
    return 0


def _cmd_revoke_user(args: argparse.Namespace) -> int:
    try:
        message = revoke_user(args.email)
    except UserNotFoundError:
        print(f"error: no user with email {args.email!r}", file=sys.stderr)
        return 1
    print(message)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.auth.cli",
        description=(
            "Create or revoke admin-panel users. Closed off from any HTTP "
            "path on purpose - this script is the only way to do either."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_parser = subparsers.add_parser(
        "create-user", help="Create a new admin user (prompts for email/password in the terminal)"
    )
    create_parser.set_defaults(func=_cmd_create_user)

    revoke_parser = subparsers.add_parser(
        "revoke-user", help="Deactivate a user and kill their active sessions"
    )
    revoke_parser.add_argument("--email", required=True)
    revoke_parser.set_defaults(func=_cmd_revoke_user)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
