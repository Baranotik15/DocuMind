"""add analysis_reports table

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: Union[str, Sequence[str], None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "analysis_reports",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="running"),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_by_email", sa.Text(), nullable=False),
        # NULL until the run completes. Prose output of run_gap_analysis
        # (see Task 2).
        sa.Column("gap_analysis", sa.Text(), nullable=True),
        # NULL until the run completes. A JSON array of objects shaped like
        # AnalysisConflict (see Task 4's schemas) - one entry per detected
        # contradiction, empty array (not NULL) if the run completed and
        # found none.
        sa.Column("conflicts", postgresql.JSONB(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        # NULL unless status='failed'.
        sa.Column("error_detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("analysis_reports")
