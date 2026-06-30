import os
import sys


def get_resource_path(relative_path: str) -> str:
    """Get absolute path to resource — works for dev and PyInstaller."""
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, relative_path)


class Settings:
    port: int = int(os.environ.get('INTERNAL_PORT', '8765'))
    internal_token: str = os.environ.get('INTERNAL_TOKEN', '')


settings = Settings()
