from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, Settings, load_dotenv


async def run(settings: Settings) -> None:
    from aiogram.types import BotCommand

    from .telegram import make_bot
    from .texts import LANGS, plain

    url = f"{settings.public_url}/telegram/webhook"
    async with make_bot(settings) as bot:
        await bot.set_webhook(
            url=url,
            secret_token=settings.webhook_secret,
            allowed_updates=["message", "callback_query"],
            drop_pending_updates=True,
        )
        for lang in LANGS:
            commands = [BotCommand(command=c, description=plain(lang, f"cmd_{c}")) for c in ("id", "rename", "stop")]
            # en is also the default menu
            await bot.set_my_commands(commands, language_code=None if lang == "en" else lang)
        info = await bot.get_webhook_info()
    print(f"webhook: {info.url}")
    print(f"pending updates: {info.pending_update_count}")
    if info.last_error_message:
        print(f"last error: {info.last_error_message}")


def main() -> None:
    load_dotenv()
    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        sys.exit("; ".join(exc.problems))
    asyncio.run(run(settings))


if __name__ == "__main__":
    main()
