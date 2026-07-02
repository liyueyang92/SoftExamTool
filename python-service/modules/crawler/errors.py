class CrawlerError(Exception):
    code = 'CRAWLER_ERROR'
    stage = 'unknown'

    def __init__(self, message: str, *, code: str | None = None, stage: str | None = None):
        super().__init__(message)
        self.code = code or self.code
        self.stage = stage or self.stage


class CrawlerFetchError(CrawlerError):
    code = 'CRAWLER_FETCH_FAILED'
    stage = 'fetch'


class CrawlerParseError(CrawlerError):
    code = 'CRAWLER_PARSE_FAILED'
    stage = 'parse'


class CrawlerNormalizeError(CrawlerError):
    code = 'CRAWLER_NORMALIZE_FAILED'
    stage = 'normalize'


class CrawlerAuthError(CrawlerError):
    code = 'CRAWLER_AUTH_REQUIRED'
    stage = 'auth'


class CrawlerUnsupportedAdapterError(CrawlerError):
    code = 'CRAWLER_UNSUPPORTED_ADAPTER'
    stage = 'dispatch'
