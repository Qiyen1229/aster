"""Email 自動轉寄綁定資料表（Cloudflare Email Routing Webhook）。"""
import sqlalchemy as sa
from alembic import op

revision = "0017_email_forward_binding"
down_revision = "0016_inbox_dedupe_and_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_forward_bindings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_email", sa.String(254), nullable=False),
        sa.Column("forward_token", sa.String(40), nullable=False),
        sa.Column("forward_address", sa.String(120), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="pending_verify"),
        sa.Column("verify_url", sa.String(1000), nullable=True),
        sa.Column("verify_code", sa.String(32), nullable=True),
        sa.Column("verify_received_at", sa.DateTime(), nullable=True),
        sa.Column("last_received_at", sa.DateTime(), nullable=True),
        sa.Column("received_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_email_forward_bindings_user_id", "email_forward_bindings", ["user_id"], unique=True)
    op.create_index("ix_email_forward_bindings_forward_token", "email_forward_bindings", ["forward_token"], unique=True)
    op.create_index("ix_email_forward_bindings_forward_address", "email_forward_bindings", ["forward_address"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_email_forward_bindings_forward_address", table_name="email_forward_bindings")
    op.drop_index("ix_email_forward_bindings_forward_token", table_name="email_forward_bindings")
    op.drop_index("ix_email_forward_bindings_user_id", table_name="email_forward_bindings")
    op.drop_table("email_forward_bindings")
