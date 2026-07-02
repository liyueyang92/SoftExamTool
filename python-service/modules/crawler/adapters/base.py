from abc import ABC, abstractmethod

from modules.crawler.schemas import CrawlRuleModel, RawItem, RuntimeContext


class CrawlerAdapterBase(ABC):
    @abstractmethod
    async def fetch(self, rule: CrawlRuleModel, context: RuntimeContext) -> list[RawItem]:
        raise NotImplementedError
