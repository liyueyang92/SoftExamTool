from modules.crawler.adapters.http_rule import HttpRuleAdapter


class BrowserRuleAdapter(HttpRuleAdapter):
    """Playwright-ready adapter placeholder.

    It currently falls back to the static HTTP implementation so browser_rule
    can be saved and exercised before Chromium is bundled into the desktop app.
    """
