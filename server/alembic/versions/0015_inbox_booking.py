"""通知來源登記及不可重用的通知序號。"""
import time

import sqlalchemy as sa
from alembic import op

revision = "0015_inbox_booking"
down_revision = "0014_sync_rekey"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inbox_bookings",
        sa.Column("item_id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("shape", sa.String(2000), nullable=False),
    )
    op.create_index("ix_inbox_bookings_user_id", "inbox_bookings", ["user_id"])
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("inbox_items", recreate="always", table_kwargs={"sqlite_autoincrement": True}):
            pass
        # 舊版刪光通知後可能重用序號；新序號也須避開本機仍保留的歷史來源 ID。
        connection = op.get_bind()
        floor = time.time_ns() // 1_000_000
        current = connection.execute(sa.text("SELECT seq FROM sqlite_sequence WHERE name = 'inbox_items'")).scalar()
        if current is None:
            connection.execute(sa.text("INSERT INTO sqlite_sequence(name, seq) VALUES ('inbox_items', :seq)"), {"seq": floor})
        elif current < floor:
            connection.execute(sa.text("UPDATE sqlite_sequence SET seq = :seq WHERE name = 'inbox_items'"), {"seq": floor})


def downgrade() -> None:
    op.drop_table("inbox_bookings")
