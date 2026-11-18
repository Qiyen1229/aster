"""同步加密切換的暫存資料。"""
import sqlalchemy as sa
from alembic import op

revision = "0014_sync_rekey"
down_revision = "0013_totp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_rekeys",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("migration_id", sa.String(64), nullable=False),
        sa.Column("base_version", sa.Integer(), nullable=False),
        sa.Column("base_cursor", sa.BigInteger(), nullable=False),
        sa.Column("config", sa.Text(), nullable=False),
    )
    op.create_table(
        "sync_rekey_records",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("sync_rekeys.user_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("record_id", sa.Integer(), sa.ForeignKey("sync_records.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("payload", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sync_rekey_records")
    op.drop_table("sync_rekeys")
