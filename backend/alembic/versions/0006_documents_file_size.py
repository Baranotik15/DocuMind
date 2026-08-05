"""add documents.file_size_bytes

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-05

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable - any pre-existing row wouldn't have a value, but every row
    # created going forward (via app/documents/router.py's upload_document)
    # always sets it.
    op.add_column("documents", sa.Column("file_size_bytes", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("documents", "file_size_bytes")
