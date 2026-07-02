from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from modules.question_bank_models import NewQuestionGroupModel

CrawlerAdapter = Literal['http_rule', 'browser_rule', 'api_json', 'feed_import', 'manual_clip']
AuthMode = Literal['none', 'manual_session']


class LegacySelectorRule(BaseModel):
    site_name: str
    url_template: str = ''
    item_selector: str = ''
    question_field: str = ''
    options_field: Optional[str] = None
    answer_field: Optional[str] = None
    expl_field: Optional[str] = None
    max_pages: int = Field(default=5, ge=1, le=100)
    delay_ms: int = Field(default=1500, ge=0)


class CrawlRuleModel(LegacySelectorRule):
    adapter: CrawlerAdapter = 'http_rule'
    auth_required: bool | int = False
    auth_mode: AuthMode = 'none'
    login_url: Optional[str] = None
    validate_url: Optional[str] = None
    rule_json: dict[str, Any] | str | None = None
    version: int = 1

    @field_validator('rule_json', mode='before')
    @classmethod
    def parse_rule_json(cls, value):
        if value is None or value == '':
            return None
        if isinstance(value, str):
            import json
            return json.loads(value)
        return value

    def effective_rule_json(self) -> dict[str, Any]:
        if isinstance(self.rule_json, dict) and self.rule_json:
            return self.rule_json
        return {
            'list': {
                'url_template': self.url_template,
                'item_selector': self.item_selector,
                'fields': {
                    'content': self.question_field,
                    'options': self.options_field,
                    'answer': self.answer_field,
                    'explanation': self.expl_field,
                },
            },
            'pagination': {'type': 'page_param', 'max_pages': self.max_pages},
            'request': {'delay_ms': self.delay_ms},
        }


class RawItem(BaseModel):
    title: Optional[str] = None
    content: str
    content_type: str = 'question'
    question_type: Optional[Literal['single', 'multiple', 'case', 'essay']] = None
    options: list[str] | None = None
    answer: Optional[str] = None
    explanation: Optional[str] = None
    knowledge_tags: list[str] = Field(default_factory=list)
    source_url: Optional[str] = None
    source_site: Optional[str] = None
    canonical_url: Optional[str] = None
    raw: dict[str, Any] = Field(default_factory=dict)


class NormalizedItem(BaseModel):
    title: Optional[str] = None
    content: str
    content_type: str = 'question'
    type: Literal['single', 'multiple', 'case', 'essay'] = 'essay'
    options: list[str] | None = None
    answer: Optional[str] = None
    explanation: Optional[str] = None
    knowledge_tags: list[str] = Field(default_factory=list)
    source_url: Optional[str] = None
    source_site: Optional[str] = None
    content_hash: str
    raw: dict[str, Any] = Field(default_factory=dict)


class RuntimeContext(BaseModel):
    task_id: Optional[str] = None
    rule_id: Optional[str] = None
    account_alias: Optional[str] = None
    target_group_id: Optional[str] = None
    session_state: dict[str, Any] | None = None
    manual_input: dict[str, Any] | None = None


class TestCrawlRequest(BaseModel):
    rule: CrawlRuleModel
    test_url: Optional[str] = None
    account_alias: Optional[str] = None
    session_state: dict[str, Any] | None = None
    manual_input: dict[str, Any] | None = None


class RunCrawlRequest(BaseModel):
    rule: CrawlRuleModel
    task_id: str
    rule_id: str
    target_group_id: str | None = None
    new_group: NewQuestionGroupModel | None = None
    account_alias: Optional[str] = None
    session_state: dict[str, Any] | None = None
    manual_input: dict[str, Any] | None = None


class InspectLoadRequest(BaseModel):
    rule: CrawlRuleModel
    url: Optional[str] = None
    account_alias: Optional[str] = None
    session_state: dict[str, Any] | None = None


class InspectNode(BaseModel):
    path: str
    selector: str
    tag: str
    text: str = ''
    classes: list[str] = Field(default_factory=list)
    id: Optional[str] = None
    match_count: int = 0


class InspectLoadResponse(BaseModel):
    url: str
    adapter: CrawlerAdapter
    html: str
    title: str = ''
    nodes: list[InspectNode] = Field(default_factory=list)


class SuggestSelectorRequest(BaseModel):
    html: str
    path: Optional[str] = None
    selector: Optional[str] = None
    scope_selector: Optional[str] = None


class SelectorCandidate(BaseModel):
    selector: str
    match_count: int
    text_sample: str = ''
    stability: Literal['high', 'medium', 'low'] = 'medium'


class SuggestSelectorResponse(BaseModel):
    candidates: list[SelectorCandidate]


class InspectPreviewRequest(BaseModel):
    rule: CrawlRuleModel
    html: Optional[str] = None
    url: Optional[str] = None
    account_alias: Optional[str] = None
    session_state: dict[str, Any] | None = None


class InspectPreviewResponse(BaseModel):
    count: int
    samples: list[RawItem]
    selector_matches: dict[str, int] = Field(default_factory=dict)
