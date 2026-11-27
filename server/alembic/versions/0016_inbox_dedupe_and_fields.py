"""收件匣去重鍵資料表及 InboxItem 幣別／來源事件 ID／事件時間欄位。"""
import sqlalchemy as sa
from alembic import op

revision = "0016_inbox_dedupe_and_fields"
down_revision = "0015_inbox_booking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inbox_items", sa.Column("currency", sa.String(16), nullable=True))
    op.add_column("inbox_items", sa.Column("source_event_id", sa.String(128), nullable=True))
    op.add_column("inbox_items", sa.Column("event_at", sa.String(64), nullable=True))
    op.create_index("ix_inbox_items_source_event_id", "inbox_items", ["source_event_id"])

    op.create_table(
        "inbox_dedupe_keys",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("dedupe_key", sa.String(160), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "dedupe_key", name="uq_inbox_dedupe_user_key"),
    )
    op.create_index("ix_inbox_dedupe_keys_user_id", "inbox_dedupe_keys", ["user_id"])
    op.create_index("ix_inbox_dedupe_keys_expires_at", "inbox_dedupe_keys", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_inbox_dedupe_keys_expires_at", table_name="inbox_dedupe_keys")
    op.drop_index("ix_inbox_dedupe_keys_user_id", table_name="inbox_dedupe_keys")
    op.drop_table("inbox_dedupe_keys")
    op.drop_index("ix_inbox_items_source_event_id", table_name="inbox_items")
    op.drop_column("inbox_items", "event_at")
    op.drop_column("inbox_items", "source_event_id")
    op.drop_column("inbox_items", "currency")
